# annotate

Leave notes on your Quarto slides and documents for an AI coding assistant to resolve.

Click anywhere on a slide or page in the live preview and type what you want changed: "shorten this bullet," "swap these two," "drop this slide." Notes are saved to a JSON file next to your `.qmd`. Your assistant reads that file, edits the source, and replies on each pin. Each note is a thread, so you can reply to follow up, and the assistant sees the whole conversation.

## Install

```bash
quarto add blairj09/annotate
```

Then add the filter to your deck's or document's front matter:

```yaml
filters:
  - annotate
```

## Use

1. **Start the notes server** from your project folder. It runs on the Deno bundled with Quarto, so there's nothing else to install:

   ```bash
   quarto run _extensions/blairj09/annotate/server.ts
   ```

   It writes `<deck>.annotations.json` to the current folder. Options: a different folder to write to, `--port` (default 4850), `--host`, and `--verbose`. If a server is already running on the port, a second copy exits quietly.

2. **Preview the deck or document** with `quarto preview deck.qmd`, or Preview in Positron or VS Code.

3. **Annotate.** Press **A** or click **Annotate** in the toolbar (top right on slides, bottom right on documents). Hover to see what you're pointing at, click, type a note, and press Cmd/Ctrl+Enter.

4. **Ask your assistant** to "resolve the annotations." When the file changes, the preview picks it up within a few seconds.

Pins are orange while open and turn into green checks when resolved. Click a pin to read the thread, reply (which reopens the note), resolve or reopen it yourself, or delete it. **List** shows every note and jumps to its slide or section. **Copy** puts the open notes on the clipboard as Markdown, for assistants that can't read files.

The dot in the toolbar is green when the server is reachable. When it's red, notes are kept in the browser and sent to the server once it's running.

### Positron and VS Code extension

The [Quarto Annotate](vscode/) editor extension does steps 1 and 4 for you. It starts the server when the folder opens (on its own port for each folder), stops it when the window closes, and adds a **Send** button to the overlay that sends the open notes to Posit Assistant. See [vscode/README.md](vscode/README.md).

### Start the server automatically with a task

Without the editor extension, add this to `.vscode/tasks.json` to start the server when the folder opens (you'll be asked to allow automatic tasks once). Change the path if your extension lives somewhere else:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Annotation server",
      "type": "shell",
      "command": "quarto",
      "args": ["run", "_extensions/blairj09/annotate/server.ts", "."],
      "isBackground": true,
      "runOptions": { "runOn": "folderOpen" },
      "presentation": { "reveal": "silent", "panel": "dedicated" },
      "problemMatcher": {
        "pattern": { "regexp": "^__never_matches__$" },
        "background": {
          "activeBegins": true,
          "beginsPattern": "^Annotation server",
          "endsPattern": "^Annotation server (on|already running)"
        }
      }
    }
  ]
}
```

### Rendering for an audience

The overlay only runs when the deck is served from `localhost` or `127.0.0.1`, so a rendered HTML file opened from disk or a web server stays clean. To leave the script out of the file entirely, turn the filter off for one render:

```bash
quarto render deck.qmd -M annotate:false
```

Options (front matter):

```yaml
annotate:
  enabled: true                    # or `annotate: false`
  server: http://127.0.0.1:4850    # match `server.ts --port`
```

## For your assistant

Paste this into your project's `AGENTS.md`, `CLAUDE.md`, or equivalent:

```markdown
## Slide annotations

Slide notes live in `<deck>.annotations.json`. To "resolve annotations":

1. Work on notes with `"status": "open"`. Each note has a `thread` of messages
   (`{"author": "user" | "assistant", "text", "at"}`). The request is the latest
   `user` message, read in the context of the whole thread.
2. Find the note's place in the `.qmd`. Slide notes have `slide`: match on
   `slide.title` and `target.text`, then `slide.number`. Document notes have
   `section` and `anchor`: match on `section.title` and `target.text`, then on
   `anchor` (the `index`-th `anchor.tag` element in that section, from 0).
