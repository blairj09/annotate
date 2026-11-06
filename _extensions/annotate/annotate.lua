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
  local doc = pandoc.path.split_extension(pandoc.path.filename(input))

  quarto.doc.add_html_dependency({
    name = "quarto-annotate",
    version = "0.2.0",
    scripts = { { path = "annotate.js", afterBody = true } },
    stylesheets = { "annotate.css" },
    meta = {
      ["quarto-annotate-doc"] = doc,
      ["quarto-annotate-server"] = option(opts, "server") or DEFAULT_SERVER,
      ["quarto-annotate-mode"] = slides and "slides" or "document",
    },
  })
  return nil
end
