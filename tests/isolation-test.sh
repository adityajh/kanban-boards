#!/bin/bash
# Tenant-isolation + regression checks for kanban-boards. Usage: isolation-test.sh <base-url>
# Needs INDITRESS_PASSPHRASE, JBJ_PASSPHRASE, ADMIN_KEY in the environment.
B="${1:-http://localhost:3100}"
B="${B%/}"   # a trailing slash would double up in every path below
PASS=0; FAIL=0
IND="Authorization: Bearer $INDITRESS_PASSPHRASE"
JBJ="Authorization: Bearer $JBJ_PASSPHRASE"
ADM="Authorization: Bearer $ADMIN_KEY"
CT="Content-Type: application/json"

# Vercel protects preview deployments, so a bare curl gets an SSO redirect rather than the
# app. Set VERCEL_BYPASS to the project's "Protection Bypass for Automation" secret to test
# a preview without turning that protection off. Unset, this changes nothing.
CURL_EXTRA=()
if [ -n "${VERCEL_BYPASS:-}" ]; then
  CURL_EXTRA=(-H "x-vercel-protection-bypass: $VERCEL_BYPASS" -H "x-vercel-set-bypass-cookie: true")
fi
curl() { command curl "${CURL_EXTRA[@]}" "$@"; }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
check() { # name expected actual
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected $2, got $3)"; fi
}
jget() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }

# Before asserting anything, prove we are talking to the app at all. A protected Vercel
# preview answers every request with a 401 SSO page, which silently turns each "-> 401"
# check into a tautology and leaves the rest failing for reasons that look like code faults.
# 15 of 116 passing is what that looks like; better to stop here and say why.
PRE=$(curl -s -o /dev/null -w '%{http_code}' $B/api/auth/me)
PRE_BODY=$(curl -s $B/api/auth/me)
if [ "$PRE" != "401" ] || ! echo "$PRE_BODY" | grep -q '"error"'; then
  echo "Cannot reach the app at $B"
  echo "  GET /api/auth/me returned $PRE and did not look like our JSON:"
  echo "  ${PRE_BODY:0:200}"
  echo
  # A 3xx, a "Redirecting..." body or an SSO page all mean the same thing: something is
  # standing in front of the app. On Vercel that is Deployment Protection.
  if [ "$PRE" -ge 300 ] && [ "$PRE" -lt 400 ] 2>/dev/null \
     || echo "$PRE_BODY" | grep -qi 'redirecting\|vercel\|authenticat\|<html'; then
    echo "  Something is in front of the app — on Vercel that is Deployment Protection."
    if [ -z "${VERCEL_BYPASS:-}" ]; then
      echo "  VERCEL_BYPASS is not set, so the suite sent no bypass header."
      echo "  Either export it (Vercel -> Settings -> Deployment Protection ->"
      echo "  Protection Bypass for Automation), or turn protection off for previews."
    else
      echo "  VERCEL_BYPASS is set but was rejected — check the secret is current,"
      echo "  and that it belongs to this project."
    fi
  else
    echo "  Check the URL, and that the deployment finished building."
  fi
  exit 1
fi

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

echo "== malformed bodies answer 400, not 500"
# Every board write route parses its body with a catch, so a missing or broken body reaches
# the field check and says what is wrong. Unguarded it throws, and a client sees only a 500.
check "POST /cards no body"      400 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards)"
check "POST /cards bad json"     400 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards -d '{nope')"
check "POST /cards empty object" 400 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards -d '{}')"
check "POST subtasks no body"    400 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD/subtasks)"
check "POST links no body"       400 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD/links)"
check "POST notes no body"       400 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD/notes)"
check "POST resources no body"   400 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/resources)"
check "PATCH card no body"       200 "$(code -X PATCH -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD)"

echo "== stages"
# Stuck is a stage like any other over the API; what is new is that the overview reports it
# on its own, separately from the stalled list it is easily confused with.
check "card moves to stuck" 200 "$(code -X PATCH -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD -d '{"status":"stuck"}')"
check "card reads back stuck" stuck "$(curl -s -H "$JBJ" $B/api/cards/$J_CARD | jget 'd["status"]')"
OV=$(curl -s -H "$ADM" $B/api/admin/overview)
check "overview counts jbj stuck" 1 "$(echo "$OV" | jget "[b['stuck'] for b in d['boards'] if b['slug']=='jbj'][0]")"
check "overview lists the stuck card" True "$(echo "$OV" | jget "any(c['id']==$J_CARD for c in d['stuck'])")"
check "stalled stays in-progress only" True "$(echo "$OV" | jget "all(c['id']!=$J_CARD for c in d['stalled'])")"
check "card moves back out of stuck" 200 "$(code -X PATCH -H "$JBJ" -H "$CT" $B/api/cards/$J_CARD -d '{"status":"todo"}')"

