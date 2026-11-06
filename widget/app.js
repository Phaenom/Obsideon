// Scale the 2560×720 design to the actual viewport and fill it edge to edge.
// Uses CSS zoom rather than transform:scale to avoid compositing blur.
// Snaps to 1.0 when within 1% of native to prevent fractional-pixel blurriness.
// The root is then sized explicitly in pre-zoom pixels: vw/vh units no longer
// line up with the real viewport once zoom is applied, which otherwise leaves
// an unused strip on the right/bottom whenever the panel viewport isn't exactly
// 2560×720 (e.g. iCUE's padding around the widget).
(function fitToViewport() {
    function apply() {
        var z = Math.min(window.innerWidth / 2560, window.innerHeight / 720);
        if (z > 0.99 && z <= 1.0) z = 1.0;
        var root = document.documentElement.style;
        root.zoom = z;
        root.width = (window.innerWidth / z) + 'px';
        root.height = (window.innerHeight / z) + 'px';
    }
    // Poll alongside the resize event: embedded webviews (like iCUE's) may size
    // the window after load without dispatching resize.
    var lastW = 0, lastH = 0;
    function applyIfChanged() {
        if (window.innerWidth === lastW && window.innerHeight === lastH) return;
        lastW = window.innerWidth;
        lastH = window.innerHeight;
        apply();
    }
    window.addEventListener('resize', applyIfChanged);
    setInterval(applyIfChanged, 500);
    applyIfChanged();
})();

