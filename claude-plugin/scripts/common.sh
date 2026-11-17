# Shared by the SessionStart and SessionEnd hooks. Sourced, not run.

PORT_BASE=4850
PORT_SPAN=100

# Hook input arrives as JSON on stdin; pull one string field out of it.
json_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1
}

# State lives outside the plugin folder, which is replaced on update.
state_dir() {
  local d="${CLAUDE_PLUGIN_DATA:-${XDG_CACHE_HOME:-$HOME/.cache}/quarto-annotate-claude}/servers"
  mkdir -p "$d" && printf '%s' "$d"
}

# FNV-1a over the path, the same default port the Positron/VS Code extension
# picks for a folder, so both find (and share) one server.
hash_port() {
  local s="$1" h=2166136261 i c
  for ((i = 0; i < ${#s}; i++)); do
    printf -v c '%d' "'${s:i:1}"
    h=$(((h ^ (c & 0xFFFF)) * 16777619 & 0xFFFFFFFF))
  done
  printf '%d' $((PORT_BASE + h % PORT_SPAN))
}

# Prints the server's root if something answers /health on the port as an
# annotate server, "foreign" if something else holds it, nothing if it's free.
probe() {
  local body
  body=$(curl -s --max-time 1 "http://127.0.0.1:$1/health" 2>/dev/null)
  local rc=$?
  if [ $rc -eq 7 ]; then return 0; fi # connection refused: free
  local root
  root=$(json_field "$body" root)
  if [ -n "$root" ]; then printf '%s' "$root"; else printf 'foreign'; fi
}
