# Wooden Labyrinth — Level Editor

A static, browser-based level editor for the *Wooden Labyrinth 3D* iOS game.
Edit, create, and save labyrinth packs straight from your browser. Hosted on
GitHub Pages; the repo itself is the database.

> Each pack is a single `<Levelpack>` XML file under `packs/`. The editor
> reads them via the same-origin Pages URL and writes them back through the
> GitHub Contents API using your personal access token.

## Quick start (using the hosted site)

1. Open the Pages URL (e.g. `https://<user>.github.io/<repo>/`).
2. The first time, you'll be prompted for your GitHub repository and (for
   saving) a personal access token. Paste them in the **Settings** dialog and
   click *Save settings*.
3. Either pick an existing pack from the dropdown / type its **numeric ID**
   (e.g. `117`) into the input and click **Open** — or click **New…** to
   start a brand-new pack. New packs live only in your browser until you
   click **Save**; nothing hits the server before then.
4. Edit. Click **Save** (or `⌘S`):
   - For a brand-new pack you'll get a "Save new pack" dialog showing the
     next free numeric ID (≥ 500) and an optional save-password field.
     Committing reserves that ID on GitHub.
   - For an existing protected pack, you'll be prompted for the author's
     save password the first time you save in a session (verified against
     the hash in the pack XML).
   - For an existing pack with no password, the save commits directly.

   A commit lands on the configured branch with a message like
   `Update packs/pack517.xml via Level Editor`.

### Save passwords

Each pack carries an optional **save password**, set by its author the
first time the pack is saved:

* Loading a pack never requires a password.
* Saving back to GitHub does — the editor checks your input against the
  hash stored in the pack's `<password>` element and only commits on a
  match.
* The password is set exactly once (on the very first save) and never
  changed by the editor afterwards. Forgotten passwords mean no more
  edits via this editor (you'd have to alter the XML directly on GitHub).
* The hash is SHA-256, stored in plain XML next to the pack metadata.
  It's a soft "are you the author" gate, not real crypto — anyone with the
  pack XML can copy and edit it locally; the password only blocks
  committing via this editor.

The iOS game silently ignores the `<password>` element (its XML parsers
skip unknown elements at the `<Levelpack>` level).

## Creating a personal access token

A token is required to *save* (writes go via the GitHub API). Reading public
packs needs no token.

1. Open <https://github.com/settings/personal-access-tokens> → **Generate new
   token (fine-grained)**.
2. **Resource owner**: your user.
3. **Repository access**: *Only select repositories* → pick this editor's
   repo.
4. **Repository permissions** → **Contents: Read and write**.
5. Generate, copy the token, paste it into the editor's **Settings →
   Personal access token** field, click *Save settings*. It is stored only in
   your browser's `localStorage` and only sent to `api.github.com`.

## Hosting on GitHub Pages

The editor is a static site — no build step.

1. Push this repo to GitHub.
2. Go to **Settings → Pages** and set *Source* to `Deploy from a branch`,
   *Branch* to `main`, folder `/ (root)`.
3. Wait ~30 seconds. The site lives at
   `https://<username>.github.io/<repo>/`.

The editor auto-detects the owner / repo from that URL on first run. Override
it any time via **Settings**.

## Local development

You can also run it locally — open `index.html` directly, or serve from a
local HTTP server (recommended so GitHub API calls aren't blocked by
`file://`):

```bash
cd level-editor
python3 -m http.server 8000
# then open http://localhost:8000
```

Locally the editor doesn't know your repo, so open **Settings** and type
`owner/repo` once. Settings persist in `localStorage`.

## Repository layout

```
.
├── index.html      ← the editor UI
├── editor.css      ← visual styling
├── editor.js       ← all the logic (vanilla JS, no build)
├── assets/         ← wood textures + hole sprite
├── packs/          ← *.xml level packs — the data
└── README.md       ← this file
```

## Level XML format (reference)

Every pack is one XML file:

```xml
<Levelpack>
  <packname>Tutorial Levels</packname>
  <author>Elias</author>
  <Labyrinth>
    <name>Tilt to Control</name>
    <partime>5</partime>            <!-- target time, integer seconds -->
    <devtime>1.20</devtime>         <!-- dev best time, float seconds -->
    <jump>1</jump>                  <!-- optional; presence enables jump -->
    <wall>  <x/><y/><width/><height/><size/>  </wall>   <!-- size: 0.5 | 1 -->
    <hole>  <x/><y/><width/><height/>          </hole>
    <start> <x/><y/><width/><height/>          </start>
    <goal>  <x/><y/><width/><height/>          </goal>
  </Labyrinth>
  …
</Levelpack>
```

Board is **480 × 320** logical pixels, top-left origin, y points down.

## Keyboard shortcuts

| Key             | Action |
|-----------------|--------|
| `V` / `W` / `H` / `S` / `G` | Select / Wall / Hole / Start / Goal |
| `H` *(on selected wall)*    | Toggle wall height (full ↔ low) |
| `D`                         | Duplicate selection |
| `⌫` Backspace               | Delete selection |
| Arrows                      | Nudge selection 1 px (`⇧` = 10 px) |
| `⌘Z` / `⇧⌘Z`               | Undo / redo |
| `⌘S`                        | Save current pack to GitHub |
| `Esc`                       | Deselect (also closes modals) |
