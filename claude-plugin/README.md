# Quarto Annotate for Claude Code

A Claude Code plugin for the [annotate](https://github.com/blairj09/annotate) Quarto extension. It works in the Claude Code CLI and in Claude Code sessions in the Claude Desktop app, including when you annotate in Desktop's built-in browser.

- **Starts the notes server with each session** in a project that has the annotate Quarto extension, and stops it when the last session using it ends. Projects without the extension are left alone.
- **Adds `/annotate`**, which resolves the open notes: it edits the `.qmd`, marks each note done, and replies on its pin. `/annotate deck` limits it to one document, and `/annotate setup` adds annotate to a project. Asking Claude to "resolve the annotations" also uses it.

## Install

```bash
claude plugin marketplace add blairj09/annotate
claude plugin install annotate@annotate
```

Or, in a session, `/plugin marketplace add blairj09/annotate`, then `/plugin install annotate@annotate`.

## Use

1. In a project without annotate yet, run `/annotate setup` (or `quarto add blairj09/annotate` and add `annotate` to `filters`).
2. Preview the deck, either by asking Claude to run `quarto preview deck.qmd` or by running it yourself, and open it at `localhost`. Press **A** to add notes, or **D** to draw.
3. Run `/annotate`.

The **Send** button in the overlay only appears with the Positron/VS Code extension, so in Claude Code you type `/annotate` instead.

## Ports

The server uses port 4850 when it's free, which the filter uses by default, so any preview finds it. When 4850 is busy (another project's server), it uses the same per-folder port the editor extension would, and the two share one server. Previews that Claude starts get the port through `QUARTO_ANNOTATE_SERVER`. For a preview started elsewhere, set `annotate: {server: http://127.0.0.1:<port>}` in front matter; Claude is told the port at session start.

State and server logs are kept in the plugin's data folder (`servers/<port>.log`).

## Requirements

Quarto on `PATH` (or at `/Applications/quarto`), plus `bash` and `curl`. The hooks are bash scripts, so on Windows they need Git Bash or WSL.