3. Make the edit. Then set `"status": "done"` and append
   `{"author": "assistant", "text": "<one line saying what changed>", "at": "<ISO time>"}`
   to `thread`. Change only `status`, `thread` (append only), `slide`, `section`,
   and `anchor`.
4. If you add, remove, or retitle slides, update `slide.h`, `slide.id`, and
   `slide.title` on affected notes. Set `slide.h` to `-1` if the slide was removed.
   If you retitle a document section, update `section.title` (and `section.id`).
5. If a note is a question or unclear, append your answer or question and leave
   it `open`.

Don't run `quarto render` while `quarto preview` is running in the same folder.
Two renders at once can produce a broken HTML file.
```

## Notes file

```json
{
  "doc": "slides",
  "notes": [
    {
      "num": 3,
      "id": "a1b2c3d4",
      "status": "open",
      "slide": { "number": 5, "h": 4, "v": 0, "id": "why-us", "title": "Why us" },
      "x": 62.5,
      "y": 31.0,
      "target": { "tag": "li", "text": "One governed source of packages…" },
      "text": "Shorten this bullet to one line",
      "thread": [
        { "author": "user", "text": "Shorten this bullet to one line", "at": "2026-10-29T15:02:11+00:00" },
        { "author": "assistant", "text": "Cut it to \"One governed package source\".", "at": "2026-10-29T15:04:40+00:00" },
        { "author": "user", "text": "Better, but keep the word 'approved'", "at": "2026-10-29T15:06:02+00:00" }
      ]
    }
  ]
}
```

- `slide.number` is the visible slide number. `h` and `v` are reveal.js indices.
- `x` and `y` are percentages of the slide, from the top left.

Notes on an HTML document have `section` and `anchor` in place of `slide`:

```json
{
  "num": 1,
  "id": "e5f6a7b8",
  "status": "open",
  "section": { "id": "requirements", "title": "Requirements", "level": 2 },
  "anchor": { "tag": "p", "index": 0 },
  "x": 30.0,
  "y": 48.5,
  "target": { "tag": "p", "text": "This guide lists the steps…" },
  "text": "Cut this to one sentence",
  "thread": [ … ]
}
```

- `section` is the nearest heading above the click. `id` is the section's anchor, if it has one.
- `anchor` is the clicked element: the `index`-th `tag` element in that section, counting from 0.
- `x` and `y` are percentages of that element's box, so the pin follows the text when the page reflows. If the element is gone, the pin moves to the section heading and gets a dashed border.
- `target` describes the element under the click: tag, a text snippet, classes, and image or video `src`.
- `text` is the original comment and never changes. The browser can only add `user` messages to `thread`, and a reply sets `status` back to `open`. Editing the file directly is safe, because the server reads it fresh on every request.

## Server API

All JSON. `doc` is the source file name without `.qmd`.

| Request | Does |
|---|---|
| `GET /health` | Status check |
| `GET /notes?doc=NAME` | All notes for a deck |
| `POST /notes?doc=NAME` | Create or update one note, matched by `id` |
| `POST /notes/reply?doc=NAME&id=ID` | Add a user reply `{"text": "..."}` and reopen the note |
| `DELETE /notes?doc=NAME&id=ID` | Delete a note |

## Limits

- Works with revealjs and HTML-based formats (`html`, website and book pages). PDF and Typst output can't be annotated, but you can add an `html` format next to them and annotate that preview.
- On slides, pins are tied to slide position, not source lines. Big layout changes can leave a pin near, rather than on, its element. On documents, pins are tied to the clicked element.
- On Posit Workbench, the browser can't reach the server at `127.0.0.1` without a proxy, so notes stay in the browser.
- In Positron, the Quarto extension's preview pane may not show the overlay. Opening the preview URL in the Viewer (**Open URL in Viewer**) or in a browser works.
- Developed and tested with Quarto 1.10 and 1.11.

## License

MIT