(() => {
    // ?bridge=http://127.0.0.1:8766 points a dev preview at a second bridge.
    const bridgeParam = new URLSearchParams(window.location.search).get('bridge');
    const API_BASE = window.OBSIDIAN_BRIDGE_URL || bridgeParam || 'http://127.0.0.1:8765';
    const POLL_MS = 15000;
    const SEP = ' › ';

    const rail = document.getElementById('section-rail');
    const emptyState = document.getElementById('empty-state');
    const errorState = document.getElementById('error-state');
    const errorMessage = document.getElementById('error-message');
    const countBadge = document.getElementById('count-badge');
    const noteTitle = document.getElementById('note-title');
    const updatedAt = document.getElementById('updated-at');
    const refreshBtn = document.getElementById('refresh-btn');
    const retryBtn = document.getElementById('retry-btn');
    const openNoteBtn = document.getElementById('open-note-btn');
    const addSectionBtn = document.getElementById('add-section-btn');
    const expandAllBtn = document.getElementById('expand-all-btn');
    const sectionTemplate = document.getElementById('section-template');
    const subgroupTemplate = document.getElementById('subgroup-template');
    const itemTemplate = document.getElementById('item-template');
    const hiddenGroupsBtn = document.getElementById('hidden-groups-btn');
    const hiddenGroupsCount = document.getElementById('hidden-groups-count');
    const hiddenGroupsMenu = document.getElementById('hidden-groups-menu');

    // Section modal
    const sectionModal = document.getElementById('section-modal');
    const sectionNameInput = document.getElementById('section-name-input');
    const sectionCancelBtn = document.getElementById('section-cancel-btn');
    const sectionSubmitBtn = document.getElementById('section-submit-btn');

    // Task modal
    const taskModal = document.getElementById('task-modal');
    const taskModalTitle = taskModal.querySelector('.modal-title');
    const taskModalSection = document.getElementById('task-modal-section');
    const taskTextInput = document.getElementById('task-text-input');
    const taskDateInput = document.getElementById('task-date-input');
    const taskCancelBtn = document.getElementById('task-cancel-btn');
    const taskSubmitBtn = document.getElementById('task-submit-btn');
    const taskSubactionBtn = document.getElementById('task-subaction-btn');
    const taskPriorityBtns = taskModal.querySelectorAll('.priority-btn-lg');

    let activeNoteUri = null;
    // { mode: 'add', target: {group, section} | {parentId} } or { mode: 'edit', item }
    let taskModalState = null;
    let taskSelectedPriority = 'normal';
    let lastData = null;

    // ---- persisted UI state ---------------------------------------------------
    // Keys are built from names/text rather than task ids: ids include the line number,
    // which shifts whenever the note is edited above the task.
    function storedSet(key) {
        let set;
        try { set = new Set(JSON.parse(localStorage.getItem(key)) || []); }
        catch (e) { set = new Set(); }
        set.save = function() {
            try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) { /* ignore */ }
        };
        // Drop entries no longer present in the note so storage doesn't accumulate.
        set.prune = function(live) {
            let changed = false;
            set.forEach(function(k) { if (!live.has(k)) { set.delete(k); changed = true; } });
            if (changed) set.save();
        };
        return set;
    }
    const hiddenGroups = storedSet('obsideon.collapsedSections');     // whole cards hidden to the eye menu
    const collapsedSubgroups = storedSet('obsideon.collapsedSubgroups');
    const expandedItems = storedSet('obsideon.expandedItems');         // parent actions opened up

    // ---- data helpers -------------------------------------------------------
    function countTasks(nodes) {
        let n = 0;
        for (const node of nodes) {
            if (node.type === 'task') n++;
            n += countTasks(node.children || []);
        }
        return n;
    }
    function groupOpenCount(group) {
        return countTasks(group.items) + group.subgroups.reduce((s, sg) => s + countTasks(sg.items), 0);
    }

    // Bridges older than the groups/subgroups format only send flat sections.
    function normalize(data) {
        if (data.groups) return data.groups;
        return (data.sections || []).map(function(s) {
            return {
                name: s.name, subgroups: [],
                items: s.items.map(function(it) { return Object.assign({ type: 'task', children: [] }, it); }),
            };
        });
    }

    // ---- inline markdown ----------------------------------------------------
    // Renders the subset of Obsidian markdown that shows up in task text, building DOM
    // nodes directly (never innerHTML) so note content can't inject markup.
    const INLINE_RE = /(`+)([^`]+?)\1|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\[\[([^\]]+?)\]\]|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*?)\*/g;

    function wikiLabel(inner) {
        const bar = inner.indexOf('|');
        if (bar !== -1) return inner.slice(bar + 1);
        return inner.split('#')[0].split('/').pop() || inner;
    }

    function renderInline(text, into) {
        // Own regex instance per call: bold/italic content recurses, and a shared global
        // regex would have its lastIndex reset under the outer loop.
        const re = new RegExp(INLINE_RE.source, 'g');
        let last = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            if (m.index > last) into.appendChild(document.createTextNode(text.slice(last, m.index)));
            let el;
            if (m[2] !== undefined) { el = document.createElement('code'); el.textContent = m[2]; }
            else if (m[3] !== undefined || m[4] !== undefined) { el = document.createElement('strong'); renderInline(m[3] || m[4], el); }
            else if (m[5] !== undefined) { el = document.createElement('s'); renderInline(m[5], el); }
            else if (m[6] !== undefined) { el = document.createElement('span'); el.className = 'wikilink'; el.textContent = wikiLabel(m[6]); }
            else if (m[7] !== undefined) { el = document.createElement('span'); el.className = 'wikilink'; renderInline(m[7], el); }
            else { el = document.createElement('em'); renderInline(m[9], el); }
            into.appendChild(el);
            last = re.lastIndex;
        }
        if (last < text.length) into.appendChild(document.createTextNode(text.slice(last)));
        return into;
    }

    function plainText(text) {
        return renderInline(text, document.createElement('span')).textContent;
    }

    // ---- hidden (whole-card) groups -----------------------------------------
    function hiddenOpenCount() {
        if (!lastData) return 0;
        return normalize(lastData).reduce(function(sum, g) {
            return hiddenGroups.has(g.name) ? sum + groupOpenCount(g) : sum;
        }, 0);
    }

    function rerender() { if (lastData) renderSections(lastData); }

    function hideGroup(name) { hiddenGroups.add(name); hiddenGroups.save(); rerender(); }
    function showGroup(name) { hiddenGroups.delete(name); hiddenGroups.save(); rerender(); }

    function closeHiddenMenu() { hiddenGroupsMenu.classList.add('hidden'); }

    hiddenGroupsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hiddenGroupsMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!hiddenGroupsMenu.classList.contains('hidden') && !hiddenGroupsMenu.contains(e.target) && !hiddenGroupsBtn.contains(e.target)) {
            closeHiddenMenu();
        }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHiddenMenu(); });

    function renderHiddenMenu(groups) {
        hiddenGroupsMenu.innerHTML = '';
        for (const group of groups) {
            const item = document.createElement('button');
            item.className = 'dropdown-item';
            item.innerHTML = `<span class="dropdown-item-name"></span><span class="dropdown-item-count"></span>`;
            renderInline(group.name, item.querySelector('.dropdown-item-name'));
            item.querySelector('.dropdown-item-count').textContent = String(groupOpenCount(group));
            item.addEventListener('click', () => { showGroup(group.name); closeHiddenMenu(); });
            hiddenGroupsMenu.appendChild(item);
        }
        hiddenGroupsCount.textContent = String(groups.length);
        hiddenGroupsBtn.classList.toggle('hidden', groups.length === 0);
        if (groups.length === 0) closeHiddenMenu();
    }

    // ---- task modal -----------------------------------------------------------
    taskPriorityBtns.forEach(btn => {
        btn.addEventListener('click', () => selectPriority(btn.dataset.priority));
    });

    function selectPriority(p) {
        taskSelectedPriority = p;
        taskPriorityBtns.forEach(b => b.classList.toggle('selected', b.dataset.priority === p));
    }

    function closeTaskModal() {
        taskModal.classList.add('hidden');
        taskModalState = null;
    }

    function showTaskModal(state, title, label, submitText) {
        taskModalState = state;
        taskModalTitle.textContent = title;
        taskModalSection.textContent = label ? `— ${label}` : '';
        taskSubmitBtn.textContent = submitText;
        taskSubactionBtn.classList.toggle('hidden', state.mode !== 'edit');
        taskModal.classList.remove('hidden');
        taskTextInput.focus();
    }

    // target: { group, section } for a new top-level action, or { parentId } for a sub-action.
    function openTaskModal(target, label) {
        taskTextInput.value = '';
        taskDateInput.value = '';
        selectPriority('normal');
        showTaskModal({ mode: 'add', target }, target.parentId ? 'New Sub-action' : 'New Task', label, 'Add Task');
    }

    function openTaskEditModal(item, label) {
        taskTextInput.value = item.text;
        taskDateInput.value = item.due || '';
        selectPriority(item.priority || 'normal');
        showTaskModal({ mode: 'edit', item }, 'Edit Task', label, 'Save');
        taskTextInput.select();
    }

    taskSubactionBtn.addEventListener('click', () => {
        if (!taskModalState || taskModalState.mode !== 'edit') return;
        const item = taskModalState.item;
        openTaskModal({ parentId: item.id }, `under: ${plainText(item.text)}`);
    });

    taskCancelBtn.addEventListener('click', closeTaskModal);
    taskModal.addEventListener('click', e => { if (e.target === taskModal) closeTaskModal(); });
    taskTextInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') closeTaskModal();
        if (e.key === 'Enter') taskSubmitBtn.click();
    });
    taskSubmitBtn.addEventListener('click', async () => {
        const text = taskTextInput.value.trim();
        const state = taskModalState;
        if (!text || !state) return;
        taskSubmitBtn.disabled = true;
        const due = taskDateInput.value || null;
        const priority = taskSelectedPriority === 'normal' ? null : taskSelectedPriority;
        if (state.mode === 'edit') {
            await updateTask(state.item.id, text, due, priority);
        } else {
            await addTask(Object.assign({ text, due, priority }, state.target));
        }
        taskSubmitBtn.disabled = false;
        closeTaskModal();
    });

    // ---- helpers ------------------------------------------------------------
    function setPanel(panel) {
        rail.classList.toggle('hidden', panel !== 'rail');
        emptyState.classList.toggle('hidden', panel !== 'empty');
        errorState.classList.toggle('hidden', panel !== 'error');
    }

    function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

    // ---- sorting ------------------------------------------------------------
    const PRIORITY_ORDER = { highest: 0, high: 1, medium: 2, normal: 3, low: 4, lowest: 5 };
    const FAR_FUTURE = '9999-99-99';

    // Only top-level actions are sorted; sub-actions and notes keep the note's order
    // under their parent.
    function sortItems(items) {
        return [...items].sort(function(a, b) {
            var da = a.due || FAR_FUTURE;
            var db = b.due || FAR_FUTURE;
            if (da !== db) return da < db ? -1 : 1;
            var pa = PRIORITY_ORDER[a.priority] !== undefined ? PRIORITY_ORDER[a.priority] : 3;
            var pb = PRIORITY_ORDER[b.priority] !== undefined ? PRIORITY_ORDER[b.priority] : 3;
            return pa - pb;
        });
    }

    // ---- tree rendering -----------------------------------------------------
    // ctx: { label: "Group › Subgroup", liveItems: Set of expandable keys seen this render }
    function buildNode(node, parentKey, ctx, depth) {
        return node.type === 'task' ? buildTask(node, parentKey, ctx, depth) : buildNote(node, parentKey, ctx, depth);
    }

    function buildChildren(children, key, ctx, depth) {
        const box = document.createElement('div');
        box.className = 'children';
        for (const child of children) box.appendChild(buildNode(child, key, ctx, depth + 1));
        return box;
    }

    function setExpanded(taskEl, key, open) {
        taskEl.classList.toggle('expanded', open);
        if (open) expandedItems.add(key); else expandedItems.delete(key);
        expandedItems.save();
    }

    function buildTask(item, parentKey, ctx, depth) {
        const key = parentKey + SEP + item.text;
        const wrap = document.createElement('div');
        wrap.className = 'task' + (depth > 0 ? ' sub' : '');
        wrap.dataset.id = item.id;
        wrap.dataset.key = key;

        const row = itemTemplate.content.firstElementChild.cloneNode(true);
        if (item.priority) row.classList.add(`pri-${item.priority}`);
        wrap.appendChild(row);

        renderInline(item.text, row.querySelector('.item-text'));
        row.querySelector('.item-text').addEventListener('click', () => openTaskEditModal(item, ctx.label));

        const pill = row.querySelector('.due-pill');
        if (item.due) {
            pill.textContent = item.due;
            pill.classList.remove('hidden');
            if (item.due < todayStr()) pill.classList.add('overdue');
        }
        if (item.due || (item.children && item.children.length)) {
            row.querySelector('.item-meta').classList.remove('hidden');
        }

        const checkBtn = row.querySelector('.check-btn');
        checkBtn.addEventListener('click', () => closeOut(item.id, wrap, checkBtn));

        const children = item.children || [];
        if (children.length) {
            ctx.liveItems.add(key);
            wrap.classList.add('has-children');
            const notes = children.filter(c => c.type === 'note').length;
            wrap.dataset.notes = String(notes);
            const summary = row.querySelector('.item-summary');
            summary.classList.remove('hidden');
            const expandBtn = row.querySelector('.expand-btn');
            expandBtn.classList.remove('hidden');
            const toggle = () => setExpanded(wrap, key, !wrap.classList.contains('expanded'));
            summary.addEventListener('click', toggle);
            expandBtn.addEventListener('click', toggle);
            wrap.appendChild(buildChildren(children, key, ctx, depth));
            if (expandedItems.has(key)) wrap.classList.add('expanded');
            updateSummary(wrap);
        }
        return wrap;
    }

    function buildNote(note, parentKey, ctx, depth) {
        const el = document.createElement('div');
        el.className = 'note';
        const line = document.createElement('div');
        line.className = 'note-text';
        renderInline(note.text, line);
        el.appendChild(line);
        if (note.children && note.children.length) {
            el.appendChild(buildChildren(note.children, parentKey + SEP + note.text, ctx, depth));
        }
        return el;
    }

    function liveTasks(scope) {
        return [...scope.querySelectorAll('.task')].filter(t => !t.closest('.task.closing'));
    }

    function updateSummary(taskEl) {
        const subs = liveTasks(taskEl.querySelector(':scope > .children')).length;
        const notes = Number(taskEl.dataset.notes || 0);
        const parts = [];
        if (subs) parts.push(plural(subs, 'sub-action'));
        if (notes) parts.push(plural(notes, 'note'));
        taskEl.querySelector(':scope > .item .item-summary').textContent = parts.join(' · ') || 'details';
    }

    function buildItemList(items, key, ctx) {
        const list = document.createElement('div');
        list.className = 'item-group';
        for (const item of sortItems(items)) list.appendChild(buildNode(item, key, ctx, 0));
        return list;
    }

    function buildSubgroup(group, sub, ctx) {
        const key = group.name + SEP + sub.name;
        const el = subgroupTemplate.content.firstElementChild.cloneNode(true);
        renderInline(sub.name, el.querySelector('.subgroup-name'));
        el.querySelector('.subgroup-count').textContent = String(countTasks(sub.items));
        if (collapsedSubgroups.has(key)) el.classList.add('collapsed');
        el.querySelector('.subgroup-toggle').addEventListener('click', () => {
            const collapsed = !el.classList.contains('collapsed');
            el.classList.toggle('collapsed', collapsed);
            if (collapsed) collapsedSubgroups.add(key); else collapsedSubgroups.delete(key);
            collapsedSubgroups.save();
        });
        el.querySelector('.add-task-btn').addEventListener('click', () =>
            openTaskModal({ group: group.name, section: sub.name }, plainText(group.name) + SEP + plainText(sub.name)));
        const subCtx = Object.assign({}, ctx, { label: plainText(group.name) + SEP + plainText(sub.name) });
        el.appendChild(buildItemList(sub.items, key, subCtx));
        return el;
    }

    function buildCard(group, ctx) {
        const card = sectionTemplate.content.firstElementChild.cloneNode(true);
        card.dataset.group = group.name;
        renderInline(group.name, card.querySelector('.section-name'));
        const open = groupOpenCount(group);
        card.querySelector('.section-count').textContent = String(open);
        const body = card.querySelector('.item-list');

        const groupCtx = Object.assign({}, ctx, { label: plainText(group.name) });
        if (group.items.length) body.appendChild(buildItemList(group.items, group.name, groupCtx));
        for (const sub of group.subgroups) {
            ctx.liveSubgroups.add(group.name + SEP + sub.name);
            if (countTasks(sub.items) === 0) continue; // empty subgroups (e.g. "Closed") are noise
            body.appendChild(buildSubgroup(group, sub, ctx));
        }
        // Small flat groups (a few items, no sub-actions or notes) don't need a full-width card.
        if (open > 0 && open <= 3 && !body.querySelector('.task.has-children')) card.classList.add('compact');
        if (open === 0) {
            card.classList.add('empty');
            const hint = document.createElement('div');
            hint.className = 'empty-hint';
            hint.textContent = 'No open items';
            body.appendChild(hint);
        }

        card.querySelector('.add-task-btn').addEventListener('click', () =>
            openTaskModal({ group: group.name }, plainText(group.name)));
        card.querySelector('.collapse-btn').addEventListener('click', () => hideGroup(group.name));
        return card;
    }

    function renderSections(data) {
        // Save scroll positions before wiping the DOM
        var savedRailScroll = rail.scrollLeft;
        var savedListScrolls = {};
        rail.querySelectorAll('.card').forEach(function(card) {
            var listEl = card.querySelector('.item-list');
            if (listEl) savedListScrolls[card.dataset.group] = listEl.scrollTop;
        });

        rail.innerHTML = '';
        noteTitle.textContent = data.title || '';
        countBadge.textContent = String(data.openCount || 0);
        activeNoteUri = data.obsidianUri || null;
        openNoteBtn.style.opacity = activeNoteUri ? '1' : '0.3';

        var groups = normalize(data);

        // Only reached on a successful fetch, so transient errors never wipe state.
        hiddenGroups.prune(new Set(groups.map(function(g) { return g.name; })));

        var visible = groups.filter(function(g) { return !hiddenGroups.has(g.name); });
        var hidden = groups.filter(function(g) { return hiddenGroups.has(g.name); });
        renderHiddenMenu(hidden);

        if (groups.length === 0) { setPanel('empty'); return; }
        setPanel('rail');

        // Groups with open items first (note order), then empty ones as slim cards at the end.
        visible.sort(function(a, b) { return (groupOpenCount(a) === 0) - (groupOpenCount(b) === 0); });

        var ctx = { liveItems: new Set(), liveSubgroups: new Set() };
        for (var i = 0; i < visible.length; i++) rail.appendChild(buildCard(visible[i], ctx));
        if (visible.length === 0) {
            var hint = document.createElement('div');
            hint.className = 'all-hidden-hint';
            hint.textContent = 'All sections hidden — restore them from the eye button above.';
            rail.appendChild(hint);
        }
        // Hidden cards weren't built, so keep their state rather than pruning it.
        if (hidden.length === 0) {
            expandedItems.prune(ctx.liveItems);
            collapsedSubgroups.prune(ctx.liveSubgroups);
        }
        updateExpandAllBtn();

        // Restore scroll positions
        rail.scrollLeft = savedRailScroll;
        rail.querySelectorAll('.card').forEach(function(card) {
            var listEl = card.querySelector('.item-list');
            if (listEl && savedListScrolls[card.dataset.group] !== undefined) {
                listEl.scrollTop = savedListScrolls[card.dataset.group];
            }
        });
    }

    function recount() {
        let total = 0;
        for (const card of rail.querySelectorAll('.card')) {
            const open = liveTasks(card).length;
            card.querySelector('.section-count').textContent = String(open);
            for (const sub of card.querySelectorAll('.subgroup')) {
                sub.querySelector('.subgroup-count').textContent = String(liveTasks(sub).length);
            }
            for (const t of card.querySelectorAll('.task.has-children')) updateSummary(t);
            total += open;
        }
        total += hiddenOpenCount();
        countBadge.textContent = String(total);
        if (total === 0 && rail.querySelectorAll('.card').length === 0) setPanel('empty');
    }

    // ---- expand / collapse all ----------------------------------------------
    function updateExpandAllBtn() {
        const parents = rail.querySelectorAll('.task.has-children');
        const anyCollapsed = [...parents].some(t => !t.classList.contains('expanded'));
        expandAllBtn.classList.toggle('hidden', parents.length === 0);
        expandAllBtn.classList.toggle('all-open', !anyCollapsed);
        expandAllBtn.title = anyCollapsed ? 'Expand all actions' : 'Collapse all actions';
    }
    expandAllBtn.addEventListener('click', () => {
        const parents = [...rail.querySelectorAll('.task.has-children')];
        const open = parents.some(t => !t.classList.contains('expanded'));
        parents.forEach(t => setExpanded(t, t.dataset.key, open));
        updateExpandAllBtn();
    });
    rail.addEventListener('click', (e) => {
        if (e.target.closest('.expand-btn, .item-summary')) updateExpandAllBtn();
    });

    // ---- API calls ----------------------------------------------------------
    async function postJson(path, body) {
        const res = await fetch(`${API_BASE}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
        return res;
    }

    async function closeOut(id, taskEl, checkBtn) {
        checkBtn.disabled = true;
        taskEl.classList.add('closing');
        try {
            await postJson('/api/tasks/toggle', { id, done: true });
            setTimeout(() => { taskEl.remove(); recount(); updateExpandAllBtn(); }, 300);
        } catch (err) {
            taskEl.classList.remove('closing');
            checkBtn.disabled = false;
            checkBtn.classList.add('failed');
            setTimeout(() => checkBtn.classList.remove('failed'), 2500);
            console.error('Failed to close out task', err);
        }
    }

    async function updateTask(id, text, due, priority) {
        try {
            await postJson('/api/tasks/update', { id, text, due, priority });
            await refresh();
        } catch (err) {
            console.error('Failed to update task', err);
        }
    }

    async function addTask(body) {
        try {
            await postJson('/api/tasks/add', body);
            await refresh();
        } catch (err) {
            console.error('Failed to add task', err);
        }
    }

    async function addSection(name) {
        try {
            await postJson('/api/sections/add', { name });
            await refresh();
        } catch (err) {
            console.error('Failed to add section', err);
        }
    }

    function stampUpdated() {
        updatedAt.textContent = new Date().toLocaleTimeString([], { hour12: false });
    }

    let refreshInFlight = false;

    async function refresh() {
        if (refreshInFlight) return; // a slow fetch must not stack polls behind it
        refreshInFlight = true;
        refreshBtn.classList.add('spinning');
        try {
            const res = await fetch(`${API_BASE}/api/tasks`);
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            lastData = data;
            renderSections(data);
            stampUpdated();
        } catch (err) {
            errorMessage.textContent = (err.message && err.message.startsWith('Could not load'))
                ? err.message
                : "Can't reach the bridge server.";
            setPanel('error');
            console.error('Failed to load action items', err);
        } finally {
            refreshInFlight = false;
            refreshBtn.classList.remove('spinning');
        }
    }

    // ---- section modal ------------------------------------------------------
    addSectionBtn.addEventListener('click', () => {
        sectionNameInput.value = '';
        sectionModal.classList.remove('hidden');
        sectionNameInput.focus();
    });
    sectionCancelBtn.addEventListener('click', () => sectionModal.classList.add('hidden'));
    sectionModal.addEventListener('click', e => { if (e.target === sectionModal) sectionModal.classList.add('hidden'); });
    sectionNameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') sectionSubmitBtn.click();
        if (e.key === 'Escape') sectionCancelBtn.click();
    });
    sectionSubmitBtn.addEventListener('click', async () => {
        const name = sectionNameInput.value.trim();
        if (!name) return;
        sectionSubmitBtn.disabled = true;
        sectionModal.classList.add('hidden');
        await addSection(name);
        sectionSubmitBtn.disabled = false;
    });

    // ---- other buttons ------------------------------------------------------
    openNoteBtn.addEventListener('click', () => { if (activeNoteUri) window.location.href = activeNoteUri; });
    refreshBtn.addEventListener('click', refresh);
    retryBtn.addEventListener('click', refresh);

    window.__onICUEReady = refresh;
    refresh();
    setInterval(refresh, POLL_MS);
})();
