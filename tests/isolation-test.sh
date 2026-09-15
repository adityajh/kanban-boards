#!/bin/bash
# Tenant-isolation + regression checks for kanban-boards. Usage: isolation-test.sh <base-url>
# Needs INDITRESS_PASSPHRASE, JBJ_PASSPHRASE, ADMIN_KEY in the environment.
B="${1:-http://localhost:3100}"
PASS=0; FAIL=0
IND="Authorization: Bearer $INDITRESS_PASSPHRASE"
JBJ="Authorization: Bearer $JBJ_PASSPHRASE"
ADM="Authorization: Bearer $ADMIN_KEY"
CT="Content-Type: application/json"

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected $2, got $3)"; fi
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

echo "== auth"
check "no key -> 401" 401 "$(code $B/api/cards)"
check "wrong key -> 401" 401 "$(code -H 'Authorization: Bearer nope-nope-nope' $B/api/cards)"
check "inditress /tenant slug" inditress "$(curl -s -H "$IND" $B/api/tenant | jget 'd["slug"]')"
check "admin w/o X-Tenant on board route -> 400" 400 "$(code -H "$ADM" $B/api/cards)"
check "tenant key ignores X-Tenant" inditress "$(curl -s -H "$IND" -H 'X-Tenant: jbj' $B/api/tenant | jget 'd["slug"]')"
check "tenant key cannot use admin API" 401 "$(code -H "$IND" $B/api/admin/overview)"

echo "== inditress data intact"
IC=$(curl -s -H "$IND" $B/api/cards)
check "inditress card count" "${EXPECT_IND_CARDS:-16}" "$(echo "$IC" | jget 'len(d)')"
check "no tenant_id leaked in cards" False "$(echo "$IC" | jget '"tenant_id" in d[0]')"
check "inditress resources" 3 "$(curl -s -H "$IND" $B/api/resources | jget 'len(d)')"
IND_CARD=$(echo "$IC" | jget '[c for c in d if c["subtasks"] and c["links"] and c["notes"]][0]["id"]')
IND_SUB=$(echo "$IC" | jget "[c for c in d if c['id']==$IND_CARD][0]['subtasks'][0]['id']")
IND_LINK=$(echo "$IC" | jget "[c for c in d if c['id']==$IND_CARD][0]['links'][0]['id']")
IND_NOTE=$(echo "$IC" | jget "[c for c in d if c['id']==$IND_CARD][0]['notes'][0]['id']")
IND_RES=$(curl -s -H "$IND" $B/api/resources | jget 'd[0]["id"]')
echo "  (inditress card $IND_CARD, subtask $IND_SUB, link $IND_LINK, note $IND_NOTE, resource $IND_RES)"

echo "== jbj board"
if [ "$(code -H "$JBJ" $B/api/tenant)" != 200 ]; then
  BODY="{\"slug\":\"jbj\",\"name\":\"JBJ Jeweller\",\"passphrase\":\"$JBJ_PASSPHRASE\",\"config\":{\"brand\":\"JBJ Jeweller\",\"names\":\"Adi, Rahul\",\"accent\":\"#9C7A3C\"}}"
  check "admin creates jbj" 201 "$(code -X POST -H "$ADM" -H "$CT" -d "$BODY" $B/api/admin/tenants)"
