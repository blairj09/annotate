-- Injects the click-to-annotate overlay into revealjs and other HTML output.
-- The overlay itself only activates when the deck is served from localhost,
-- so a shipped self-contained file stays inert.

local DEFAULT_SERVER = "http://127.0.0.1:4850"

local function option(opts, key)
  if type(opts) ~= "table" or opts[key] == nil then
    return nil
  end
  local value = opts[key]
  if type(value) == "boolean" then
    return value
  end
  return pandoc.utils.stringify(value)
end

local function norm(p)
  p = p:gsub("\\", "/")
  p = p:gsub("/+$", "")
  return p
end

-- The notes server's name for this document: the file stem, or, when the editor
-- extension runs one server for the whole workspace folder (QUARTO_ANNOTATE_ROOT),
-- the stem's path relative to that folder, e.g. "customers/danone/deck".
local function doc_name(input)
  local stem = pandoc.path.split_extension(pandoc.path.filename(input))
  local root = os.getenv("QUARTO_ANNOTATE_ROOT")
  if not root or root == "" or input == "" then
    return stem
  end
  root = norm(root)
  local dir = norm(pandoc.path.directory(input))
  local a, b = dir, root
  if pandoc.system.os ~= "linux" then
    -- macOS and Windows paths are case-insensitive.
    a, b = dir:lower(), root:lower()
  end
  if a == b then
    return stem
  end
  if a:sub(1, #b + 1) ~= b .. "/" then
    return stem -- outside the workspace folder
  end
  return dir:sub(#root + 2) .. "/" .. stem
end

function Meta(meta)
  -- is_format("html") is also true for revealjs, so check slides first.
  local slides = quarto.doc.is_format("revealjs")
  if not (slides or quarto.doc.is_format("html")) then
    return nil
  end

  local opts = meta.annotate
  if opts == false or option(opts, "enabled") == false then
    return nil
  end

  local input = quarto.doc.input_file or ""
  local doc = doc_name(input)

  quarto.doc.add_html_dependency({
    name = "quarto-annotate",
    version = "0.3.0",
    scripts = { { path = "annotate.js", afterBody = true } },
    stylesheets = { "annotate.css" },
    meta = {
      ["quarto-annotate-doc"] = doc,
      -- The editor extension sets QUARTO_ANNOTATE_SERVER in new terminals, so
      -- previews it starts find the server it picked for this folder.
      ["quarto-annotate-server"] = option(opts, "server")
        or os.getenv("QUARTO_ANNOTATE_SERVER")
        or DEFAULT_SERVER,
      ["quarto-annotate-mode"] = slides and "slides" or "document",
    },
  })
  return nil
end