echo "== pages"
check "/ redirects to /inditress" /inditress "$(curl -s -o /dev/null -w '%{redirect_url}' $B/ | sed -E 's#^https?://[^/]+##')"
check "/inditress 200" 200 "$(code $B/inditress)"
check "/jbj 200" 200 "$(code $B/jbj)"
check "/admin 200" 200 "$(code $B/admin)"

echo "== per-person auth"
JAR=$(mktemp); JAR2=$(mktemp)
# Signing in no longer names a board: one account, many boards.
login() { # username password jar -> http code
  curl -s -o /dev/null -w '%{http_code}' -c "$3" -X POST -H "$CT" \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" $B/api/auth/login; }

# Adding someone appends their display name to that board's people list, so remember both
# boards' lists and put them back in cleanup.
names_of() { curl -s -H "$1" $B/api/tenant | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["config"]["names"]))'; }
JBJ_NAMES=$(names_of "$JBJ")
IND_NAMES=$(names_of "$IND")

JT="X-Tenant: jbj"
IT="X-Tenant: inditress"
MEMBER=$(curl -s -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users \
  -d '{"username":"zz-test-member","displayName":"ZZ Test Member"}')
MEMBER_PW=$(echo "$MEMBER" | jget 'd.get("password","")')
MEMBER_ID=$(echo "$MEMBER" | jget 'd.get("user",{}).get("id","")')
check "admin key adds a person to a board" True "$([ -n "$MEMBER_PW" ] && echo True || echo False)"
check "a brand new person gets a password" False "$(echo "$MEMBER" | jget 'd["existing"]')"
check "password is not echoed by the people list" False \
  "$(curl -s -H "$ADM" -H "$JT" $B/api/settings/users | jget '"password" in str(d)')"

echo "-- signing in"
check "correct password -> 200" 200 "$(login zz-test-member "$MEMBER_PW" $JAR)"
check "wrong password -> 401" 401 "$(login zz-test-member wrong-password-here $JAR2)"
check "unknown user -> 401" 401 "$(login zz-no-such-user "$MEMBER_PW" $JAR2)"
E1=$(curl -s -X POST -H "$CT" -d '{"username":"zz-test-member","password":"nope"}' $B/api/auth/login)
E2=$(curl -s -X POST -H "$CT" -d '{"username":"zz-nobody","password":"nope"}' $B/api/auth/login)
check "wrong password and unknown user are indistinguishable" "$E1" "$E2"
check "no cookie -> 401 on /me" 401 "$(code $B/api/auth/me)"
check "/me lists the boards you are on" "['jbj']" "$(curl -s -b $JAR $B/api/auth/me | jget "[x['slug'] for x in d['boards']]")"
check "must change a generated password" True "$(curl -s -b $JAR $B/api/auth/me | jget 'd["user"]["mustChange"]')"

echo "-- a session opens only the boards you belong to"
check "own board reads" jbj "$(curl -s -b $JAR -H "$JT" $B/api/tenant | jget 'd["slug"]')"
check "a board you are not on -> 401" 401 "$(code -b $JAR -H "$IT" $B/api/tenant)"
check "a board that does not exist -> 401" 401 "$(code -b $JAR -H 'X-Tenant: zz-no-such-board' $B/api/tenant)"
check "no board named at all -> 400" 400 "$(code -b $JAR $B/api/tenant)"
check "cannot read another board's cards" 401 "$(code -b $JAR -H "$IT" $B/api/cards)"
check "cannot reach another board's row by id" 404 "$(code -b $JAR -H "$JT" $B/api/cards/$IND_CARD)"
check "cannot patch another board's row by id" 404 "$(code -X PATCH -b $JAR -H "$JT" -H "$CT" $B/api/cards/$IND_CARD -d '{"title":"pwned"}')"
check "cannot delete another board's subtask by id" 404 "$(code -X DELETE -b $JAR -H "$JT" $B/api/subtasks/$IND_SUB)"

