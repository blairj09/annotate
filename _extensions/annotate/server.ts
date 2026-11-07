/**
 * Local notes server for the Quarto `annotate` extension.
 *
 * Stores slide annotations as `<doc>.annotations.json` in ROOT (default: the
 * current directory), so a coding assistant can read and resolve them. Runs on
 * the Deno that ships with Quarto, so nothing else needs to be installed:
 *
 *     quarto run _extensions/annotate/server.ts [ROOT] [--port 4850] [--host 127.0.0.1] [--verbose]
 *
 * API (all JSON; `doc` is the source file stem, e.g. `ll-bean`):
 *     GET    /health
 *     GET    /notes?doc=NAME               -> {"doc": NAME, "notes": [...]}
 *     POST   /notes?doc=NAME               upsert one note (merged by `id`)
 *     POST   /notes/reply?doc=NAME&id=ID   {"text": ...}: add a user reply, reopen
 *     DELETE /notes?doc=NAME&id=ID
 */

type Message = { author: "user" | "assistant"; text: string; at: string };
type Note = Record<string, unknown> & {
  id: string;
  num?: number;
  status?: string;
  text?: string;
  response?: string;
  created?: string;
  updated?: string;
  thread?: Message[];
};
type Data = { doc: string; notes: Note[] };

const DOC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
// Fields the browser may set. `num`, `thread`, and `response` belong to the
// server and the assistant; `text` (the original comment) is only accepted when
// a note is created. Replies go through POST /notes/reply.
const CLIENT_FIELDS = new Set([
  "id", "slide", "section", "anchor", "x", "y", "target", "text", "created", "updated", "status",
]);
const MAX_BODY = 1_000_000;

// ---------- args ----------

function parseArgs(argv: string[]) {
  const out = { root: ".", port: 4850, host: "127.0.0.1", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice(7));
    else if (a === "--host") out.host = argv[++i];
    else if (a.startsWith("--host=")) out.host = a.slice(7);
    else if (a === "--verbose") out.verbose = true;
    else if (a === "-h" || a === "--help") {
      console.log("Usage: quarto run server.ts [ROOT] [--port 4850] [--host 127.0.0.1] [--verbose]");
      Deno.exit(0);
    } else if (!a.startsWith("-")) out.root = a;
  }
  if (!Number.isInteger(out.port) || out.port <= 0 || out.port > 65535) {
    console.error(`Invalid --port: ${out.port}`);
    Deno.exit(2);
  }
  return out;
}

// ---------- storage ----------

