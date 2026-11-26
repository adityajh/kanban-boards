#!/bin/bash
# Why did "a milestone may name a card on this board" return 422 with field=title?
#
#   ADMIN_KEY='…' bash scripts/repro-card-id.sh [base-url]
#
# Self-contained: creates its own board with a plan, does the writes, prints every response
# body in full, then deletes the board. Touches nothing real.
#
# field=title on a PUT is what an EMPTY body produces (title is required and absent), so the
# question is whether the body is arriving at all. Two variants of the same request isolate
# it: one built with double quotes and a shell variable, exactly as the suite does it, and
# one built by printf so the shell never sees a brace. If the first fails and the second
# works it is quoting; if both fail it is the server.
set -u
B="${1:-https://board-iota-nine.vercel.app}"; B="${B%/}"
: "${ADMIN_KEY:?set ADMIN_KEY}"
S=zz-repro-p5
T="X-Tenant: $S"
A="Authorization: Bearer $ADMIN_KEY"
CT="Content-Type: application/json"
jp() { python3 -m json.tool 2>/dev/null || cat; }

curl -s -o /dev/null -X DELETE -H "$A" -H "$CT" $B/api/admin/tenants/$S -d "{\"confirm\":\"$S\"}"
PLAN='{"goal":"repro","metrics":[{"key":"contacted"}],"periods":[],"sections":[]}'
curl -s -o /dev/null -X POST -H "$A" -H "$CT" $B/api/admin/tenants \
  -d "{\"slug\":\"$S\",\"name\":\"ZZ Repro\",\"config\":{\"names\":\"Adi\",\"plan\":$PLAN}}"
CARD=$(curl -s -X POST -H "$A" -H "$T" -H "$CT" $B/api/cards -d '{"title":"zz repro card"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "board $S, card $CARD"
echo

echo "=== 1. no card_id at all — does a plain milestone PUT work? ==="
curl -s -X PUT -H "$A" -H "$T" -H "$CT" $B/api/tracker/milestone/zz-a \
  -d '{"title":"zz plain","date":"2026-12-06"}' | jp
echo

echo "=== 2. card_id, double-quoted with a shell variable (how the suite builds it) ==="
BODY2="{\"title\":\"zz ship it\",\"date\":\"2026-12-06\",\"card_id\":$CARD}"
echo "    sending: $BODY2"
curl -s -X PUT -H "$A" -H "$T" -H "$CT" $B/api/tracker/milestone/zz-b -d "$BODY2" | jp
echo

echo "=== 3. the same JSON, built by printf so the shell never quotes a brace ==="
BODY3=$(printf '{"title":"zz ship it","date":"2026-12-06","card_id":%d}' "$CARD")
echo "    sending: $BODY3"
curl -s -X PUT -H "$A" -H "$T" -H "$CT" $B/api/tracker/milestone/zz-c --data-binary "$BODY3" | jp
echo

echo "=== 4. card_id as a literal, no variable anywhere ==="
curl -s -X PUT -H "$A" -H "$T" -H "$CT" $B/api/tracker/milestone/zz-d \
  -d '{"title":"zz literal","date":"2026-12-06","card_id":1}' | jp
echo

echo "=== 5. is card_id even accepted on a milestone by the DEPLOYED code? ==="
echo "    (an unknown field answers 422 with field=card_id; an absent card answers 422 too,"
echo "     but with a different message — the message is what tells them apart)"
curl -s -X PUT -H "$A" -H "$T" -H "$CT" $B/api/tracker/milestone/zz-e \
  -d '{"title":"zz nine","date":"2026-12-06","card_id":99999999}' | jp
echo

echo "=== 6. does the deployed build have the stale flag? ==="
curl -s -H "$A" -H "$T" $B/api/tracker/milestone/zz-a | jp
echo

echo "=== cleanup ==="
curl -s -X DELETE -H "$A" -H "$CT" $B/api/admin/tenants/$S -d "{\"confirm\":\"$S\"}" | jp