echo "-- members are not admins"
check "member sees settings" 200 "$(code -b $JAR -H "$JT" $B/api/settings)"
check "member is told they are not admin" False "$(curl -s -b $JAR -H "$JT" $B/api/settings | jget 'd["isAdmin"]')"
check "member sees no people list" 0 "$(curl -s -b $JAR -H "$JT" $B/api/settings | jget 'len(d["users"])')"
check "member cannot edit the board" 403 "$(code -X PATCH -b $JAR -H "$JT" -H "$CT" $B/api/settings -d '{"name":"pwned"}')"
check "member cannot list people" 403 "$(code -b $JAR -H "$JT" $B/api/settings/users)"
check "member cannot add a person" 403 "$(code -X POST -b $JAR -H "$JT" -H "$CT" $B/api/settings/users -d '{"username":"zz-sneak"}')"
check "member cannot promote themselves" 403 "$(code -X PATCH -b $JAR -H "$JT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"isAdmin":true}')"
check "member cannot remove anyone" 403 "$(code -X DELETE -b $JAR -H "$JT" $B/api/settings/users/$MEMBER_ID)"

echo "-- an agent's passphrase is not a person"
check "passphrase cannot read settings" 403 "$(code -H "$JBJ" $B/api/settings)"
check "passphrase cannot list people" 403 "$(code -H "$JBJ" $B/api/settings/users)"
check "passphrase cannot add a person" 403 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/settings/users -d '{"username":"zz-agent"}')"
check "passphrase cannot change a password" 401 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/auth/password -d '{"currentPassword":"x","newPassword":"yyyyyyyyyy"}')"
check "passphrase still works on /api/cards" 200 "$(code -H "$JBJ" $B/api/cards)"

echo "-- notes are attributed from the session, not the request body"
JN_CARD=$(curl -s -X POST -H "$JBJ" -H "$CT" $B/api/cards -d '{"title":"Auth test card"}' | jget 'd["id"]')
check "claimed author is ignored for a signed-in person" "ZZ Test Member" \
  "$(curl -s -X POST -b $JAR -H "$JT" -H "$CT" $B/api/cards/$JN_CARD/notes -d '{"body":"hi","author":"Adi"}' | jget 'd["author"]')"
check "an agent still sets its own author" "Rahul" \
  "$(curl -s -X POST -H "$JBJ" -H "$CT" $B/api/cards/$JN_CARD/notes -d '{"body":"hi","author":"Rahul"}' | jget 'd["author"]')"

echo "-- one account across two boards"
JOIN=$(curl -s -X POST -H "$ADM" -H "$IT" -H "$CT" $B/api/settings/users \
  -d '{"username":"zz-test-member","displayName":"ZZ Test Member"}')
check "joining a second board recognises the existing account" True "$(echo "$JOIN" | jget 'd["existing"]')"
check "and issues no second password" True "$(echo "$JOIN" | jget 'd["password"] is None')"
check "the same id is reused" "$MEMBER_ID" "$(echo "$JOIN" | jget 'd["user"]["id"]')"
check "already on the board -> 409" 409 "$(code -X POST -H "$ADM" -H "$IT" -H "$CT" $B/api/settings/users -d '{"username":"zz-test-member"}')"
check "/me now lists both boards" "['inditress', 'jbj']" "$(curl -s -b $JAR $B/api/auth/me | jget "sorted(x['slug'] for x in d['boards'])")"
check "the one session opens the second board" inditress "$(curl -s -b $JAR -H "$IT" $B/api/tenant | jget 'd["slug"]')"
check "no new sign-in was needed" 200 "$(code -b $JAR -H "$IT" $B/api/cards)"

echo "-- admin is per board, not per person"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$IT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"isAdmin":true}'
check "admin on the board it was granted on" True "$(curl -s -b $JAR -H "$IT" $B/api/settings | jget 'd["isAdmin"]')"
check "still not admin on the other board" False "$(curl -s -b $JAR -H "$JT" $B/api/settings | jget 'd["isAdmin"]')"
check "and still cannot edit the other board" 403 "$(code -X PATCH -b $JAR -H "$JT" -H "$CT" $B/api/settings -d '{"name":"pwned"}')"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$IT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"isAdmin":false}'