fi
check "duplicate slug -> 409" 409 "$(code -X POST -H "$ADM" -H "$CT" $B/api/admin/tenants -d '{"slug":"inditress","name":"x","config":{"names":"a"}}')"
check "reserved slug -> 400" 400 "$(code -X POST -H "$ADM" -H "$CT" $B/api/admin/tenants -d '{"slug":"admin","name":"x","config":{"names":"a"}}')"
check "jbj /tenant slug" jbj "$(curl -s -H "$JBJ" $B/api/tenant | jget 'd["slug"]')"
check "jbj people" "['Adi', 'Rahul']" "$(curl -s -H "$JBJ" $B/api/tenant | jget 'd["config"]["names"]')"
J_CARD=$(curl -s -X POST -H "$JBJ" -H "$CT" $B/api/cards -d '{"title":"Isolation test card","assignee":"Rahul"}' | jget 'd["id"]')
check "jbj adds subtask to own card" 201 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD/subtasks -d '{"title":"t"}')"
check "jbj adds link to own card" 201 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD/links -d '{"url":"https://example.com"}')"
check "jbj adds note to own card" 201 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD/notes -d '{"body":"hi","author":"Rahul"}')"
check "jbj sees only own cards" True "$(curl -s -H "$JBJ" $B/api/cards | jget "all(c['title']=='Isolation test card' for c in d)")"
check "jbj sees no inditress resources" 0 "$(curl -s -H "$JBJ" $B/api/resources | jget 'len(d)')"

echo "== cross-tenant: jbj key on inditress rows (all must be 404)"
check "GET card"         404 "$(code -H "$JBJ" $B/api/cards/$IND_CARD)"
check "PATCH card"       404 "$(code -X PATCH -H "$JBJ" -H "$CT" $B/api/cards/$IND_CARD -d '{"title":"pwned"}')"
check "DELETE card"      404 "$(code -X DELETE -H "$JBJ" $B/api/cards/$IND_CARD)"
check "POST subtask"     404 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$IND_CARD/subtasks -d '{"title":"x"}')"
check "POST link"        404 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$IND_CARD/links -d '{"url":"https://x.y"}')"
check "POST note"        404 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$IND_CARD/notes -d '{"body":"x"}')"
check "PATCH subtask"    404 "$(code -X PATCH -H "$JBJ" -H "$CT" $B/api/subtasks/$IND_SUB -d '{"done":true}')"
check "DELETE subtask"   404 "$(code -X DELETE -H "$JBJ" $B/api/subtasks/$IND_SUB)"
check "DELETE link"      404 "$(code -X DELETE -H "$JBJ" $B/api/links/$IND_LINK)"
check "DELETE note"      404 "$(code -X DELETE -H "$JBJ" $B/api/notes/$IND_NOTE)"
check "DELETE resource"  404 "$(code -X DELETE -H "$JBJ" $B/api/resources/$IND_RES)"
check "inditress key on jbj card" 404 "$(code -H "$IND" $B/api/cards/$J_CARD)"
check "garbage id -> 404" 404 "$(code -H "$JBJ" $B/api/cards/abc)"

echo "== inditress unchanged after attacks"
IC2=$(curl -s -H "$IND" $B/api/cards)
check "same card count" "${EXPECT_IND_CARDS:-16}" "$(echo "$IC2" | jget 'len(d)')"
check "same data" "$(echo "$IC" | python3 -c 'import sys,hashlib;print(hashlib.md5(sys.stdin.read().encode()).hexdigest())')" "$(echo "$IC2" | python3 -c 'import sys,hashlib;print(hashlib.md5(sys.stdin.read().encode()).hexdigest())')"

echo "== admin"
check "admin + X-Tenant jbj sees jbj" jbj "$(curl -s -H "$ADM" -H 'X-Tenant: jbj' $B/api/tenant | jget 'd["slug"]')"
check "overview lists both boards" "['inditress', 'jbj']" "$(curl -s -H "$ADM" $B/api/admin/overview | jget "sorted(b['slug'] for b in d['boards'] if b['slug'] in ('inditress', 'jbj'))")"

echo "== pages"
check "/ redirects to /inditress" /inditress "$(curl -s -o /dev/null -w '%{redirect_url}' $B/ | sed -E 's#^https?://[^/]+##')"
check "/inditress 200" 200 "$(code $B/inditress)"
check "/jbj 200" 200 "$(code $B/jbj)"
check "/admin 200" 200 "$(code $B/admin)"

echo "== cleanup"
check "jbj deletes its test card" 200 "$(code -X DELETE -H "$JBJ" $B/api/cards/$J_CARD)"

echo; echo "passed $PASS, failed $FAIL"
[ $FAIL -eq 0 ]
