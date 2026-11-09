// Editor side of the Quarto annotate extension:
// - starts one notes server per workspace folder, on a port picked for that
//   folder, and stops it with the window
// - tells Quarto previews which port to use (QUARTO_ANNOTATE_SERVER in new terminals)
// - long-polls the server for "Send" clicks in the overlay and hands the notes
//   to Posit Assistant
// - shows the open-note count in the status bar
"use strict";

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT_BASE = 4850;
const PORT_SPAN = 100;
const ASSISTANT_COMMAND = "posit-assistant.newChat";
const SKIP_DIRS = "**/{node_modules,renv,.venv,.git,.quarto}/**";

const INSTRUCTIONS = `To resolve them:

1. Work on notes with "status": "open". Each note has a thread of messages ({"author": "user" | "assistant", "text", "at"}). The request is the latest user message, read in the context of the whole thread.
2. Find the note's place in the .qmd. Slide notes have slide: match on slide.title and target.text, then slide.number. Document notes have section and anchor: match on section.title and target.text, then on anchor (the index-th anchor.tag element in that section, from 0).
3. Make the edit. Then set "status": "done" and append {"author": "assistant", "text": "<one line saying what changed>", "at": "<ISO time>"} to thread. Change only status, thread (append only), slide, section, and anchor.
4. If you add, remove, or retitle slides, update slide.h, slide.id, and slide.title on affected notes. Set slide.h to -1 if the slide was removed. If you retitle a document section, update section.title (and section.id).
5. If a note is a question or unclear, append your answer or question and leave it open.

Don't run quarto render while quarto preview is running in the same folder.`;

/** @type {vscode.OutputChannel} */
let log;
/** @type {vscode.StatusBarItem} */
let status;
/** @type {Map<string, Folder>} */
const folders = new Map();
let context;

// ---------- helpers ----------

function cfg() {
  return vscode.workspace.getConfiguration("quartoAnnotate");
}

function info(msg) {
  log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function hashPort(key) {
  // FNV-1a, so each folder gets a stable default port and worktrees don't collide.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PORT_BASE + (h % PORT_SPAN);
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok ? await res.json() : { foreign: true };
  } catch (e) {
    return e && e.cause && e.cause.code === "ECONNREFUSED" ? null : { foreign: true };
  }
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return a === b;
  }
}

function findQuarto() {
  const own = cfg().get("quartoPath");
  if (own) return own;
  const q = vscode.workspace.getConfiguration("quarto").get("path");
  if (q) return q;
  const exe = process.platform === "win32" ? "quarto.exe" : "quarto";
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const p = path.join(dir, exe);
    if (dir && fs.existsSync(p)) return p;
  }
  const bundled = path.join(vscode.env.appRoot, "quarto", "bin", exe);
  if (fs.existsSync(bundled)) return bundled;
  return null;
}

// ---------- one workspace folder ----------

class Folder {
  constructor(wsFolder, serverTs) {
    this.ws = wsFolder;
    // One server for the whole workspace folder. Documents in nested Quarto
    // projects are named by their path from here (see QUARTO_ANNOTATE_ROOT).
    this.root = wsFolder.uri.fsPath;
    this.serverTs = serverTs;
    this.port = null;
    this.child = null;
    this.state = "starting"; // starting | running | stopped | error
    this.abort = new AbortController();
    this.counts = new Map(); // doc -> open notes
    this.watch();
  }

  get url() {
    return `http://127.0.0.1:${this.port}`;
  }

  async start() {
    this.state = "starting";
    refreshStatus();
    const quarto = findQuarto();
    if (!quarto) {
      this.fail("Couldn't find quarto. Set quartoAnnotate.quartoPath.");
      return;
    }
    const first = hashPort(this.root);
    for (let i = 0; i < 20; i++) {
      const port = PORT_BASE + ((first - PORT_BASE + i) % PORT_SPAN);
      const h = await health(port);
      if (h && !h.foreign && h.root && samePath(h.root, this.root)) {
        // A server for this folder is already up (another window, or a task). Use it.
        info(`Using the notes server already running for ${this.ws.name} on port ${port}`);
        this.port = port;
        return this.ready(false);
      }
      if (h) continue; // taken by something else
      if (await this.spawn(quarto, port)) return;
    }
    this.fail("Couldn't find a free port for the notes server.");
  }