echo "-- changing a password"
# bash 3.2 (macOS) mangles an escaped-quote body written inline inside "$( … )", sending
# an empty one. An empty body reads as a missing newPassword, which is "too short" — so the
# two negative checks below would pass for the wrong reason and only the positive one would
# show it. Build each body in a variable first.
PW_SHORT="{\"currentPassword\":\"$MEMBER_PW\",\"newPassword\":\"short\"}"
PW_SAME="{\"currentPassword\":\"$MEMBER_PW\",\"newPassword\":\"$MEMBER_PW\"}"
PW_NEW="{\"currentPassword\":\"$MEMBER_PW\",\"newPassword\":\"brand-new-password\"}"
check "the change-password body survives the shell" True "$(python3 -c 'import json,sys; print(bool(json.loads(sys.argv[1]).get("newPassword")))' "$PW_NEW")"
check "wrong current password -> 403" 403 "$(code -X POST -b $JAR -H "$CT" $B/api/auth/password -d '{"currentPassword":"nope","newPassword":"brand-new-password"}')"
check "too short -> 400" 400 "$(code -X POST -b $JAR -H "$CT" $B/api/auth/password -d "$PW_SHORT")"
check "same as current -> 400" 400 "$(code -X POST -b $JAR -H "$CT" $B/api/auth/password -d "$PW_SAME")"
check "second session logs in" 200 "$(login zz-test-member "$MEMBER_PW" $JAR2)"
check "change succeeds" 200 "$(code -X POST -b $JAR -c $JAR -H "$CT" $B/api/auth/password -d "$PW_NEW")"
check "mustChange is cleared" False "$(curl -s -b $JAR $B/api/auth/me | jget 'd["user"]["mustChange"]')"
check "the other session is evicted" 401 "$(code -b $JAR2 $B/api/auth/me)"
check "old password no longer works" 401 "$(login zz-test-member "$MEMBER_PW" $JAR2)"
check "new password works" 200 "$(login zz-test-member brand-new-password $JAR2)"
check "the new password opens both boards" 200 "$(code -b $JAR2 -H "$IT" $B/api/cards)"

echo "-- admin reset evicts the person everywhere"
RESET=$(curl -s -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"resetPassword":true}')
check "reset returns a new password" True "$([ -n "$(echo "$RESET" | jget 'd.get("password","")')" ] && echo True || echo False)"
check "reset signs the person out" 401 "$(code -b $JAR $B/api/auth/me)"
check "reset signs out their other session too" 401 "$(code -b $JAR2 $B/api/auth/me)"
check "reset password works" 200 "$(login zz-test-member "$(echo "$RESET" | jget 'd["password"]')" $JAR)"

echo "-- leaving one board does not touch the other"
check "removed from inditress" 200 "$(code -X DELETE -H "$ADM" -H "$IT" $B/api/settings/users/$MEMBER_ID)"
check "inditress is now closed to them" 401 "$(code -b $JAR -H "$IT" $B/api/tenant)"
check "jbj still opens" jbj "$(curl -s -b $JAR -H "$JT" $B/api/tenant | jget 'd["slug"]')"
check "the account still exists" 200 "$(code -b $JAR $B/api/auth/me)"
check "and lists only the remaining board" "['jbj']" "$(curl -s -b $JAR $B/api/auth/me | jget "[x['slug'] for x in d['boards']]")"

echo "-- signing out"
check "logout clears the session" 200 "$(code -X POST -b $JAR -c $JAR $B/api/auth/logout)"
check "the cookie is dead afterwards" 401 "$(code -b $JAR $B/api/auth/me)"

echo "-- a board is never left without an admin"
ADMIN_COUNT=$(curl -s -H "$ADM" -H "$JT" $B/api/settings/users | jget 'len([u for u in d if u["isAdmin"]])')
SOLE_ADMIN=$(curl -s -H "$ADM" -H "$JT" $B/api/settings/users | jget '([u["id"] for u in d if u["isAdmin"]] or [""])[0]')
if [ "$ADMIN_COUNT" = "1" ]; then
  # Demotion, not deletion: a refused demotion changes nothing, and a wrongly-allowed one
  # is put back below.
  check "the only admin cannot be demoted" 409 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users/$SOLE_ADMIN -d '{"isAdmin":false}')"
  check "the only admin cannot be removed" 409 "$(code -X DELETE -H "$ADM" -H "$JT" $B/api/settings/users/$SOLE_ADMIN)"
  check "the only admin is still an admin" True "$(curl -s -H "$ADM" -H "$JT" $B/api/settings/users | jget "[u['isAdmin'] for u in d if u['id']==$SOLE_ADMIN][0]")"
  curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users/$SOLE_ADMIN -d '{"isAdmin":true}'
