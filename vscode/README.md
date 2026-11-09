# Quarto Annotate for Positron and VS Code

The editor side of the [annotate](https://github.com/blairj09/annotate) Quarto extension.

- **Starts one notes server per workspace folder** that has the annotate Quarto extension anywhere inside it, and stops it when the window closes. No `tasks.json` needed.
- **Handles every Quarto project in the folder.** Documents are named by their path from the workspace folder (`customers/danone/deck`), and each notes file is saved next to its `.qmd`.
- **Picks a port per folder**, so several windows or worktrees can be open at once. New terminals get `QUARTO_ANNOTATE_SERVER` and `QUARTO_ANNOTATE_ROOT`, and the annotate filter uses them, so `quarto preview` finds the right server and document name. (An `annotate: server:` in front matter still wins.)
- **Adds a Send button to the overlay.** It sends the open notes to Posit Assistant. If Posit Assistant isn't installed, the request goes to your clipboard instead.
- **Shows the open-note count** in the status bar. Click it to send notes, restart the server, see the log, or open a notes file.

Needs version 0.3.0 or later of the annotate Quarto extension (`quarto add blairj09/annotate` to update).

Terminals that were open before the extension started don't have the variable. Restart a running preview once after installing.

## Settings

| Setting | Default | |
|---|---|---|
| `quartoAnnotate.autoStart` | `true` | Start the server when the folder opens |
| `quartoAnnotate.quartoPath` | `""` | Falls back to `quarto.path`, then `PATH`, then Positron's bundled Quarto |
| `quartoAnnotate.assistant.behavior` | `submit` | `prefill` puts the request in the chat box without sending it |
| `quartoAnnotate.assistant.target` | `auto` | `new` starts a new chat each time |
| `quartoAnnotate.assistant.includeInstructions` | `true` | Put the resolve steps in the request, so `AGENTS.md` doesn't need them |

## Build

No build step. To package and install locally:

```bash
cd vscode
npx @vscode/vsce package
positron --install-extension quarto-annotate-0.1.0.vsix   # or: code --install-extension
```