  spawn(quarto, port) {
    return new Promise((resolve) => {
      const args = ["run", this.serverTs, this.root, "--port", String(port), "--watch-stdin"];
      info(`Starting: ${quarto} ${args.join(" ")}`);
      const child = cp.spawn(quarto, args, { cwd: this.root, stdio: ["pipe", "pipe", "pipe"] });
      let settled = false;
      const settle = (ok) => {
        if (!settled) {
          settled = true;
          resolve(ok);
        }
      };
      const onLine = (buf) => {
        const text = buf.toString();
        for (const line of text.split(/\r?\n/)) if (line.trim()) info(`server: ${line}`);
        if (/^Annotation server on /m.test(text)) {
          this.child = child;
          this.port = port;
          this.ready(true);
          settle(true);
        } else if (/already running/.test(text)) {
          settle(false); // lost a race for the port; try the next one
        }
      };
      child.stdout.on("data", onLine);
      child.stderr.on("data", onLine);
      child.on("error", (e) => {
        info(`Couldn't start quarto: ${e.message}`);
        settle(false);
      });
      child.on("exit", (code) => {
        if (this.child === child) {
          this.child = null;
          if (this.state !== "stopped") this.fail(`Notes server exited (code ${code}).`);
        }
        settle(false);
      });
    });
  }

  ready(owned) {
    this.state = "running";
    this.owned = owned;
    info(`Notes server for ${this.ws.name}: ${this.url}`);
    const env = context.environmentVariableCollection.getScoped({ workspaceFolder: this.ws });
    env.replace("QUARTO_ANNOTATE_SERVER", this.url);
    // Quarto resolves symlinks and letter case in input paths, so match that.
    let real = this.root;
    try {
      real = fs.realpathSync.native(this.root);
    } catch {
      /* keep the workspace path */
    }
    env.replace("QUARTO_ANNOTATE_ROOT", real);
    context.environmentVariableCollection.description =
      "Tells Quarto previews where the annotate notes server is running.";
    refreshStatus();
    this.poll();
  }

  fail(msg) {
    this.state = "error";
    this.error = msg;
    info(msg);
    refreshStatus();
  }

  async poll() {
    const signal = this.abort.signal;
    const port = this.port;
    while (!signal.aborted && this.port === port) {
      try {
        const res = await fetch(`${this.url}/events?wait=25`, { signal });
        const body = await res.json();
        if (body.event && body.event.event === "submit") await sendToAssistant(this, body.event.doc);
      } catch (e) {
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, 3000));
        if (this.state === "running" && !(await health(port))) {
          this.fail("Lost the notes server.");
          return;
        }
      }
    }
  }

  stop() {
    this.state = "stopped";
    this.abort.abort();
    this.abort = new AbortController();
    if (this.child) {
      this.child.stdin.end(); // the server exits when stdin closes
      const c = this.child;
      setTimeout(() => c.exitCode === null && c.kill(), 2000);
      this.child = null;
    }
  }

  async restart() {
    this.stop();
    await new Promise((r) => setTimeout(r, 500));
    await this.start();
  }

  // ---- open-note counts ----

  watch() {
    const pattern = new vscode.RelativePattern(this.ws, "**/*.annotations.json");
    const w = vscode.workspace.createFileSystemWatcher(pattern);
    const update = (uri) => this.count(uri);
    w.onDidCreate(update);
    w.onDidChange(update);
    w.onDidDelete((uri) => {
      this.counts.delete(this.docOf(uri));
      refreshStatus();
    });
    context.subscriptions.push(w);
    vscode.workspace.findFiles(pattern, SKIP_DIRS).then((uris) => uris.forEach(update));
  }

  // Same name the Lua filter gives the document: path from the folder, no suffix, "/" separators.
  docOf(uri) {
    const rel = path.relative(this.root, uri.fsPath).split(path.sep).join("/");
    return rel.replace(/\.annotations\.json$/, "");
  }

  count(uri) {
    if (/(^|\/)(node_modules|renv|\.venv|\.git|\.quarto)\//.test(this.docOf(uri))) return;
    try {
      const data = JSON.parse(fs.readFileSync(uri.fsPath, "utf8"));
      this.counts.set(this.docOf(uri), (data.notes || []).filter((n) => n.status !== "done").length);
    } catch {
      return; // mid-write; the next change event catches up
    }
    refreshStatus();
  }

  get open() {
    let n = 0;
    for (const c of this.counts.values()) n += c;
    return n;
  }
}


// ---------- assistant ----------

function buildPrompt(folder, doc) {
  const file = `${doc}.annotations.json`;
  const open = folder.counts.get(doc);
  const count = open === undefined ? "" : ` (${open} open)`;
  let prompt = `Resolve the open annotations in \`${file}\` for \`${doc}.qmd\`${count}.`;
  const multiRoot = (vscode.workspace.workspaceFolders || []).length > 1;
  if (multiRoot || doc.includes("/")) prompt += ` Paths are relative to ${folder.root}.`;
  if (cfg().get("assistant.includeInstructions")) prompt += "\n\n" + INSTRUCTIONS;
  return prompt;
}

