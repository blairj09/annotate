#!/usr/bin/env bash
# SessionStart hook: if this project has the annotate Quarto extension, make
# sure a notes server is running for it and tell Claude (and the shell Claude
# uses) where it is. Stays silent in projects without the extension.
set -u
. "$(dirname "$0")/common.sh"

input=$(cat)
session=$(json_field "$input" session_id)
dir="${CLAUDE_PROJECT_DIR:-$(json_field "$input" cwd)}"
[ -n "$dir" ] && [ -d "$dir" ] || exit 0
root=$(cd "$dir" && pwd -P) || exit 0

server_ts=$(find "$root" -maxdepth 6 \
  \( -name node_modules -o -name renv -o -name .venv -o -name .git -o -name .quarto \) -prune -o \
  -path '*/_extensions/*annotate/server.ts' -print 2>/dev/null | head -n 1)
[ -n "$server_ts" ] || exit 0

if command -v quarto >/dev/null 2>&1; then
  quarto=quarto
elif [ -x /Applications/quarto/bin/quarto ]; then
  quarto=/Applications/quarto/bin/quarto
else
  echo "This project uses the annotate Quarto extension, but quarto isn't on PATH, so the notes server didn't start."
  exit 0
fi

# Try 4850 first (what the filter uses when nothing tells it otherwise), then
# the folder's hashed port. Reuse a server already running for this folder.
first=$(hash_port "$root")
ports=(4850)
for ((i = 0; i < 20; i++)); do
  p=$((PORT_BASE + (first - PORT_BASE + i) % PORT_SPAN))
  [ "$p" -ne 4850 ] && ports+=("$p")
done

port="" free="" started=""
for p in "${ports[@]}"; do
  r=$(probe "$p")
  if [ -z "$r" ]; then
    [ -z "$free" ] && free=$p
  elif [ "$r" = "$root" ]; then
    port=$p
    break
  fi
done

state=$(state_dir)
if [ -z "$port" ] && [ -n "$free" ]; then
  log="$state/$free.log"
  nohup "$quarto" run "$server_ts" "$root" --port "$free" >"$log" 2>&1 </dev/null &
  pid=$!
  for ((i = 0; i < 50; i++)); do
    [ "$(probe "$free")" = "$root" ] && { port=$free; break; }
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if [ -n "$port" ]; then
    echo "$pid" >"$state/$port.pid"
    printf '%s\n' "$root" >"$state/$port.root"
    started=1
  else
    kill "$pid" 2>/dev/null
    echo "The annotate notes server didn't start. Its log is at $log."
    exit 0
  fi
fi
[ -n "$port" ] || { echo "No free port for the annotate notes server (tried ${ports[*]})."; exit 0; }

# Count sessions using the server, so SessionEnd only stops it after the last one.
[ -n "$session" ] && { grep -qxF "$session" "$state/$port.sessions" 2>/dev/null || echo "$session" >>"$state/$port.sessions"; }

url="http://127.0.0.1:$port"
# Previews Claude starts from its shell find the server and name documents by
# their path from the project root.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export QUARTO_ANNOTATE_SERVER=$url"
    echo "export QUARTO_ANNOTATE_ROOT='$root'"
  } >>"$CLAUDE_ENV_FILE"
fi

echo "Quarto annotate: the notes server for this project is ${started:+now }running at $url, saving notes to <doc>.annotations.json next to each .qmd."
echo "When the user asks to resolve, address, or look at their annotations or notes, use the /annotate skill."
if [ "$port" != 4850 ]; then
  echo "It isn't on the default port 4850, so a preview started outside your shell needs \`annotate: {server: $url}\` in the front matter or QUARTO_ANNOTATE_SERVER=$url in its environment."
fi
exit 0