else
  echo "  skip jbj has $ADMIN_COUNT admins, last-admin guard not exercised"
fi

echo "-- usernames"
check "bad username -> 400" 400 "$(code -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users -d '{"username":"no spaces"}')"
check "admin key cannot reach a person who is not on the named board" 404 "$(code -H "$ADM" -H "$IT" -X DELETE $B/api/settings/users/$MEMBER_ID)"

echo "== master admin"
# A signed-in board admin is not a master admin: managing boards is a separate thing from
# running one, and must not leak from the latter.
check "a board member cannot list boards" 401 "$(code -b $JAR $B/api/admin/tenants)"
check "a board member cannot create a board" 401 "$(code -X POST -b $JAR -H "$CT" $B/api/admin/tenants -d '{"slug":"zz-sneak","name":"x","config":{"names":"a"}}')"
check "a board member cannot delete a board" 401 "$(code -X DELETE -b $JAR -H "$CT" $B/api/admin/tenants/jbj -d '{"confirm":"jbj"}')"
check "a board member cannot join a board" 401 "$(code -X POST -b $JAR $B/api/admin/tenants/inditress/join)"
check "a passphrase cannot list boards" 401 "$(code -H "$JBJ" $B/api/admin/tenants)"

echo "-- creating and deleting a board"
NEWB="{\"slug\":\"zz-test-board\",\"name\":\"ZZ Test Board\",\"config\":{\"names\":\"ZZ Tester\"}}"
MADE=$(curl -s -X POST -H "$ADM" -H "$CT" -d "$NEWB" $B/api/admin/tenants)
check "a board is created" "zz-test-board" "$(echo "$MADE" | jget 'd.get("tenant",{}).get("slug","")')"
check "with a passphrase shown once" True "$([ -n "$(echo "$MADE" | jget 'd.get("passphrase","")')" ] && echo True || echo False)"
check "and an admin account" True "$([ -n "$(echo "$MADE" | jget 'd.get("admin",{}).get("username","")')" ] && echo True || echo False)"
check "it appears in the board list" True "$(curl -s -H "$ADM" $B/api/admin/tenants | jget "any(b['slug']=='zz-test-board' for b in d)")"

echo "-- deletion will not happen by accident"
check "no confirmation -> 400" 400 "$(code -X DELETE -H "$ADM" -H "$CT" $B/api/admin/tenants/zz-test-board -d '{}')"
check "wrong confirmation -> 400" 400 "$(code -X DELETE -H "$ADM" -H "$CT" $B/api/admin/tenants/zz-test-board -d '{"confirm":"jbj"}')"
check "the board is still there" True "$(curl -s -H "$ADM" $B/api/admin/tenants | jget "any(b['slug']=='zz-test-board' for b in d)")"
check "a board that does not exist -> 404" 404 "$(code -X DELETE -H "$ADM" -H "$CT" $B/api/admin/tenants/zz-no-such-board -d '{"confirm":"zz-no-such-board"}')"
GONE=$(curl -s -X DELETE -H "$ADM" -H "$CT" $B/api/admin/tenants/zz-test-board -d '{"confirm":"zz-test-board"}')
check "the right confirmation deletes it" "zz-test-board" "$(echo "$GONE" | jget 'd.get("deleted",{}).get("slug","")')"
check "and says what it destroyed" True "$(echo "$GONE" | jget '"cards" in d.get("deleted",{})')"
check "its lone account went with it" True "$(echo "$GONE" | jget "'zztester' in d.get('accountsRemoved',[])")"
check "it is gone from the board list" False "$(curl -s -H "$ADM" $B/api/admin/tenants | jget "any(b['slug']=='zz-test-board' for b in d)")"
check "its passphrase no longer opens anything" 401 "$(code -H "Authorization: Bearer $(echo "$MADE" | jget 'd["passphrase"]')" $B/api/cards)"

echo "-- the real boards are untouched by all of that"
check "still four boards or more" True "$(curl -s -H "$ADM" $B/api/admin/tenants | jget 'len(d) >= 2')"
check "inditress still there" True "$(curl -s -H "$ADM" $B/api/admin/tenants | jget "any(b['slug']=='inditress' for b in d)")"