async function sendToAssistant(folder, doc) {
  const prompt = buildPrompt(folder, doc);
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes(ASSISTANT_COMMAND)) {
    info(`Sending ${doc} notes to Posit Assistant`);
    try {
      await vscode.commands.executeCommand(ASSISTANT_COMMAND, {
        prompt,
        target: cfg().get("assistant.target"),
        behavior: cfg().get("assistant.behavior"),
      });
      return;
    } catch (e) {
      info(`Posit Assistant didn't take the request: ${e.message}`);
    }
  }
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    "Posit Assistant isn't available, so the request is on your clipboard. Paste it into your assistant's chat."
  );
}

async function pickDoc(folder) {
  const docs = [...folder.counts.entries()].filter(([, n]) => n > 0);
  if (docs.length === 0) {
    vscode.window.showInformationMessage("There are no open notes.");
    return null;
  }
  if (docs.length === 1) return docs[0][0];
  const pick = await vscode.window.showQuickPick(
    docs.map(([doc, n]) => ({ label: `${doc}.qmd`, description: `${n} open`, doc })),
    { placeHolder: "Which document's notes?" }
  );
  return pick ? pick.doc : null;
}

async function pickFolder() {
  const list = [...folders.values()];
  if (list.length <= 1) return list[0] || null;
  const pick = await vscode.window.showQuickPick(
    list.map((f) => ({ label: f.ws.name, description: `${f.open} open`, f })),
    { placeHolder: "Which folder?" }
  );
  return pick ? pick.f : null;
}

// ---------- status bar ----------

function refreshStatus() {
  const list = [...folders.values()];
  if (!list.length) return status.hide();
  const open = list.reduce((n, f) => n + f.open, 0);
  const err = list.find((f) => f.state === "error");
  const starting = list.some((f) => f.state === "starting");
  status.text = err
    ? "$(warning) Annotate"
    : `${starting ? "$(sync~spin)" : "$(comment-discussion)"} Annotate: ${open} open`;
  status.tooltip = list
    .map((f) => `${f.ws.name}: ${f.state === "running" ? f.url : f.error || f.state}`)
    .join("\n");
  status.show();
}

async function menu() {
  const folder = await pickFolder();
  if (!folder) return;
  const items = [
    { label: "$(send) Send open notes to assistant", run: () => sendCommand(folder) },
    { label: "$(debug-restart) Restart notes server", run: () => folder.restart() },
    { label: "$(output) Show log", run: () => log.show() },
  ];
  for (const [doc] of folder.counts) {
    items.push({
      label: `$(json) Open ${doc}.annotations.json`,
      run: () => vscode.window.showTextDocument(vscode.Uri.file(path.join(folder.root, `${doc}.annotations.json`))),
    });
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder: status.tooltip });
  if (pick) pick.run();
}

async function sendCommand(folder) {
  folder = folder || (await pickFolder());
  if (!folder) return;
  const doc = await pickDoc(folder);
  if (doc) await sendToAssistant(folder, doc);
}

// ---------- lifecycle ----------

async function addFolder(ws) {
  if (folders.has(ws.uri.toString())) return;
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(ws, "**/_extensions/**/annotate/server.ts"),
    SKIP_DIRS,
    1
  );
  if (!found.length) return;
  const f = new Folder(ws, found[0].fsPath);
  folders.set(ws.uri.toString(), f);
  refreshStatus();
  if (cfg().get("autoStart")) await f.start();
  else {
    f.state = "stopped";
    refreshStatus();
  }
}

function removeFolder(ws) {
  const f = folders.get(ws.uri.toString());
  if (!f) return;
  f.stop();
  context.environmentVariableCollection.getScoped({ workspaceFolder: ws }).clear();
  folders.delete(ws.uri.toString());
  refreshStatus();
}

function activate(ctx) {
  context = ctx;
  log = vscode.window.createOutputChannel("Annotate");
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "quartoAnnotate.menu";
  ctx.subscriptions.push(
    log,
    status,
    vscode.commands.registerCommand("quartoAnnotate.sendToAssistant", () => sendCommand()),
    vscode.commands.registerCommand("quartoAnnotate.restartServer", async () => {
      const f = await pickFolder();
      if (f) await f.restart();
    }),
    vscode.commands.registerCommand("quartoAnnotate.showLog", () => log.show()),
    vscode.commands.registerCommand("quartoAnnotate.menu", menu),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      e.removed.forEach(removeFolder);
      e.added.forEach(addFolder);
    })
  );
  (vscode.workspace.workspaceFolders || []).forEach(addFolder);
}

function deactivate() {
  for (const f of folders.values()) f.stop();
}

module.exports = { activate, deactivate, hashPort, buildPrompt };
