#!/bin/bash
# Create the first users on a board, using ADMIN_KEY. Run once per board after
# migration 003. Passwords are generated server-side and printed here exactly once —
# copy them into ~/Documents/Claude/Credentials/kanban-boards.env before you lose them.
#
#   scripts/seed-users.sh <base-url> <slug> <admin-name> [other names...]
#
# e.g.  scripts/seed-users.sh https://board-iota-nine.vercel.app inditress Adi Aadhya Deepak
#       scripts/seed-users.sh https://board-iota-nine.vercel.app jbj Adi Rahul
#
# Needs ADMIN_KEY in the environment. Safe to re-run: an existing username is reported
# as already present and left alone.
set -u
B="${1:?base url}"; SLUG="${2:?board slug}"; shift 2
[ $# -gt 0 ] || { echo "give at least one name (the first becomes the board admin)"; exit 1; }
[ -n "${ADMIN_KEY:-}" ] || { echo "ADMIN_KEY is not set"; exit 1; }

ADM="Authorization: Bearer $ADMIN_KEY"
TEN="X-Tenant: $SLUG"
CT="Content-Type: application/json"
first=1

for name in "$@"; do
  # Usernames are lowercased display names with anything unusable stripped ("Mary Jane" ->
  # "maryjane"); the display name is kept as given so existing card assignees and note
  # authors still line up.
  user=$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-')
  if [ $first -eq 1 ]; then admin=true; else admin=false; fi
  body="{\"username\":\"$user\",\"displayName\":\"$name\",\"isAdmin\":$admin}"
  out=$(curl -s -X POST -H "$ADM" -H "$TEN" -H "$CT" -d "$body" "$B/api/settings/users")
  pw=$(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("password",""))' 2>/dev/null)
  if [ -n "$pw" ]; then
    if [ $first -eq 1 ]; then role="admin"; else role="member"; fi
    printf '%-10s %-10s %-8s %s\n' "$name" "@$user" "$role" "$pw"
  else
    echo "$name (@$user): $(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error","?"))' 2>/dev/null)"
  fi
  first=0
done

echo
echo "Each person is asked to change their password the first time they sign in."
