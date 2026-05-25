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
3. Pick a pack from the dropdown — or type its ID and press **Open** — to
   start editing. Use **New…** to create a brand-new pack.
4. Edit, then click **Save** (or `⌘S` / `Ctrl+S`). A commit lands on the
   configured branch with a message like
   `Update packs/myPack.xml via Level Editor`.

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