function now(): string {
  // Matches the Python server's format: 2026-10-29T15:02:11+00:00
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function ensureThread(note: Note): Message[] {
  if (Array.isArray(note.thread) && note.thread.length) return note.thread;
  const thread: Message[] = [];
  if (note.text) thread.push({ author: "user", text: note.text, at: note.created ?? "" });
  if (note.response) thread.push({ author: "assistant", text: note.response, at: note.updated ?? "" });
  note.thread = thread;
  return thread;
}

class Store {
  constructor(readonly root: string) {}

  path(doc: string) {
    return `${this.root}/${doc}.annotations.json`;
  }

  // Sync IO on purpose: each request handler runs to completion without
  // yielding, so concurrent requests can't interleave a read-modify-write.
  read(doc: string): Data {
    let raw: string;
    try {
      raw = Deno.readTextFileSync(this.path(doc));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return { doc, notes: [] };
      throw e;
    }
    const data = JSON.parse(raw) as Partial<Data>;
    return { ...data, doc: data.doc ?? doc, notes: data.notes ?? [] } as Data;
  }

  write(doc: string, data: Data) {
    const tmp = `${this.root}/.${doc}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    Deno.writeTextFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    Deno.renameSync(tmp, this.path(doc)); // atomic replace
  }
}

// ---------- http ----------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Private-Network": "true",
};

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) throw new HttpError(413, "bad body size");
  const text = await req.text();
  if (!text || text.length > MAX_BODY) throw new HttpError(413, "bad body size");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "expected a JSON object");
  }
  return body as Record<string, unknown>;
}

function load(store: Store, doc: string): Data {
  try {
    return store.read(doc);
  } catch (e) {
    // Usually the file is mid-edit; the browser retries on its next poll.
    throw new HttpError(503, `could not read annotations: ${(e as Error).message}`);
  }
}

function upsert(store: Store, doc: string, body: Record<string, unknown>): Note {
  if (!ID_RE.test(String(body.id ?? ""))) throw new HttpError(400, "note needs a valid `id`");
  const incoming = Object.fromEntries(Object.entries(body).filter(([k]) => CLIENT_FIELDS.has(k)));
  const data = load(store, doc);
  const notes = data.notes;
  const existing = notes.find((n) => n.id === incoming.id);
  let note: Note;
  if (!existing) {
    const created = now();
    note = {
      num: Math.max(0, ...notes.map((n) => Number(n.num) || 0)) + 1,
      status: "open",
      created,
      ...incoming,
    } as Note;
    note.thread = [{ author: "user", text: String(note.text ?? ""), at: created }];
    notes.push(note);
  } else {
    delete incoming.text; // the original comment is fixed; follow-ups are replies
    Object.assign(existing, incoming);
    note = existing;
    ensureThread(note);
  }
  note.updated = now();
  store.write(doc, data);
  return note;
}

function reply(store: Store, doc: string, id: string, body: Record<string, unknown>): Note {
  const text = String(body.text ?? "").trim();
  if (!text) throw new HttpError(400, "reply needs `text`");
  const data = load(store, doc);
  const note = data.notes.find((n) => n.id === id);
  if (!note) throw new HttpError(404, "no such note");
  ensureThread(note).push({ author: "user", text, at: now() });
  note.status = "open"; // a reply is a new request
  note.updated = now();
  store.write(doc, data);
  return note;
}

function remove(store: Store, doc: string, id: string) {
  const data = load(store, doc);
  const before = data.notes.length;
  data.notes = data.notes.filter((n) => n.id !== id);
  if (data.notes.length !== before) store.write(doc, data);
  return { deleted: id };
}

function makeHandler(store: Store, verbose: boolean) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let res: Response;
    try {
      res = await route(req, url, path);
    } catch (e) {
      res = e instanceof HttpError ? json(e.status, { error: e.message }) : json(500, { error: String(e) });
    }
    if (verbose) console.log(`${req.method} ${url.pathname}${url.search} -> ${res.status}`);
    return res;
  };

  async function route(req: Request, url: URL, path: string): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method === "GET" && path === "/health") return json(200, { ok: true, root: store.root });
    if (path !== "/notes" && path !== "/notes/reply") throw new HttpError(404, "not found");

    const doc = url.searchParams.get("doc") ?? "";
    if (!DOC_RE.test(doc)) throw new HttpError(400, "invalid or missing `doc`");
    const id = url.searchParams.get("id") ?? "";

    if (req.method === "GET" && path === "/notes") {
      const data = load(store, doc);
      data.notes.forEach(ensureThread); // display only; the file is rewritten on the next change
      return json(200, data);
    }
    if (req.method === "POST") {
      const body = await readBody(req); // the only await; storage below is sync
      return json(200, path === "/notes/reply" ? reply(store, doc, id, body) : upsert(store, doc, body));
    }
    if (req.method === "DELETE" && path === "/notes") return json(200, remove(store, doc, id));
    throw new HttpError(405, "method not allowed");
  }
}

// ---------- main ----------

if (import.meta.main) {
  const args = parseArgs(Deno.args);
  const store = new Store(Deno.realPathSync(args.root));
  // No "http://" scheme: Positron and VS Code open localhost URLs printed in a
  // terminal in the Viewer, which would replace the deck preview with this API.
  const addr = `${args.host}:${args.port}`;
  try {
    Deno.serve(
      {
        hostname: args.host,
        port: args.port,
        onListen: () =>
          console.log(`Annotation server on ${addr}, writing to ${store.root}`),
      },
      makeHandler(store, args.verbose),
    );
  } catch (e) {
    if (e instanceof Deno.errors.AddrInUse) {
      // Usually another window already started it. Not an error.
      console.log(`Annotation server already running on ${addr}`);
      Deno.exit(0);
    }
    throw e;
  }
}
