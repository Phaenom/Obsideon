# Obsideon — XENEON EDGE Widget

A CORSAIR XENEON EDGE widget that shows the open action items from your current Obsidian **Action Items** note, grouped by section. Tap to check off tasks, add new ones, edit them in place, and jump directly to the note in Obsidian.

Because the XENEON EDGE widget sandbox has no filesystem access, this project has three pieces:

```
Obsidian (Local REST API plugin)  ←→  bridge/server.js  ←→  widget (in iCUE)
   serves/edits your vault notes        localhost relay          touch UI
```

The bridge is a single **Node.js** script with zero npm dependencies — built-ins only. Runs on Windows, macOS, or Linux.

---

## Prerequisites

| Requirement | Version / Notes |
|---|---|
| [CORSAIR XENEON EDGE](https://www.corsair.com/xeneon-edge) | The 14.5" touchscreen display |
| [iCUE](https://www.corsair.com/icue) | 5.44 or newer, with the XENEON EDGE connected |
| [Obsidian](https://obsidian.md) | Any current version |
| **Local REST API** Obsidian plugin | Community plugin by *coddingtonbear* |
| [Node.js](https://nodejs.org) | v18 or newer (`node --version` to check) |

---

## Note format

The widget reads one note at a time: the **newest** file in a folder you specify whose name starts with a prefix you specify. A typical setup uses dated weekly notes:

```
Inbox/
  Action Items - 20260101.md
  Action Items - 20260108.md   ← newest, this is what the widget shows
```

Inside that note, organize tasks under `## Section` headings using standard Obsidian checkboxes:

```markdown
## Work

- [ ] Write Q1 report 📅 2026-01-10 ⏫
- [ ] Review pull requests
    - [ ] Auth service PR
    - [ ] Dashboard PR

## Personal

- [ ] Book dentist appointment
- [x] Buy groceries           ← already checked — hidden from the widget
```

**Nesting** (up to 4 levels) is shown with visual indentation. **Completed items** (`- [x]`) are never surfaced. The widget understands [Obsidian Tasks](https://publish.obsidian.md/tasks) plugin emoji metadata:

| Emoji | Meaning |
|---|---|
| `📅 YYYY-MM-DD` | Due date — shown as a pill, highlighted red if overdue |
| `🔺` | Highest priority |
| `⏫` | High priority |
| `🔼` | Medium priority |
| `🔽` | Low priority |
| `⏬` | Lowest priority |

Priority appears as a colored left border on the task. Tasks within each section sort by due date (overdue first, then soonest, then undated), with priority as a tiebreaker.

---

## Setup

### 1. Install and configure the Obsidian plugin

1. In Obsidian, go to **Settings → Community plugins → Browse**, search for **Local REST API** (by coddingtonbear), and install and enable it.
2. Open the plugin's settings:
   - Copy the **API Key** — you'll need it in the next step.
   - Note the port. The plugin runs an HTTPS server on **`27124`** by default. It also offers a plain HTTP server on `27123` (enable **"Non-encrypted HTTP Server"** in its settings) which avoids dealing with its self-signed certificate.

### 2. Download or clone this repo

```bash
git clone https://github.com/your-username/xeneon-obsidian-action-items.git
cd xeneon-obsidian-action-items
```

### 3. Configure the bridge

Copy the example config and fill it in:

```bash
cp bridge/config.example.json bridge/config.json
```

Edit `bridge/config.json`:

```jsonc
{
  "obsidianBaseUrl": "https://127.0.0.1:27124",
  // Use "http://127.0.0.1:27123" if you enabled the plain HTTP server

  "obsidianApiKey": "YOUR-API-KEY-HERE",
  // Paste the key from Obsidian → Settings → Local REST API
  // Paste the key exactly as shown — do NOT include the "Bearer " prefix

  "insecureTls": true,
  // Set to true when using the https:// URL (self-signed cert); false for http://

  "vaultName": "My Vault",
  // Exact name of your vault as it appears in Obsidian (used for deep links)

  "actionItemsFolder": "Inbox",
  // Vault-relative path to the folder containing your Action Items notes

  "actionItemsPrefix": "Action Items",
  // The bridge picks the newest file in that folder whose name starts with this

  "listenPort": 8765
  // Port the bridge listens on — the widget talks to this
}
```

`bridge/config.json` is git-ignored so your API key is never committed.

### 4. Run the bridge

```bash
node bridge/server.js
# or
npm start
```

Verify it's working — this should return your current open tasks as JSON:

```bash
curl http://127.0.0.1:8765/api/tasks
```

Leave the bridge running whenever you want the widget to be live.

### 5. Auto-start the bridge at login (recommended)

Run once to register the bridge as a login item:

```bash
node scripts/autostart.js install
# or
npm run autostart:install
```

| Platform | Mechanism |
|---|---|
| **Windows** | Drops `ObsidianActionItemsBridge.vbs` in your Startup folder. Runs silently in the background — no terminal window, no taskbar entry. Stop it via Task Manager → `node.exe`. No admin rights needed. |
| **macOS** | Installs a `LaunchAgent` plist in `~/Library/LaunchAgents/`. Runs silently; `KeepAlive` restarts it if it crashes. Check with `launchctl list com.obsidian.actionitems.bridge`. |
| **Linux** | Registers a `systemd --user` service. Check with `systemctl --user status obsidian-action-items-bridge`. Run `loginctl enable-linger $USER` to keep it running when logged out. |

```bash
node scripts/autostart.js status     # check registration and bridge health
node scripts/autostart.js uninstall  # remove the login item
```

### 6. Import the widget into iCUE

With your XENEON EDGE connected and iCUE 5.44+ open:

1. Open the **Widgets** panel for the XENEON EDGE display.
2. Click **+ / Import** and select `dist/Obsideon.icuewidget`.

The pre-built package is included in this repo. If you edit any files in `widget/`, rebuild it with Corsair's [WidgetBuilder CLI](https://www.corsair.com/us/en/explorer/diy-builder/accessories/how-to-create-a-custom-widget-for-the-xeneon-edge/):

```bash
icuewidget validate widget
icuewidget package widget --output dist/Obsideon.icuewidget
```

---

## Widget features

| Feature | How |
|---|---|
| **Check off a task** | Tap the green checkmark — marks it done in the note and removes it from the list |
| **Edit a task** | Tap the task text — opens a modal to update the text, due date, and priority |
| **Add a task** | Tap **+** in any section card header |
| **Add a section** | Tap **+ Section** in the top bar |
| **Open note in Obsidian** | Tap the external link icon in the top bar |
| **Refresh** | Tap the refresh icon, or wait — the widget polls every 15 seconds |

---

## How it works

- `bridge/server.js` lists `actionItemsFolder` via the Local REST API, picks the newest file whose name starts with `actionItemsPrefix` (filenames sort by their `YYYYMMDD` date suffix), and parses it.
- Parsing splits the note by `## headings` into sections and pulls each open `- [ ]` line, preserving indentation as a nesting level (up to 4) and extracting due dates and priority emoji. Already-checked items are omitted.
- Each item gets a stable ID from `sha256(file + line-index + line-text)`. The line index is included so two byte-identical lines stay distinct.
- `GET /api/tasks` returns `{ note, title, obsidianUri, openCount, sections[] }`.
- `POST /api/tasks/toggle` re-reads the note, flips that one line **by index** (never a global text replace — duplicate lines elsewhere in the note must not be affected), and writes it back.
- The bridge adds permissive CORS headers so the widget's sandboxed webview can reach it; the Local REST API plugin doesn't add them itself.
- The widget polls every 15 seconds and restores scroll position across refreshes so the UI doesn't jump while you're reading.

---

## Testing without real hardware

`test/mock-obsidian-server.js` is a minimal stand-in for the Local REST API plugin, backed by a synthetic vault at `test/fixture-vault/` (two Action Items notes exercising newest-note selection, nesting, due dates, an overdue item, a `— DELETE` heading, a hidden completed item, and duplicate lines). It never touches your real vault.

```bash
# Terminal 1 — fake Obsidian
npm run mock

# Terminal 2 — bridge pointed at the fake
npm run bridge:test

# Terminal 3 — inspect the response
curl http://127.0.0.1:8765/api/tasks
```

To preview the widget UI in a regular browser (useful for layout and interaction work):

```bash
npm run preview
# Open http://127.0.0.1:4321
```

With a bridge running on port 8765, the preview shows live data.

---

## File reference

| Path | Purpose |
|---|---|
| `bridge/server.js` | The relay server — run this on your PC |
| `bridge/config.json` | Your local settings (git-ignored, never committed) |
| `bridge/config.example.json` | Template with placeholder values — copy to `config.json` |
| `widget/index.html` | Widget HTML shell and templates |
| `widget/style.css` | Widget styles |
| `widget/app.js` | Widget logic (polling, rendering, modals) |
| `widget/manifest.json` | XENEON EDGE widget metadata |
| `widget/translation.json` | iCUE locale strings (English) |
| `widget/icon.png` | Widget picker icon |
| `dist/Obsideon.icuewidget` | Pre-built widget package, ready to import into iCUE |
| `scripts/autostart.js` | Cross-platform login auto-start installer |
| `package.json` | npm scripts (`start`, `mock`, `bridge:test`, `preview`, `autostart:*`) |
| `test/` | Mock Obsidian server and synthetic fixture vault |
