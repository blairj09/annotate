// Editor side of the Quarto annotate extension:
// - starts one notes server per workspace folder, on a port picked for that
//   folder, and stops it with the window
// - tells Quarto previews which port to use (QUARTO_ANNOTATE_SERVER in new terminals)
// - long-polls the server for "Send" clicks in the overlay and hands the notes
//   to Posit Assistant
// - shows the open-note count in the status bar
// - "Set Up This Project" installs the Quarto extension and turns on the filter
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { launchQuarto } = require("./launch");
const { addFilter, addFilterToQmd, qmdHasFilters } = require("./yaml-filter");

const QUARTO_EXTENSION = "blairj09/annotate";

const PORT_BASE = 4850;
const PORT_SPAN = 100;
const ASSISTANT_COMMAND = "posit-assistant.newChat";
const SKIP_DIRS = "**/{node_modules,renv,.venv,.git,.quarto}/**";

const INSTRUCTIONS = `To resolve them:

1. Work on notes with "status": "open". Each note has a thread of messages ({"author": "user" | "assistant", "text", "at"}). The request is the latest user message, read in the context of the whole thread.
2. Find the note's place in the .qmd. Slide notes have slide: match on slide.title and target.text, then slide.number. Document notes have section and anchor: match on section.title and target.text, then on anchor (the index-th anchor.tag element in that section, from 0). A note with strokes is a freehand drawing (a layout sketch): each stroke is a list of [x, y] points in % of the slide (documents: of the anchor element), and bounds is its box {x, y, w, h}. Read the sketch together with the text.
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
      const child = launchQuarto(quarto, args, { cwd: this.root, stdio: ["pipe", "pipe", "pipe"] });
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

// ---------- project setup ----------

function runQuarto(quarto, args, cwd) {
  return new Promise((resolve) => {
    info(`Running: ${quarto} ${args.join(" ")} (in ${cwd})`);
    let child;
    try {
      child = launchQuarto(quarto, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: -1, out: e.message });
      return;
    }
    let out = "";
    const onData = (buf) => {
      out += buf.toString();
      for (const line of buf.toString().split(/\r?\n/)) if (line.trim()) info(`quarto: ${line}`);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => resolve({ code: -1, out: e.message }));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

// The nearest folder at or above `dir` (but inside the workspace folder) with a _quarto.yml.
function findProjectDir(dir, wsRoot) {
  for (let d = dir; ; d = path.dirname(d)) {
    for (const name of ["_quarto.yml", "_quarto.yaml"]) {
      const file = path.join(d, name);
      if (fs.existsSync(file)) return { dir: d, file };
    }
    const atTop = samePath(d, wsRoot) || path.relative(wsRoot, d).startsWith("..") || path.dirname(d) === d;
    if (atTop) return null;
  }
}

async function pickQmd() {
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.scheme === "file" && /\.qmd$/i.test(active.fileName)) return active.uri;
  const found = await vscode.workspace.findFiles("**/*.qmd", SKIP_DIRS, 200);
  if (!found.length) return null;
  if (found.length === 1) return found[0];
  const pick = await vscode.window.showQuickPick(
    found
      .map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    { placeHolder: "Which document do you want to annotate?" }
  );
  return pick ? pick.uri : null;
}

// Edit through a TextDocument so unsaved changes in an open editor are kept.
async function editFile(uri, transform) {
  const doc = await vscode.workspace.openTextDocument(uri);
  const res = transform(doc.getText());
  if (!res.changed) return false;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), res.text);
  if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`Couldn't edit ${path.basename(uri.fsPath)}`);
  await doc.save();
  return true;
}

async function setupProject() {
  const qmd = await pickQmd();
  if (!qmd) {
    vscode.window.showWarningMessage("Open the .qmd you want to annotate, then run this command again.");
    return;
  }
  const ws = vscode.workspace.getWorkspaceFolder(qmd);
  if (!ws) {
    vscode.window.showWarningMessage("That document isn't in an open workspace folder.");
    return;
  }
  const quarto = findQuarto();
  if (!quarto) {
    vscode.window.showErrorMessage("Couldn't find quarto. Install Quarto or set quartoAnnotate.quartoPath.");
    return;
  }

  const docDir = path.dirname(qmd.fsPath);
  const project = findProjectDir(docDir, ws.uri.fsPath);
  // Quarto looks for _extensions next to the document or at the project root.
  const installDir = project ? project.dir : docDir;
  const rel = (p) => vscode.workspace.asRelativePath(p) || ".";

  // Where the filter goes. Document-level `filters` may replace the project's,
  // so a document with its own list always gets it there.
  const docText = (await vscode.workspace.openTextDocument(qmd)).getText();
  let target = qmd;
  if (project && !qmdHasFilters(docText)) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: "Every document in the project", description: rel(project.file), uri: vscode.Uri.file(project.file) },
        { label: "Just this document", description: rel(qmd), uri: qmd },
      ],
      { placeHolder: "Turn on annotations for…" }
    );
    if (!pick) return;
    target = pick.uri;
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Setting up Annotate" },
      async (progress) => {
        const installed = await vscode.workspace.findFiles(
          new vscode.RelativePattern(installDir, "_extensions/**/annotate/server.ts"),
          null,
          1
        );
        if (!installed.length) {
          progress.report({ message: `quarto add ${QUARTO_EXTENSION}` });
          const r = await runQuarto(quarto, ["add", QUARTO_EXTENSION, "--no-prompt"], installDir);
          if (r.code !== 0) throw new Error(`quarto add failed (see Annotate: Show Log). ${r.out.trim().split("\n").pop() || ""}`);
        } else {
          info(`Quarto extension already in ${rel(installDir)}; not reinstalling`);
        }

        progress.report({ message: `Adding the filter to ${path.basename(target.fsPath)}` });
        const isQmd = /\.qmd$/i.test(target.fsPath);
        const changed = await editFile(target, (text) =>
          isQmd ? addFilterToQmd(text) : addFilter(text, text.includes("\r\n") ? "\r\n" : "\n")
        );
        info(changed ? `Added the annotate filter to ${rel(target)}` : `${rel(target)} already has the annotate filter`);

        progress.report({ message: "Starting the notes server" });
        const f = folders.get(ws.uri.toString());
        if (!f) await addFolder(ws, true);
        else if (f.state !== "running") await f.restart();
      }
    );
  } catch (e) {
    info(e.message);
    vscode.window.showErrorMessage(e.message);
    return;
  }

  const commands = await vscode.commands.getCommands(true);
  const canPreview = commands.includes("quarto.preview");
  const choice = await vscode.window.showInformationMessage(
    `Annotate is set up for ${path.basename(qmd.fsPath)}. Preview it, then press A to add notes or D to draw.`,
    ...(canPreview ? ["Preview"] : [])
  );
  if (choice === "Preview") {
    await vscode.window.showTextDocument(qmd);
    await vscode.commands.executeCommand("quarto.preview");
  }
}

// ---------- lifecycle ----------

async function addFolder(ws, start) {
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
  if (start || cfg().get("autoStart")) await f.start();
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
    vscode.commands.registerCommand("quartoAnnotate.setupProject", setupProject),
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