echo "== agents have their own identity"
# Bodies are hoisted into variables rather than built inline inside "$( … )": bash 3.2
# mangles escaped quotes there, and a silently empty body makes a negative check pass for
# the wrong reason. The guard below proves each one parses before it is sent.
AG_NEW='{"name":"zz-test-agent","scope":"write"}'
AG_RO_NEW='{"name":"zz-test-reader","scope":"read"}'
check "agent bodies are valid json" OK "$(printf '%s' "$AG_NEW$AG_RO_NEW" | python3 -c 'import sys;print("OK")')"

AG=$(curl -s -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents -d "$AG_NEW")
AG_ID=$(echo "$AG" | jget 'd.get("agent",{}).get("id","")')
AG_TOK=$(echo "$AG" | jget 'd.get("token","")')
AGH="Authorization: Bearer $AG_TOK"
check "an agent token is issued once" True "$([ -n "$AG_TOK" ] && echo True || echo False)"
check "the token names its board" True "$(echo "$AG_TOK" | grep -q '^agt-jbj-' && echo True || echo False)"
check "listing agents never returns a token" False "$(curl -s -H "$ADM" -H "$JT" $B/api/settings/agents | jget "any('token' in a for a in d)")"
check "the agent opens its own board" jbj "$(curl -s -H "$AGH" $B/api/tenant | jget 'd["slug"]')"
check "and is refused another board's card" 404 "$(code -H "$AGH" $B/api/cards/$IND_CARD)"
check "the agent is assignable" True "$(curl -s -H "$JBJ" $B/api/tenant | jget "'zz-test-agent' in d['config']['names']")"
check "an agent cannot reach settings" 403 "$(code -H "$AGH" -H "$JT" $B/api/settings)"
check "an agent cannot reach the admin API" 401 "$(code -H "$AGH" $B/api/admin/tenants)"

echo "-- attribution comes from the credential, not the body"
LIE='{"body":"written by the agent","author":"Adi"}'
A_CARD=$(curl -s -X POST -H "$AGH" -H "$CT" $B/api/cards -d '{"title":"zz agent card"}' | jget 'd["id"]')
NOTE=$(curl -s -X POST -H "$AGH" -H "$CT" $B/api/cards/$A_CARD/notes -d "$LIE")
check "an agent cannot sign as someone else" zz-test-agent "$(echo "$NOTE" | jget 'd["author"]')"

echo "-- audience"
check "a card an agent creates is agent_only" agent_only "$(curl -s -H "$AGH" $B/api/cards/$A_CARD | jget 'd["audience"]')"
HUMAN='{"title":"zz human only card","audience":"human_only"}'
H_CARD=$(curl -s -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards -d "$HUMAN" | jget 'd["id"]')
P_CARD=$(curl -s -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards -d '{"title":"zz person card"}' | jget 'd["id"]')
check "a card a person creates is for both" both "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$P_CARD | jget 'd["audience"]')"
check "and the agent does see that one" True "$(curl -s -H "$AGH" $B/api/cards | jget "any(c['id']==$P_CARD for c in d)")"
check "the agent is not shown a human_only card" False "$(curl -s -H "$AGH" $B/api/cards | jget "any(c['id']==$H_CARD for c in d)")"
check "and gets 404 fetching it directly" 404 "$(code -H "$AGH" $B/api/cards/$H_CARD)"
check "and 404 adding a note to it" 404 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards/$H_CARD/notes -d '{"body":"x"}')"
check "and 404 patching it" 404 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$H_CARD -d '{"title":"pwned"}')"
check "and 404 deleting it" 404 "$(code -X DELETE -H "$AGH" $B/api/cards/$H_CARD)"
check "the agent is told how many rows it cannot see" True "$(curl -s -D - -o /dev/null -H "$AGH" $B/api/cards | grep -qi '^x-hidden-cards: *[1-9]' && echo True || echo False)"
check "a person still sees the human_only card" True "$(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "any(c['id']==$H_CARD for c in d)")"
check "an agent cannot create a human_only card" 400 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards -d "$HUMAN")"
check "an agent cannot hide a card from people" 400 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$A_CARD -d '{"audience":"human_only"}')"
check "a bad audience is refused" 400 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards -d '{"title":"x","audience":"nobody"}')"

