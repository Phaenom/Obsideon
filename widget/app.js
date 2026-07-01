// Zoom the fixed 2560×720 layout to fit the actual viewport.
// Uses CSS zoom rather than transform:scale to avoid compositing blur.
// Snaps to 1.0 when within 1% of native to prevent fractional-pixel blurriness.
(function fitToViewport() {
    function apply() {
        var z = Math.min(window.innerWidth / 2560, window.innerHeight / 720);
        if (z > 0.99 && z <= 1.0) z = 1.0;
        document.documentElement.style.zoom = z;
    }
    window.addEventListener('resize', apply);
    apply();
})();

(() => {
    const API_BASE = window.OBSIDIAN_BRIDGE_URL || 'http://127.0.0.1:8765';
    const POLL_MS = 15000;

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
    const sectionTemplate = document.getElementById('section-template');
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
    const taskPriorityBtns = taskModal.querySelectorAll('.priority-btn-lg');

    let activeNoteUri = null;
    let taskModalMode = 'add'; // 'add' | 'edit'
    let taskModalSectionName = null;
    let taskEditId = null;
    let taskSelectedPriority = 'normal';
    let lastData = null;

    // ---- collapsed (hidden) sections ----------------------------------------
    const COLLAPSED_KEY = 'obsideon.collapsedSections';
    function loadCollapsed() {
        try { return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []); }
        catch (e) { return new Set(); }
    }
    function saveCollapsed() {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedSections]));
    }
    const collapsedSections = loadCollapsed();

    function hideSection(name) {
        collapsedSections.add(name);
        saveCollapsed();
        if (lastData) renderSections(lastData);
    }

    function showSection(name) {
        collapsedSections.delete(name);
        saveCollapsed();
        if (lastData) renderSections(lastData);
    }

    function closeHiddenMenu() {
        hiddenGroupsMenu.classList.add('hidden');
    }

    hiddenGroupsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hiddenGroupsMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
        if (!hiddenGroupsMenu.classList.contains('hidden') && !hiddenGroupsMenu.contains(e.target) && e.target !== hiddenGroupsBtn) {
            closeHiddenMenu();
        }
    });

    function renderHiddenMenu(hiddenSections) {
        hiddenGroupsMenu.innerHTML = '';
        for (const section of hiddenSections) {
            const item = document.createElement('button');
            item.className = 'dropdown-item';
            item.innerHTML = `<span class="dropdown-item-name"></span><span class="dropdown-item-count"></span>`;
            item.querySelector('.dropdown-item-name').textContent = section.name;
            item.querySelector('.dropdown-item-count').textContent = String(section.items.length);
            item.addEventListener('click', () => { showSection(section.name); closeHiddenMenu(); });
            hiddenGroupsMenu.appendChild(item);
        }
        hiddenGroupsCount.textContent = String(hiddenSections.length);
        hiddenGroupsBtn.classList.toggle('hidden', hiddenSections.length === 0);
        if (hiddenSections.length === 0) closeHiddenMenu();
    }

    // ---- priority picker wiring (task modal) --------------------------------
    taskPriorityBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            taskPriorityBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            taskSelectedPriority = btn.dataset.priority;
        });
    });

    function resetTaskModal() {
        taskTextInput.value = '';
        taskDateInput.value = '';
        taskSelectedPriority = 'normal';
        taskPriorityBtns.forEach(b => b.classList.remove('selected'));
        taskModal.querySelector('.priority-btn-lg[data-priority="normal"]').classList.add('selected');
        taskSubmitBtn.textContent = 'Add Task';
        taskModal.classList.add('hidden');
        taskModalMode = 'add';
        taskEditId = null;
    }

    function openTaskModal(sectionName) {
        taskModalMode = 'add';
        taskEditId = null;
        taskModalTitle.textContent = 'New Task';
        taskModalSectionName = sectionName;
        taskModalSection.textContent = `— ${sectionName}`;
        taskSubmitBtn.textContent = 'Add Task';
        resetTaskModal();
        taskModal.classList.remove('hidden');
        taskTextInput.focus();
    }

    function openTaskEditModal(item) {
        taskModalMode = 'edit';
        taskEditId = item.id;
        taskModalTitle.textContent = 'Edit Task';
        taskModalSection.textContent = '';
        taskSubmitBtn.textContent = 'Save';
        taskTextInput.value = item.text;
        taskDateInput.value = item.due || '';
        taskSelectedPriority = item.priority || 'normal';
        taskPriorityBtns.forEach(b => b.classList.toggle('selected', b.dataset.priority === taskSelectedPriority));
        taskModal.classList.remove('hidden');
        taskTextInput.focus();
        taskTextInput.select();
    }

    taskCancelBtn.addEventListener('click', resetTaskModal);
    taskModal.addEventListener('click', e => { if (e.target === taskModal) resetTaskModal(); });
    taskTextInput.addEventListener('keydown', e => {
        if (e.key === 'Escape') resetTaskModal();
        if (e.key === 'Enter') taskSubmitBtn.click();
    });
    taskSubmitBtn.addEventListener('click', async () => {
        const text = taskTextInput.value.trim();
        if (!text) return;
        taskSubmitBtn.disabled = true;
        const due = taskDateInput.value || null;
        const priority = taskSelectedPriority === 'normal' ? null : taskSelectedPriority;
        if (taskModalMode === 'edit') {
            await updateTask(taskEditId, text, due, priority);
        } else {
            if (!taskModalSectionName) { taskSubmitBtn.disabled = false; return; }
            await addTask(taskModalSectionName, text, due, priority);
        }
        taskSubmitBtn.disabled = false;
        resetTaskModal();
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

    // ---- sorting ------------------------------------------------------------
    const PRIORITY_ORDER = { highest: 0, high: 1, medium: 2, normal: 3, low: 4, lowest: 5 };
    const FAR_FUTURE = '9999-99-99';

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

    // ---- item & card rendering ----------------------------------------------
    // Nested items don't get visually indented (sorting by due date/priority
    // can separate a child from its parent), so their full ancestor chain is
    // concatenated into the label instead, e.g. "Landing Gear - Installed".
    function withAncestorPaths(items) {
        const stack = [];
        return items.map(function(item) {
            while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
            const path = stack.map(function(a) { return a.text; }).concat([item.text]);
            stack.push({ level: item.level, text: item.text });
            return Object.assign({}, item, { pathText: path.join(' - ') });
        });
    }

    function buildItem(item) {
        const node = itemTemplate.content.firstElementChild.cloneNode(true);
        if (item.priority) node.classList.add(`pri-${item.priority}`);
        node.dataset.id = item.id;
        node.querySelector('.item-text').textContent = item.pathText || item.text;

        const pill = node.querySelector('.due-pill');
        if (item.due) {
            pill.textContent = item.due;
            pill.classList.remove('hidden');
            if (item.due < todayStr()) pill.classList.add('overdue');
        }

        const checkBtn = node.querySelector('.check-btn');
        checkBtn.addEventListener('click', () => closeOut(item.id, node, checkBtn));

        node.querySelector('.item-text').addEventListener('click', () => openTaskEditModal(item));
        return node;
    }

    function buildCard(section) {
        const card = sectionTemplate.content.firstElementChild.cloneNode(true);
        card.querySelector('.section-name').textContent = section.name;
        card.querySelector('.section-count').textContent = String(section.items.length);
        const list = card.querySelector('.item-list');
        for (const item of sortItems(withAncestorPaths(section.items))) list.appendChild(buildItem(item));

        card.querySelector('.add-task-btn').addEventListener('click', () => openTaskModal(section.name));
        card.querySelector('.collapse-btn').addEventListener('click', () => hideSection(section.name));
        return card;
    }

    function renderSections(data) {
        // Save scroll positions before wiping the DOM
        var savedRailScroll = rail.scrollLeft;
        var savedListScrolls = {};
        rail.querySelectorAll('.card').forEach(function(card) {
            var nameEl = card.querySelector('.section-name');
            var listEl = card.querySelector('.item-list');
            if (nameEl && listEl) savedListScrolls[nameEl.textContent] = listEl.scrollTop;
        });

        rail.innerHTML = '';
        noteTitle.textContent = data.title || '';
        countBadge.textContent = String(data.openCount || 0);
        activeNoteUri = data.obsidianUri || null;
        openNoteBtn.style.opacity = activeNoteUri ? '1' : '0.3';

        var sections = data.sections || [];
        var visibleSections = sections.filter(function(s) { return !collapsedSections.has(s.name); });
        var hiddenSections = sections.filter(function(s) { return collapsedSections.has(s.name); });
        renderHiddenMenu(hiddenSections);

        if (sections.length === 0) { setPanel('empty'); return; }
        setPanel('rail');
        for (var i = 0; i < visibleSections.length; i++) rail.appendChild(buildCard(visibleSections[i]));

        // Restore scroll positions
        rail.scrollLeft = savedRailScroll;
        rail.querySelectorAll('.card').forEach(function(card) {
            var nameEl = card.querySelector('.section-name');
            var listEl = card.querySelector('.item-list');
            if (nameEl && listEl && savedListScrolls[nameEl.textContent] !== undefined) {
                listEl.scrollTop = savedListScrolls[nameEl.textContent];
            }
        });
    }

    function recount() {
        let total = 0;
        for (const card of rail.querySelectorAll('.card')) {
            const open = card.querySelectorAll('.item:not(.closing)').length;
            card.querySelector('.section-count').textContent = String(open);
            total += open;
        }
        countBadge.textContent = String(total);
        if (total === 0 && rail.querySelectorAll('.card').length === 0) setPanel('empty');
    }

    // ---- API calls ----------------------------------------------------------
    async function closeOut(id, itemNode, checkBtn) {
        checkBtn.disabled = true;
        itemNode.classList.add('closing');
        try {
            const res = await fetch(`${API_BASE}/api/tasks/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, done: true }),
            });
            if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
            setTimeout(() => { itemNode.remove(); recount(); }, 300);
        } catch (err) {
            itemNode.classList.remove('closing');
            checkBtn.disabled = false;
            checkBtn.classList.add('failed');
            setTimeout(() => checkBtn.classList.remove('failed'), 2500);
            console.error('Failed to close out task', err);
        }
    }

    async function updateTask(id, text, due, priority) {
        try {
            const res = await fetch(`${API_BASE}/api/tasks/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, text, due, priority }),
            });
            if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
            await refresh();
        } catch (err) {
            console.error('Failed to update task', err);
        }
    }

    async function addTask(section, text, due, priority) {
        try {
            const res = await fetch(`${API_BASE}/api/tasks/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ section, text, due, priority }),
            });
            if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
            await refresh();
        } catch (err) {
            console.error('Failed to add task', err);
        }
    }

    async function addSection(name) {
        try {
            const res = await fetch(`${API_BASE}/api/sections/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
            await refresh();
        } catch (err) {
            console.error('Failed to add section', err);
        }
    }

    function stampUpdated() {
        updatedAt.textContent = new Date().toLocaleTimeString([], { hour12: false });
    }

    async function refresh() {
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
