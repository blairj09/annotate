#!/usr/bin/env bash
# SessionEnd hook: drop this session from every server it was using, and stop
# servers this plugin started once no session uses them. Servers started some
# other way (the editor extension, a terminal) are never stopped here.
set -u
. "$(dirname "$0")/common.sh"

input=$(cat)
session=$(json_field "$input" session_id)
[ -n "$session" ] || exit 0
state=$(state_dir)

for f in "$state"/*.sessions; do
  [ -e "$f" ] || continue
  grep -qxF "$session" "$f" || continue
  grep -vxF "$session" "$f" >"$f.tmp"
  mv "$f.tmp" "$f"
  [ -s "$f" ] && continue

  port=$(basename "$f" .sessions)
  rm -f "$f"
  pidfile="$state/$port.pid"
  [ -e "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  # Only stop it if the port still holds the server we started for that folder.
  if [ "$(probe "$port")" = "$(cat "$state/$port.root" 2>/dev/null)" ]; then
    pkill -P "$pid" 2>/dev/null # quarto run is a wrapper; its deno child serves the port
    kill "$pid" 2>/dev/null
  fi
  rm -f "$pidfile" "$state/$port.root"
done
exit 0
