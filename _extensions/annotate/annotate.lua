-- Injects the click-to-annotate overlay into revealjs output.
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
  if not quarto.doc.is_format("revealjs") then
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
    version = "0.1.0",
    scripts = { { path = "annotate.js", afterBody = true } },
    stylesheets = { "annotate.css" },
    meta = {
      ["quarto-annotate-doc"] = doc,
      ["quarto-annotate-server"] = option(opts, "server") or DEFAULT_SERVER,
    },
  })
  return nil
end