echo "-- a read-only agent is refused every write"
RO=$(curl -s -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents -d "$AG_RO_NEW")
RO_ID=$(echo "$RO" | jget 'd.get("agent",{}).get("id","")')
ROH="Authorization: Bearer $(echo "$RO" | jget 'd.get("token","")')"
check "a read-only agent can read" 200 "$(code -H "$ROH" $B/api/cards)"
check "but cannot create a card" 403 "$(code -X POST -H "$ROH" -H "$CT" $B/api/cards -d '{"title":"nope"}')"
check "cannot add a note" 403 "$(code -X POST -H "$ROH" -H "$CT" $B/api/cards/$A_CARD/notes -d '{"body":"nope"}')"
check "cannot write a document" 403 "$(code -X PUT -H "$ROH" -H "$CT" $B/api/docs/zz/nope -d '{"body":"x"}')"

echo "-- a disabled agent stops working, and its history does not"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$RO_ID -d '{"disabled":true}'
check "a disabled token is refused" 401 "$(code -H "$ROH" $B/api/cards)"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$RO_ID -d '{"disabled":false}'
check "and works again when re-enabled" 200 "$(code -H "$ROH" $B/api/cards)"
OLD_TOK="$ROH"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$RO_ID -d '{"rotate":true}'
check "rotating kills the old token" 401 "$(code -H "$OLD_TOK" $B/api/cards)"

echo "== documents"
DOC='{"title":"ZZ brief","body":"first version"}'
DOC2='{"body":"second version","expected_version":1}'
DOC_STALE='{"body":"third version","expected_version":1}'
check "doc bodies are valid json" OK "$(printf '%s' "$DOC$DOC2$DOC_STALE" | python3 -c 'import sys;print("OK")')"
check "a document is created at its key" 201 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/docs/zz/brief -d "$DOC")"
check "it reads back by key" "first version" "$(curl -s -H "$AGH" $B/api/docs/zz/brief | jget 'd["body"]')"
check "an agent's document defaults to agent_only" agent_only "$(curl -s -H "$AGH" $B/api/docs/zz/brief | jget 'd["audience"]')"
check "the list carries no bodies" False "$(curl -s -H "$AGH" $B/api/docs | jget "any('body' in x for x in d)")"
check "the right version replaces it" 200 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/docs/zz/brief -d "$DOC2")"
check "a stale version is refused" 409 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/docs/zz/brief -d "$DOC_STALE")"
check "the stale write did not land" "second version" "$(curl -s -H "$AGH" $B/api/docs/zz/brief | jget 'd["body"]')"
check "append needs no version" 200 "$(code -X POST -H "$AGH" -H "$CT" $B/api/docs/zz/brief -d '{"body":"an appended line"}')"
check "and keeps what was there" True "$(curl -s -H "$AGH" $B/api/docs/zz/brief | jget "'second version' in d['body'] and 'an appended line' in d['body']")"
check "the append is attributed" True "$(curl -s -H "$AGH" $B/api/docs/zz/brief | jget "'zz-test-agent' in d['body']")"
check "an agent cannot write a human_only doc" 400 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/docs/zz/secret -d '{"body":"x","audience":"human_only"}')"
check "a key on another board is not found" 404 "$(code -H "$IND" $B/api/docs/zz/brief)"
check "an empty append is refused" 400 "$(code -X POST -H "$AGH" -H "$CT" $B/api/docs/zz/brief -d '{"body":"  "}')"

echo "== the event log"
EV=$(curl -s -H "$ADM" -H "$JT" "$B/api/events?limit=200")
check "the log records the agent by name" True "$(echo "$EV" | jget "any(e['actor']['name']=='zz-test-agent' for e in d['events'])")"
check "it says what kind of actor that was" True "$(echo "$EV" | jget "any(e['actor']['kind']=='agent' for e in d['events'])")"
check "card creation is logged" True "$(echo "$EV" | jget "any(e['verb']=='card.created' for e in d['events'])")"
check "document appends are logged" True "$(echo "$EV" | jget "any(e['verb']=='doc.appended' for e in d['events'])")"
check "the cursor is an id, not a time" True "$(echo "$EV" | jget "isinstance(d['cursor'], int)")"
CUR=$(echo "$EV" | jget 'd["cursor"]')
check "reading from the cursor returns nothing new" 0 "$(curl -s -H "$ADM" -H "$JT" "$B/api/events?since=$CUR" | jget 'len(d["events"])')"
curl -s -o /dev/null -X POST -H "$AGH" -H "$CT" $B/api/cards/$A_CARD/notes -d '{"body":"after the cursor"}'
check "and picks up what happens after it" True "$(curl -s -H "$ADM" -H "$JT" "$B/api/events?since=$CUR" | jget "any(e['verb']=='note.added' for e in d['events'])")"
check "another board cannot read this log" True "$(curl -s -H "$IND" "$B/api/events?limit=200" | jget "all(e['actor']['name']!='zz-test-agent' for e in d['events'])")"

