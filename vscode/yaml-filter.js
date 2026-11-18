// Adds `annotate` to the top-level `filters` of a YAML file or a .qmd's front
// matter by editing text, so comments and formatting are left alone.
"use strict";

const FILTER = "annotate";

const unquote = (s) => s.trim().replace(/^(['"])(.*)\1$/, "$2");
const stripComment = (s) => s.replace(/\s+#.*$/, "");

// `yaml` is the YAML text without `---` delimiters. Returns {text, changed}.
function addFilter(yaml, eol = "\n") {
  const lines = yaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^filters\s*:/.test(l));

  if (at < 0) {
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    lines.push("filters:", `  - ${FILTER}`);
    return { text: lines.join(eol) + eol, changed: true };
  }

  const rest = stripComment(lines[at].replace(/^filters\s*:/, "")).trim();

  // Flow list: filters: [a, b]
  if (rest.startsWith("[")) {
    const inner = rest.replace(/^\[|\]$/g, "").trim();
    const items = inner ? inner.split(",").map((s) => s.trim()) : [];
    if (items.some((s) => unquote(s) === FILTER)) return { text: yaml, changed: false };
    items.push(FILTER);
    lines[at] = `filters: [${items.join(", ")}]`;
    return { text: lines.join(eol), changed: true };
  }

  // A single scalar: filters: foo
  if (rest) {
    if (unquote(rest) === FILTER) return { text: yaml, changed: false };
    lines[at] = `filters: [${rest}, ${FILTER}]`;
    return { text: lines.join(eol), changed: true };
  }

  // Block list. Items may be unindented ("- a") or indented ("  - a"), and an
  // item may be a mapping ("- path: x.lua") that continues on indented lines.
  let last = at;
  let indent = null;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "" || /^\s*#/.test(l)) continue;
    const item = l.match(/^(\s*)-\s*(.*)$/);
    if (item) {
      if (indent === null) indent = item[1];
      if (unquote(stripComment(item[2])) === FILTER) return { text: yaml, changed: false };
      last = i;
    } else if (/^\s/.test(l)) {
      last = i;
    } else {
      break;
    }
  }
  lines.splice(last + 1, 0, `${indent ?? "  "}- ${FILTER}`);
  return { text: lines.join(eol), changed: true };
}

const FRONT_MATTER = /^(\uFEFF?---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

// Whole .qmd text in, whole .qmd text out.
function addFilterToQmd(text) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const m = text.match(FRONT_MATTER);
  if (!m) {
    return { text: `---${eol}filters:${eol}  - ${FILTER}${eol}---${eol}${eol}` + text, changed: true };
  }
  const res = addFilter(m[2], eol);
  if (!res.changed) return { text, changed: false };
  const body = res.text.replace(/\r?\n$/, "");
  return { text: m[1] + body + m[3] + text.slice(m[0].length), changed: true };
}

// True when the .qmd's front matter has its own top-level `filters`.
function qmdHasFilters(text) {
  const m = text.match(FRONT_MATTER);
  return !!m && /^filters\s*:/m.test(m[2]);
}

module.exports = { addFilter, addFilterToQmd, qmdHasFilters };
