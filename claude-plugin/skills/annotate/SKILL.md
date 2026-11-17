---
name: annotate
description: Resolve notes left on Quarto slides or documents with the annotate overlay (stored in *.annotations.json next to the .qmd), or set up annotate in a project. Use when the user asks to resolve, address, apply, or review their annotations, slide notes, or deck feedback, or to set up annotating a deck.
argument-hint: "[doc | setup]"
---

# Quarto annotate

The user leaves notes on a Quarto preview with the annotate overlay. Each document's notes live in `<doc>.annotations.json` next to its `.qmd`. A local notes server writes that file while the user annotates; you edit it directly.

Arguments: `$ARGUMENTS`

- Empty: resolve open notes in every `*.annotations.json` in the project.
- A document name or path (e.g. `deck` or `talks/deck.qmd`): only that document's notes.
- `setup`: set the project up instead (see the end).

## Resolve notes

1. Find the notes files: `*.annotations.json` under the project, skipping `_extensions`, `node_modules`, `renv`, `.venv`, `.quarto`, and `_site`/`_book` output folders. Read each, and work only on notes with `"status": "open"`. If there are none, say so and stop.
2. Each note has a `thread` of messages (`{"author": "user" | "assistant", "text", "at"}`). The request is the latest `user` message, read in the context of the whole thread. Older notes may have only `text` (the original comment) and `response`.
3. Find the note's place in the `.qmd`:
   - Slide notes have `slide`: match on `slide.title` and `target.text`, then `slide.number`.
   - Document notes have `section` and `anchor`: match on `section.title` and `target.text`, then on `anchor` (the `index`-th `anchor.tag` element in that section, from 0).
   - `x` and `y` are percentages from the top left of the slide (documents: of the anchor element). `target` describes the element clicked (`tag`, `text`, `classes`, `src`, `alt`).
   - A note with `strokes` is a freehand drawing, usually a layout sketch: each stroke is a list of `[x, y]` points in the same percentages, and `bounds` is its box `{x, y, w, h}`. Work out what the strokes cover or point to (a loop around content, an arrow from one place to another, a box sketching a new region) and read that together with the text.
4. Make the edit in the source. Then, in the notes file, set `"status": "done"` and append `{"author": "assistant", "text": "<one line saying what changed>", "at": "<ISO 8601 time>"}` to `thread`. Change only `status`, `thread` (append only), `slide`, `section`, and `anchor`; leave every other field and every other note as it is.
5. If you add, remove, or retitle slides, update `slide.h`, `slide.id`, and `slide.title` on affected notes. Set `slide.h` to `-1` if the slide was removed. If you retitle a document section, update `section.title` (and `section.id`).
6. If a note is a question or unclear, append your answer or question to its thread and leave it `open`.

Write the JSON back as valid JSON with the same structure (top level `{"doc", "notes"}`). The overlay polls the server, so the user sees replies within a few seconds.

Don't run `quarto render` while `quarto preview` is running in the same folder; two renders at once can corrupt the output. The preview re-renders on save by itself.

Finish with a short summary: one line per note, saying what changed or what you asked.

## Set up a project (`setup`)

1. If no `_extensions/*/annotate/server.ts` exists under the project, run `quarto add blairj09/annotate --no-prompt` in the folder with `_quarto.yml` (or the document's folder if there's no project).
2. Add `annotate` to the top-level `filters` list, keeping any filters already there. Ask whether it should go in `_quarto.yml` (every document) or one document's front matter, unless only one makes sense. If the document already has its own `filters`, add it there.
3. The notes server starts with each Claude Code session. In this session it isn't running yet, so start it in the background: `quarto run _extensions/blairj09/annotate/server.ts . --port 4850` from the project root. Or tell the user to start a new session.
4. Tell the user to preview the document (`quarto preview <file>.qmd`), open it at `localhost`, press **A** to add notes or **D** to draw, then ask you to resolve them.
