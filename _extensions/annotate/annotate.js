/* Quarto annotate: click-to-annotate overlay for revealjs previews.
 *
 * Press A (or the HUD button) to enter annotate mode, click anywhere on a
 * slide, and type a note. Notes go to the local notes server, which writes
 * <doc>.annotations.json next to the source. Falls back to localStorage when
 * the server isn't running.
 */
(function () {
  "use strict";

  const params = new URLSearchParams(location.search);
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // Skip shipped files, PDF export, and the speaker-view iframes.
  if (!(isLocal || params.has("annotate")) || params.has("print-pdf") || params.has("receiver")) {
    return;
  }

  const metaContent = (name) => {
    const el = document.querySelector(`meta[name="${name}"]`);
    return el ? el.getAttribute("content") : null;
  };

  const DOC =
    metaContent("quarto-annotate-doc") ||
    decodeURIComponent(location.pathname.split("/").pop() || "").replace(/\.html?$/i, "") ||
    "deck";
  const SERVER = (metaContent("quarto-annotate-server") || "http://127.0.0.1:4850").replace(/\/+$/, "");
  const STORE_KEY = "quarto-annotate:" + DOC;
  const MODE_KEY = "quarto-annotate-active:" + DOC;
  const POLL_MS = 3000;
  const CLIENT_FIELDS = ["id", "slide", "x", "y", "target", "text", "created", "updated"];

  const state = {
    deck: null,
    notes: [],
    pending: new Set(),
    deleted: new Set(),
    replies: [], // [{id, text}] waiting to be sent
    online: null,
    active: false,
    editor: null,
    listOpen: false,
    syncing: false,
    renderSig: "",
    hoverEl: null,
  };
  const ui = {};

  // ---------- helpers ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
    return Math.random().toString(16).slice(2, 10);
  }

  const clamp = (v) => Math.min(100, Math.max(0, v));
  const round1 = (v) => Math.round(v * 10) / 10;

  function snippet(text, n) {
    const s = (text || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // Older notes have only `text` + `response`; show them as a thread too.
  function threadOf(note) {
    if (Array.isArray(note.thread) && note.thread.length) return note.thread;
    const t = [];
    if (note.text) t.push({ author: "user", text: note.text, at: note.created });
    if (note.response) t.push({ author: "assistant", text: note.response, at: note.updated });
    return t;
  }

  function lastOf(note, author) {
    const t = threadOf(note);
    for (let i = t.length - 1; i >= 0; i--) if (!author || t[i].author === author) return t[i];
    return null;
  }

  function when(at) {
    const d = at ? new Date(at) : null;
    if (!d || isNaN(d)) return "";
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  function slideLabel(slide) {
    if (!slide) return "Slide ?";
    return "Slide " + slide.number + (slide.title ? ` · ${snippet(slide.title, 40)}` : "");
  }

  // ---------- persistence ----------

  function persist() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          notes: state.notes,
          pending: [...state.pending],
          deleted: [...state.deleted],
          replies: state.replies,
        })
      );
    } catch (e) {
      /* storage may be unavailable in some webviews */
    }
  }

  function restore() {
    try {
      const data = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      state.notes = data.notes || [];
      state.pending = new Set(data.pending || []);
      state.deleted = new Set(data.deleted || []);
      state.replies = data.replies || [];
    } catch (e) {
      /* ignore corrupt cache */
    }
  }

  async function api(method, query, body, path) {
    const url = new URL(SERVER + (path || "/notes"));
    url.searchParams.set("doc", DOC);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    try {
      const res = await fetch(url, {
        method,
        signal: ctrl.signal,
        cache: "no-store",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function clientPayload(note) {
    const out = {};
    for (const k of CLIENT_FIELDS) if (note[k] !== undefined) out[k] = note[k];
    if (note._sendStatus) out.status = note.status;
    return out;
  }

  async function sync() {
    if (state.syncing) return;
    state.syncing = true;
    try {
      for (const id of [...state.deleted]) {
        await api("DELETE", { id });
        state.deleted.delete(id);
      }
      for (const id of [...state.pending]) {
        const note = state.notes.find((n) => n.id === id);
        if (note) await api("POST", null, clientPayload(note));
        state.pending.delete(id);
      }
      while (state.replies.length) {
        const r = state.replies[0];
        await api("POST", { id: r.id }, { text: r.text }, "/notes/reply");
        state.replies.shift();
      }
      const data = await api("GET");
      setOnline(true);
      // Don't swap data out from under an open editor; the next poll catches up.
      if (!state.editor) state.notes = data.notes || [];
    } catch (e) {
      setOnline(false);
    } finally {
      state.syncing = false;
      persist();
      render();
    }
  }

  async function upsert(note) {
    note.updated = new Date().toISOString();
    const i = state.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) state.notes[i] = note;
    else state.notes.push(note);
    state.pending.add(note.id);
    persist();
    render(true);
    await sync();
  }

  async function reply(note, text) {
    const now = new Date().toISOString();
    const updated = Object.assign({}, note, {
      thread: threadOf(note).concat([{ author: "user", text, at: now }]),
      status: "open",
      updated: now,
    });
    const i = state.notes.findIndex((n) => n.id === note.id);
    if (i >= 0) state.notes[i] = updated;
    state.replies.push({ id: note.id, text });
    persist();
    render(true);
    await sync();
  }

  async function remove(id) {
    state.notes = state.notes.filter((n) => n.id !== id);
    state.pending.delete(id);
    state.deleted.add(id);
    persist();
    render(true);
    await sync();
  }

  // ---------- slide + target info ----------

  function slideInfo() {
    const deck = state.deck;
    const slide = deck.getCurrentSlide();
    const idx = deck.getIndices();
    const heading = slide.querySelector("h1, h2, h3");
    return {
      number: deck.getSlidePastCount() + 1,
      h: idx.h,
      v: idx.v || 0,
      f: idx.f == null ? undefined : idx.f,
      id: slide.id || undefined,
      title: heading ? snippet(heading.textContent, 120) : "",
    };
  }

  // Quarto gives untitled slides ids like "section-3"; those shift when slides
  // move, so fall back to indices for them.
  const stableId = (id) => id && !/^section(-\d+)?$/.test(id);

  function notesForCurrentSlide() {
    const slide = state.deck.getCurrentSlide();
    const idx = state.deck.getIndices();
    return state.notes.filter((n) => {
      if (!n.slide) return false;
      if (stableId(slide.id) && stableId(n.slide.id)) return n.slide.id === slide.id;
      return n.slide.h === idx.h && (n.slide.v || 0) === (idx.v || 0);
    });
  }

  function elementAt(cx, cy) {
    const slide = state.deck.getCurrentSlide();
    ui.layer.style.pointerEvents = "none";
    let hits;
    try {
      hits = document.elementsFromPoint(cx, cy);
    } finally {
      ui.layer.style.pointerEvents = "";
    }
    const hit = hits.find((e) => e !== slide && slide.contains(e));
    if (!hit) return null;
    return hit.closest("li, p, h1, h2, h3, h4, h5, h6, td, th, figcaption, blockquote, pre, img, video, svg") || hit;
  }

  function describe(node) {
    if (!node) return { tag: "slide", text: "" };
    const out = { tag: node.tagName.toLowerCase() };
    const classes = [...node.classList].filter((c) => !c.startsWith("qa-"));
    if (classes.length) out.classes = classes.join(" ");
    if (node.id) out.id = node.id;
    const src = node.currentSrc || node.getAttribute("src");
    if (src && !src.startsWith("data:")) out.src = src.split("/").pop();
    if (node.getAttribute("alt")) out.alt = node.getAttribute("alt");
    out.text = snippet(node.innerText || node.textContent, 200);
    return out;
  }

  function describeTargetShort(t) {
    if (!t || t.tag === "slide") return "on the slide background";
    const what = t.text || t.alt || t.src || "";
    return `<${t.tag}>` + (what ? ` "${snippet(what, 60)}"` : "");
  }

  // ---------- rendering ----------

  function setOnline(on) {
    state.online = on;
    if (!ui.dot) return;
    ui.dot.className = "qa-dot " + (on ? "qa-online" : "qa-offline");
    ui.dot.title = on
      ? `Saving to ${DOC}.annotations.json`
      : `Notes server not reachable at ${SERVER}. Notes are kept in this browser until it is.\n` +
        "Start it from the project folder with: quarto run _extensions/<owner>/annotate/server.ts";
  }

  function render(force) {
    if (!state.deck) return;
    const idx = state.deck.getIndices();
    const sig = JSON.stringify([state.notes, idx.h, idx.v, state.listOpen]);
    if (!force && sig === state.renderSig) return;
    state.renderSig = sig;

    ui.layer.replaceChildren();
    for (const note of notesForCurrentSlide()) {
      const done = note.status === "done";
      const pin = el("button", "qa-pin " + (done ? "qa-done" : "qa-open"), done ? "✓" : String(note.num || "•"));
      pin.style.left = note.x + "%";
      pin.style.top = note.y + "%";
      const last = lastOf(note);
      pin.title =
        (note.num ? `#${note.num}: ` : "") +
        (last ? (last.author === "assistant" ? "Assistant: " : "") + snippet(last.text, 200) : "");
      pin.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openEditor(note, pin.getBoundingClientRect(), false);
      });
      ui.layer.appendChild(pin);
    }
    if (state.editor && state.editor.isNew) ui.layer.appendChild(state.editor.ghost);

    const open = state.notes.filter((n) => n.status !== "done").length;
    ui.count.textContent = `${open} open`;
    ui.count.title = `${state.notes.length} total on this deck`;
    if (state.listOpen) renderList();
  }

  function renderList() {
    ui.list.replaceChildren();
    const sorted = [...state.notes].sort(
      (a, b) => (a.slide?.number || 0) - (b.slide?.number || 0) || (a.y || 0) - (b.y || 0)
    );
    if (!sorted.length) {
      ui.list.appendChild(el("div", "qa-empty", "No notes yet. Press A, then click a slide."));
      return;
    }
    for (const note of sorted) {
      const item = el("div", "qa-item" + (note.status === "done" ? " qa-done" : ""));
      const status = note.status === "done" ? "done" : "open";
      item.appendChild(el("div", "qa-meta", `#${note.num || "?"} · ${slideLabel(note.slide)} · ${status}`));
      const ask = lastOf(note, "user");
      const last = lastOf(note);
      item.appendChild(el("div", null, snippet(ask ? ask.text : note.text, 140)));
      if (last && last.author === "assistant") item.appendChild(el("div", "qa-meta", "↳ " + snippet(last.text, 140)));
      item.addEventListener("click", () => {
        state.deck.slide(note.slide.h, note.slide.v || 0);
        toggleList(false);
      });
      ui.list.appendChild(item);
    }
  }

  function toggleList(force) {
    state.listOpen = force == null ? !state.listOpen : force;
    ui.list.style.display = state.listOpen ? "block" : "none";
    render(true);
  }

  // ---------- editor ----------

  function closeEditor() {
    if (!state.editor) return;
    state.editor.box.remove();
    state.editor.ghost?.remove();
    state.editor = null;
    render(true);
  }

  function openEditor(note, anchor, isNew) {
    closeEditor();
    setHover(null);
    const box = el("div", "qa-editor");
    box.appendChild(el("div", "qa-head", (isNew ? "New note" : `Note #${note.num || "?"}`) + " · " + slideLabel(note.slide)));
    box.appendChild(el("div", "qa-target", describeTargetShort(note.target)));

    if (!isNew) {
      const thread = el("div", "qa-thread");
      for (const msg of threadOf(note)) {
        const mine = msg.author !== "assistant";
        const m = el("div", "qa-msg " + (mine ? "qa-user" : "qa-assistant"));
        const who = el("div", "qa-who", mine ? "You" : "Assistant");
        const t = when(msg.at);
        if (t) who.appendChild(el("span", "qa-when", " · " + t));
        m.append(who, el("div", "qa-text", msg.text));
        thread.appendChild(m);
      }
      const status = note.status === "done" ? "Resolved" : "Open";
      thread.appendChild(el("div", "qa-status qa-status-" + (note.status === "done" ? "done" : "open"), status));
      box.appendChild(thread);
      // Show the latest message without scrolling.
      requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
    }

    const textarea = el("textarea");
    textarea.placeholder = isNew ? "Describe the change you want…" : "Reply…";
    if (!isNew) textarea.rows = 2;
    box.appendChild(textarea);

    const row = el("div", "qa-row");
    if (!isNew) {
      const del = el("button", "qa-danger", "Delete");
      del.title = "Delete this note and its thread";
      del.addEventListener("click", () => {
        closeEditor();
        remove(note.id);
      });
      const done = note.status === "done";
      const toggle = el("button", null, done ? "Reopen" : "Resolve");
      toggle.addEventListener("click", () => {
        closeEditor();
        upsert(Object.assign({}, note, { status: done ? "open" : "done", _sendStatus: true }));
      });
      row.append(del, toggle);
    }
    row.appendChild(el("span", "qa-spacer"));
    const cancel = el("button", null, isNew ? "Cancel" : "Close");
    cancel.addEventListener("click", closeEditor);
    const save = el("button", "qa-primary", isNew ? "Save" : "Reply");
    save.title = "⌘/Ctrl + Enter";
    const doSave = () => {
      const text = textarea.value.trim();
      if (!text) return closeEditor();
      closeEditor();
      if (isNew) {
        const now = new Date().toISOString();
        upsert(Object.assign({}, note, { text, thread: [{ author: "user", text, at: now }] }));
      } else {
        reply(note, text);
      }
    };
    save.addEventListener("click", doSave);
    row.append(cancel, save);
    box.appendChild(row);

    // Keep Reveal from seeing keystrokes typed into the editor.
    box.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") closeEditor();
      else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) doSave();
    });

    let ghost = null;
    if (isNew) {
      ghost = el("div", "qa-pin qa-ghost", "+");
      ghost.style.left = note.x + "%";
      ghost.style.top = note.y + "%";
      ui.layer.appendChild(ghost);
    }

    document.body.appendChild(box);
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    box.style.left = Math.max(8, Math.min(anchor.left + 16, innerWidth - w - 8)) + "px";
    box.style.top = Math.max(8, Math.min(anchor.top + 16, innerHeight - h - 8)) + "px";
    state.editor = { box, note, isNew, ghost };
    textarea.focus();
  }

  // ---------- annotate mode ----------

  function setHover(node) {
    if (state.hoverEl === node) return;
    state.hoverEl?.classList.remove("qa-hover");
    state.hoverEl = node;
    node?.classList.add("qa-hover");
  }

  function setActive(on) {
    state.active = on;
    ui.layer.classList.toggle("qa-capturing", on);
    ui.toggle.setAttribute("aria-pressed", String(on));
    ui.hud.classList.toggle("qa-on", on);
    if (!on) setHover(null);
    try {
      sessionStorage.setItem(MODE_KEY, on ? "1" : "0");
    } catch (e) {
      /* ignore */
    }
  }

  function onLayerClick(ev) {
    if (!state.active || ev.target !== ui.layer) return;
    if (state.editor) return closeEditor();
    const r = ui.layer.getBoundingClientRect();
    const note = {
      id: uid(),
      slide: slideInfo(),
      x: round1(clamp(((ev.clientX - r.left) / r.width) * 100)),
      y: round1(clamp(((ev.clientY - r.top) / r.height) * 100)),
      target: describe(elementAt(ev.clientX, ev.clientY)),
      text: "",
      status: "open",
      created: new Date().toISOString(),
    };
    openEditor(note, { left: ev.clientX, top: ev.clientY }, true);
  }

  let hoverFrame = 0;
  function onLayerMove(ev) {
    if (!state.active || state.editor || hoverFrame) return;
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0;
      setHover(elementAt(ev.clientX, ev.clientY));
    });
  }

  // ---------- export ----------

  function asMarkdown() {
    const open = state.notes.filter((n) => n.status !== "done");
    const lines = [`Slide annotations for ${DOC}.qmd (${open.length} open):`, ""];
    for (const n of open) {
      lines.push(
        `- #${n.num || "?"} ${slideLabel(n.slide)}, ${describeTargetShort(n.target)} ` + `(x ${n.x}%, y ${n.y}%):`
      );
      for (const m of threadOf(n)) lines.push(`  - ${m.author === "assistant" ? "Assistant" : "User"}: ${m.text}`);
    }
    return lines.join("\n");
  }

  async function copyNotes() {
    const text = asMarkdown();
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = el("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch (e2) {
        ok = false;
      }
      ta.remove();
    }
    ui.copy.textContent = ok ? "Copied" : "Copy failed";
    setTimeout(() => (ui.copy.textContent = "Copy"), 1500);
  }

  // ---------- setup ----------

  function buildUI() {
    ui.layer = el("div", "qa-layer");
    state.deck.getSlidesElement().appendChild(ui.layer);
    ui.layer.addEventListener("click", onLayerClick);
    ui.layer.addEventListener("mousemove", onLayerMove);
    ui.layer.addEventListener("mouseleave", () => setHover(null));

    ui.hud = el("div", "qa-hud");
    ui.toggle = el("button", "qa-toggle", "Annotate");
    ui.toggle.title = "Toggle annotate mode (A)";
    ui.toggle.addEventListener("click", () => setActive(!state.active));
    ui.dot = el("span", "qa-dot");
    ui.count = el("span", "qa-count", "0 open");
    const listBtn = el("button", null, "List");
    listBtn.addEventListener("click", () => toggleList());
    ui.copy = el("button", null, "Copy");
    ui.copy.title = "Copy open notes as Markdown (to paste into chat)";
    ui.copy.addEventListener("click", copyNotes);
    ui.hud.append(ui.toggle, ui.dot, ui.count, listBtn, ui.copy);
    ui.list = el("div", "qa-list");
    ui.list.style.display = "none";
    document.body.append(ui.hud, ui.list);
  }

  function setScale(scale) {
    if (scale > 0) ui.layer.style.setProperty("--qa-inv", String(1 / scale));
  }

  function start(deck) {
    state.deck = deck;
    restore();
    buildUI();
    setScale(deck.getScale());
    setOnline(false);

    deck.addKeyBinding({ keyCode: 65, key: "A", description: "Toggle annotate mode" }, () => setActive(!state.active));
    deck.on("slidechanged", () => {
      closeEditor();
      render(true);
    });
    deck.on("resize", (ev) => setScale(ev.scale));
    deck.on("overviewshown", closeEditor);

    try {
      setActive(sessionStorage.getItem(MODE_KEY) === "1");
    } catch (e) {
      setActive(false);
    }
    render(true);
    sync();
    setInterval(() => {
      if (!document.hidden) sync();
    }, POLL_MS);
  }

  function boot(tries) {
    const deck = window.Reveal;
    if (!deck || typeof deck.on !== "function") {
      if (tries < 100) setTimeout(() => boot(tries + 1), 100);
      return;
    }
    if (deck.isReady && deck.isReady()) start(deck);
    else deck.on("ready", () => start(deck));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => boot(0));
  } else {
    boot(0);
  }
})();