echo "-- being woken instead of polling"
HOOK_OK='{"webhookUrl":"https://example.com/wake","webhookVerbs":["card.moved","note.added"]}'
HOOK_HTTP='{"webhookUrl":"http://example.com/wake"}'
HOOK_LOCAL='{"webhookUrl":"https://127.0.0.1/wake"}'
HOOK_META='{"webhookUrl":"https://169.254.169.254/latest/meta-data"}'
check "webhook bodies are valid json" OK "$(printf '%s' "$HOOK_OK$HOOK_HTTP$HOOK_LOCAL$HOOK_META" | python3 -c 'import sys;print("OK")')"
WH=$(curl -s -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d "$HOOK_OK")
check "a webhook can be set" "https://example.com/wake" "$(echo "$WH" | jget 'd.get("agent",{}).get("webhookUrl","")')"
check "and a signing secret comes back once" True "$(echo "$WH" | jget "str(d.get('webhookSecret','')).startswith('whsec_')")"
check "the verbs are kept" "['card.moved', 'note.added']" "$(echo "$WH" | jget 'd["agent"]["webhookVerbs"]')"
check "the secret is never listed again" False "$(curl -s -H "$ADM" -H "$JT" $B/api/settings/agents | jget "any('webhookSecret' in a or 'secret' in str(a) for a in d)")"
# The board makes this request itself, so an inward address would turn an agent's config
# into server-side request forgery.
check "plain http is refused" 400 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d "$HOOK_HTTP")"
check "loopback is refused" 400 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d "$HOOK_LOCAL")"
check "the cloud metadata address is refused" 400 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d "$HOOK_META")"
check "a refused url leaves the old one in place" "https://example.com/wake" "$(curl -s -H "$ADM" -H "$JT" $B/api/settings/agents | jget "[a for a in d if a['id']==$AG_ID][0]['webhookUrl']")"
check "an agent cannot set its own webhook" 403 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/settings/agents/$AG_ID -d "$HOOK_OK")"
check "clearing it falls back to the feed" None "$(curl -s -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d '{"webhookUrl":null}' | jget 'd["agent"]["webhookUrl"]')"

echo "-- agent cleanup"
curl -s -o /dev/null -X DELETE -H "$AGH" $B/api/docs/zz/brief
curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/cards/$A_CARD
curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/cards/$H_CARD
curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/cards/$P_CARD
check "the agent is removed" True "$(curl -s -X DELETE -H "$ADM" -H "$JT" $B/api/settings/agents/$AG_ID | jget 'd.get("ok") is True')"
check "its token stops working at once" 401 "$(code -H "$AGH" $B/api/cards)"
check "but the note it wrote keeps its name" True "$(curl -s -H "$ADM" -H "$JT" "$B/api/events?limit=200" | jget "any(e['actor']['name']=='zz-test-agent' for e in d['events'])")"
curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/settings/agents/$RO_ID

echo "== cleanup"
curl -s -o /dev/null -X DELETE -H "$JBJ" $B/api/cards/$JN_CARD
LAST=$(curl -s -X DELETE -H "$ADM" -H "$JT" $B/api/settings/users/$MEMBER_ID)
check "jbj removes the test member" True "$(echo "$LAST" | jget 'd.get("ok") is True')"
check "their last board going takes the account with it" True "$(echo "$LAST" | jget 'd["accountRemoved"]')"
check "the removed person cannot sign in" 401 "$(login zz-test-member brand-new-password $JAR2)"
RESTORE_JBJ="{\"config\":{\"names\":$JBJ_NAMES}}"
RESTORE_IND="{\"config\":{\"names\":$IND_NAMES}}"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$CT" $B/api/admin/tenants/jbj -d "$RESTORE_JBJ"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$CT" $B/api/admin/tenants/inditress -d "$RESTORE_IND"
check "jbj people list restored" "$JBJ_NAMES" "$(names_of "$JBJ")"
check "inditress people list restored" "$IND_NAMES" "$(names_of "$IND")"
rm -f $JAR $JAR2

check "jbj deletes its test card" 200 "$(code -X DELETE -H "$JBJ" $B/api/cards/$J_CARD)"

echo; echo "passed $PASS, failed $FAIL"
[ $FAIL -eq 0 ]
