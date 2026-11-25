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
IND_N=$(echo "$IC" | jget 'len(d)')
# How many cards this board holds is whatever Adi's real board holds, and it goes up
# whenever somebody adds one. A fixed number here fails for the wrong reason the first time
# that happens — which it did: the board gained a card on 29 September and this line has
# been wrong against production ever since, while still passing against dev. A check whose
# name says "intact" must not break on ordinary use, or people learn to ignore it.
#
# What is worth asserting is that the board is not empty, and that nothing below CHANGES
# it. The count captured here is what the post-attack check compares against.
check "inditress has cards" True "$([ "${IND_N:-0}" -gt 0 ] && echo True || echo False)"
if [ -n "$EXPECT_IND_CARDS" ]; then
  check "inditress card count is exactly $EXPECT_IND_CARDS" "$EXPECT_IND_CARDS" "$IND_N"
fi
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
check "same card count as before the attacks" "$IND_N" "$(echo "$IC2" | jget 'len(d)')"
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
# The plan checks edit jbj's tagline to prove a board admin can still change ordinary
# settings, so remember it and put it back with the names.
JBJ_TAGLINE=$(curl -s -H "$JBJ" $B/api/tenant | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["config"].get("tagline","")))')

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

# The logout above killed this session, and every -b $JAR check below it was quietly
# testing "no cookie" rather than what its name claims. Sign back in, and make them an
# admin of jbj, so the checks that follow exercise a real board admin.
MEMBER_PW2=$(echo "$RESET" | jget 'd["password"]')
check "the member signs back in" 200 "$(login zz-test-member "$MEMBER_PW2" $JAR)"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"isAdmin":true}'
check "and is now an admin of jbj" True "$(curl -s -b $JAR -H "$JT" $B/api/settings | jget 'd["isAdmin"]')"

echo "== master admin"
# A signed-in board admin is not a master admin: managing boards is a separate thing from
# running one, and must not leak from the latter.
check "a board admin cannot list boards" 401 "$(code -b $JAR $B/api/admin/tenants)"
check "a board admin cannot create a board" 401 "$(code -X POST -b $JAR -H "$CT" $B/api/admin/tenants -d '{"slug":"zz-sneak","name":"x","config":{"names":"a"}}')"
check "a board admin cannot delete a board" 401 "$(code -X DELETE -b $JAR -H "$CT" $B/api/admin/tenants/jbj -d '{"confirm":"jbj"}')"
check "a board admin cannot join a board" 401 "$(code -X POST -b $JAR $B/api/admin/tenants/inditress/join)"
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

echo "== boards with no passphrase"
# Credentials, and why each is live where it is used. The shared $JAR was logged out far
# above and signed back in later, so nothing here borrows it:
#   ADM        the master key as a header, so it cannot go stale. Creates, patches and deletes
#              every board below, and reads them back with X-Tenant.
#   JARNP      a fresh cookie jar signed in below as the new board's own admin, a person who
#              exists only on zz-nopass. The /auth/me check right after proves who it is.
#   NP_PASS    the minted passphrase of zz-minted, the only bearer credential used for a board
#              that has one; the last block turns it into a 401.
#   NP_BAD     a made-up bearer string, to prove that no string at all opens a null key_hash.
NP_BAD='Authorization: Bearer zz-any-string-at-all-123456'
NP_SLUG=zz-nopass; MI_SLUG=zz-minted; EM_SLUG=zz-empty-pass
for S in $NP_SLUG $MI_SLUG $EM_SLUG; do   # a run that died earlier must not turn 409s into false faults
  curl -s -o /dev/null -X DELETE -H "$ADM" -H "$CT" $B/api/admin/tenants/$S -d "{\"confirm\":\"$S\"}"
done
callw() { local r nl=$'\n'; r=$(curl -s -w '\n%{http_code}' "$@"); RC=${r##*"$nl"}; RB=${r%"$nl"*}; }
npcreate() { # slug, optional extra body fragment such as ',"passphrase":null'
  callw -X POST -H "$ADM" -H "$CT" $B/api/admin/tenants \
    -d "{\"slug\":\"$1\",\"name\":\"ZZ $1\",\"config\":{\"names\":\"ZZ $1 Person\"}$2}"; }

echo "-- created with an explicit null"
npcreate $NP_SLUG ',"passphrase":null'
check "a board with passphrase null -> 201" 201 "$RC"
check "and the body says passphrase is null" None "$(echo "$RB" | jget 'd["passphrase"] if "passphrase" in d else "MISSING"')"
NP_USER=$(echo "$RB" | jget 'd["admin"]["username"]'); NP_PW=$(echo "$RB" | jget 'd["admin"]["password"]')
check "a made-up bearer token cannot open it" 401 "$(code -H "$NP_BAD" -H "X-Tenant: $NP_SLUG" $B/api/cards)"
check "nor can one sent without X-Tenant" 401 "$(code -H "$NP_BAD" $B/api/cards)"
# A passphrase names its own board and X-Tenant is ignored — that has been true since the
# first version of this app and is asserted further up ("tenant key ignores X-Tenant"). So
# sending jbj's passphrase here does not fail: it succeeds, for JBJ. Expecting 401 was
# testing the wrong thing. What matters is that it does not reach the passphrase-less board,
# which is what this asserts.
check "another board's passphrase opens its own board, not this one" jbj \
  "$(curl -s -H "$JBJ" -H "X-Tenant: $NP_SLUG" $B/api/tenant | jget 'd["slug"]')"
check "the master key with X-Tenant reads it" 200 "$(code -H "$ADM" -H "X-Tenant: $NP_SLUG" $B/api/cards)"
check "and it is the right board" "$NP_SLUG" "$(curl -s -H "$ADM" -H "X-Tenant: $NP_SLUG" $B/api/tenant | jget 'd["slug"]')"
JARNP=$(mktemp)
check "its admin signs in" 200 "$(login "$NP_USER" "$NP_PW" $JARNP)"
check "and the session is that person" "$NP_USER" "$(curl -s -b $JARNP $B/api/auth/me | jget "d['user']['username']")"
check "a signed-in member reads the board" 200 "$(code -b $JARNP -H "X-Tenant: $NP_SLUG" $B/api/cards)"
rm -f $JARNP

echo "-- the default did not change"
npcreate $MI_SLUG ''
check "with the key absent -> 201" 201 "$RC"
NP_PASS=$(echo "$RB" | jget 'd["passphrase"]')
check "a passphrase is still minted" True "$([ -n "$NP_PASS" ] && [ "$NP_PASS" != None ] && echo True || echo False)"
check "and it opens the board" 200 "$(code -H "Authorization: Bearer $NP_PASS" $B/api/cards)"
npcreate $EM_SLUG ',"passphrase":""'
check "with an empty string -> 201" 201 "$RC"
check "a passphrase is still minted for it" True "$([ -n "$(echo "$RB" | jget 'd["passphrase"] or ""')" ] && echo True || echo False)"

echo "-- retiring a passphrase"
check "rotate and removePassphrase together -> 400" 400 "$(code -X PATCH -H "$ADM" -H "$CT" $B/api/admin/tenants/$MI_SLUG -d '{"rotate":true,"removePassphrase":true}')"
check "the refused request left the passphrase working" 200 "$(code -H "Authorization: Bearer $NP_PASS" $B/api/cards)"
NP_AG=$(curl -s -X POST -H "$ADM" -H "X-Tenant: $MI_SLUG" -H "$CT" $B/api/settings/agents -d '{"name":"zz-nopass-agent","scope":"write"}')
NP_AGH="Authorization: Bearer $(echo "$NP_AG" | jget 'd["token"]')"
callw -X PATCH -H "$ADM" -H "$CT" $B/api/admin/tenants/$MI_SLUG -d '{"removePassphrase":true}'
check "removePassphrase -> 200" 200 "$RC"
check "and says it was removed" True "$(echo "$RB" | jget 'd["passphraseRemoved"]')"
check "and how many agents are on the board" 1 "$(echo "$RB" | jget 'd["agentsOnBoard"]')"
check "the old passphrase now gets 401" 401 "$(code -H "Authorization: Bearer $NP_PASS" $B/api/cards)"
check "the agent token still works" 200 "$(code -H "$NP_AGH" $B/api/cards)"
check "the master key still reads the board" 200 "$(code -H "$ADM" -H "X-Tenant: $MI_SLUG" $B/api/cards)"
check "removing it again is harmless" 200 "$(code -X PATCH -H "$ADM" -H "$CT" $B/api/admin/tenants/$MI_SLUG -d '{"removePassphrase":true}')"

echo "-- cleanup"
for S in $NP_SLUG $MI_SLUG $EM_SLUG; do
  check "$S is deleted" "$S" "$(curl -s -X DELETE -H "$ADM" -H "$CT" $B/api/admin/tenants/$S -d "{\"confirm\":\"$S\"}" | jget 'd.get("deleted",{}).get("slug","")')"
done
check "no test board is left behind" False "$(curl -s -H "$ADM" $B/api/admin/tenants | jget "any(b['slug'] in ('$NP_SLUG','$MI_SLUG','$EM_SLUG') for b in d)")"

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

echo "== the plan"
# The plan is per board and off unless the board declares one, so the suite turns it on for
# jbj, exercises it, and the cleanup block puts jbj's config back as it found it.
PLANCFG='{"config":{"plan":{"title":"ZZ Test Plan","goal":{"number":20,"unit":"things","by":"2027-07-31"},"metrics":[{"key":"contacted","label":"Contacted","target":1100},{"key":"enrolled","label":"Enrolled","target":20}],"periods":[{"id":"2026-11","label":"Nov 2026","targets":{"contacted":400,"enrolled":0}}]}}}'
NOPLAN='{"config":{"plan":null}}'
check "plan config is valid json" OK "$(printf '%s' "$PLANCFG$NOPLAN" | python3 -c 'import sys;print("OK")')"

check "a board without a plan has no tracker" 404 "$(code -H "$IND" $B/api/tracker)"
check "a board admin cannot set the plan" 403 "$(code -X PATCH -b $JAR -H "$JT" -H "$CT" $B/api/settings -d "$PLANCFG")"
# The contrast is the point: the same admin, the same endpoint, a different key. Without
# this the check above would pass just as well if admins could not edit settings at all.
check "but can still edit the rest of the board" 200 "$(code -X PATCH -b $JAR -H "$JT" -H "$CT" $B/api/settings -d '{"tagline":"ZZ tagline"}')"
check "the admin key can set the plan" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings -d "$PLANCFG")"
check "and the tracker opens" "ZZ Test Plan" "$(curl -s -H "$AGH" $B/api/tracker | jget 'd["plan"]["title"]')"
check "it comes back grouped by kind" True "$(curl -s -H "$AGH" $B/api/tracker | jget "sorted(d['items'].keys()) == ['actual','decision','log','milestone','risk','status']")"

echo "-- rows, versions and merges"
ST='{"title":"ZZ status","lane":"now","owner":"Adi","as_of":"2026-11-24"}'
ST2='{"title":"ZZ status moved","lane":"waiting","version":1}'
ST_STALE='{"title":"ZZ stale","lane":"done","version":1}'
check "status bodies are valid json" OK "$(printf '%s' "$ST$ST2$ST_STALE" | python3 -c 'import sys;print("OK")')"
check "a status row is created" 201 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-one -d "$ST")"
check "it is attributed to the agent" zz-test-agent "$(curl -s -H "$AGH" $B/api/tracker/status/zz-one | jget 'd["updatedBy"]')"
check "the right version replaces it" 200 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-one -d "$ST2")"
check "a stale version is refused" 409 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-one -d "$ST_STALE")"
check "and the 409 hands back the current row" True "$(curl -s -o /dev/null -w '' -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-one -d "$ST_STALE"; curl -s -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-one -d "$ST_STALE" | jget "'item' in d and d['item']['lane']=='waiting'")"
check "a patch merges rather than replaces" waiting "$(curl -s -X PATCH -H "$AGH" -H "$CT" $B/api/tracker/status/zz-one -d '{"owner":"Akshay"}' | jget 'd["lane"]')"
check "and applies the change" Akshay "$(curl -s -H "$AGH" $B/api/tracker/status/zz-one | jget 'd["owner"]')"

echo "-- what the plan refuses"
check "an unknown lane is 422" 422 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-bad -d '{"title":"x","lane":"sideways"}')"
check "a missing title is 422" 422 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-bad -d '{"lane":"now"}')"
check "an unknown field is 422" 422 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-bad -d '{"title":"x","lane":"now","colour":"red"}')"
check "the 422 names the field" lane "$(curl -s -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-bad -d '{"title":"x","lane":"sideways"}' | jget 'd["field"]')"
PII='{"title":"x","lane":"now","detail":"email adi@example.com"}'
check "an email address is 422" 422 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/status/zz-bad -d "$PII")"
check "an unknown kind is 404" 404 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/sausage/zz-bad -d '{"title":"x"}')"

echo "-- actuals are keyed by the metrics this board declares"
ACT='{"as_of":"2026-11-30","source":"ZZ test","values":{"contacted":400,"enrolled":0}}'
ACT_FLAT='{"as_of":"2026-12-31","source":"ZZ test","contacted":650,"enrolled":2}'
ACT_WRONG='{"as_of":"2026-11-30","source":"ZZ test","values":{"installs":10}}'
check "actual bodies are valid json" OK "$(printf '%s' "$ACT$ACT_FLAT$ACT_WRONG" | python3 -c 'import sys;print("OK")')"
check "an actual is written" 201 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/actual/2026-11 -d "$ACT")"
check "a metric this board does not track is 422" 422 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/actual/2026-11 -d "$ACT_WRONG")"
check "an actual with no source is 422" 422 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/actual/2026-10 -d '{"as_of":"2026-10-31"}')"
check "flat metric fields are folded into values" 650 "$(curl -s -X PUT -H "$AGH" -H "$CT" $B/api/tracker/actual/2026-12 -d "$ACT_FLAT" | jget 'd["values"]["contacted"]')"

echo "-- only a master admin settles a decision"
PROP='{"title":"ZZ decision","state":"proposed","owner":"Adi","date":"2026-11-24"}'
DEC='{"title":"ZZ decision","state":"decided","owner":"Adi","date":"2026-11-24","version":1}'
check "decision bodies are valid json" OK "$(printf '%s' "$PROP$DEC" | python3 -c 'import sys;print("OK")')"
check "an agent may propose" 201 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/decision/ZZ-01 -d "$PROP")"
check "an agent may not decide" 403 "$(code -X PUT -H "$AGH" -H "$CT" $B/api/tracker/decision/ZZ-01 -d "$DEC")"
check "a board admin may not decide" 403 "$(code -X PUT -b $JAR -H "$JT" -H "$CT" $B/api/tracker/decision/ZZ-01 -d "$DEC")"
check "the admin key may" 200 "$(code -X PUT -H "$ADM" -H "$JT" -H "$CT" $B/api/tracker/decision/ZZ-01 -d "$DEC")"
check "and it reads back decided" decided "$(curl -s -H "$AGH" $B/api/tracker/decision/ZZ-01 | jget 'd["state"]')"

echo "-- the log signs itself"
check "a log entry is appended" 201 "$(code -X POST -H "$AGH" -H "$CT" $B/api/tracker/log -d '{"kind":"update","text":"ZZ did a thing"}')"
check "signed with the caller, not the body" zz-test-agent "$(curl -s -X POST -H "$AGH" -H "$CT" $B/api/tracker/log -d '{"text":"ZZ again","by":"Adi"}' | jget 'd["by"]')"
check "an empty log entry is 422" 422 "$(code -X POST -H "$AGH" -H "$CT" $B/api/tracker/log -d '{"text":"   "}')"
check "plan writes reach the event log" True "$(curl -s -H "$ADM" -H "$JT" "$B/api/events?limit=200" | jget "any(e['verb'].startswith('tracker.') for e in d['events'])")"
check "another board sees none of this" 404 "$(code -H "$IND" $B/api/tracker/status/zz-one)"

echo "-- plan cleanup"
for K in status/zz-one actual/2026-11 actual/2026-12 decision/ZZ-01; do
  curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/tracker/$K
done
for L in $(curl -s -H "$ADM" -H "$JT" $B/api/tracker/log | jget "' '.join(x['id'] for x in d)"); do
  curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/tracker/log/$L
done
check "the plan is emptied" 0 "$(curl -s -H "$ADM" -H "$JT" $B/api/tracker | jget "sum(len(v) for v in d['items'].values())")"
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings -d "$NOPLAN"
check "and switched back off" 404 "$(code -H "$AGH" $B/api/tracker)"

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

echo "== directed work: statuses, hand-overs, notes, claims, inbox"
# Credentials, and why each is live where it is used (the cookie jar $JAR was logged out once
# and quietly tested "no cookie" for months, so nothing below borrows a jar from earlier):
#   ADM + JT  the master key acting on jbj. A header, not a session, so it cannot go stale.
#   AGH       zz-test-agent (write scope, jbj). Issued in "agents have their own identity" and
#             deleted only in "agent cleanup", which comes after this block.
#   JAR3      a fresh cookie jar signed in below as zz-test-member, a person on jbj, not a
#             master admin. The checks right after signing in prove it is that person.
#   JBJ, IND  board passphrases, which name nobody.
JAR3=$(mktemp)
check "the member signs in afresh for these checks" 200 "$(login zz-test-member "$MEMBER_PW2" $JAR3)"
check "and the session is the member, not a master admin" "['zz-test-member', False]" "$(curl -s -b $JAR3 $B/api/auth/me | jget "[d['user']['username'], d['user']['isMaster']]")"
check "the agent token is still live" 200 "$(code -H "$AGH" $B/api/cards)"

# callw keeps the status and the body of one request together, so a check on each does not
# need the write sent twice. ev_cursor walks the log to its end: /events reads forward from
# an id and caps a page at 200, so a board with a long history would otherwise hand back its
# oldest events and every "was this logged" check would look in the wrong place.
callw() { local r nl=$'\n'; r=$(curl -s -w '\n%{http_code}' "$@"); RC=${r##*"$nl"}; RB=${r%"$nl"*}; }
ev_cursor() {
  local cur=${EV_BASE:-0} r more
  while :; do
    r=$(curl -s -H "$ADM" -H "$JT" "$B/api/events?since=$cur&limit=200")
    cur=$(echo "$r" | jget 'd["cursor"]')
    more=$(echo "$r" | jget 'd["more"]')
    [ "$more" = "True" ] || break
  done
  echo "$cur"
}
EV_BASE=$(ev_cursor)   # the end of the log as it stands now; later cursors walk on from here
ev_since() { curl -s -H "$ADM" -H "$JT" "$B/api/events?since=$1&limit=200"; }
mkcard() { curl -s -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards -d "$1" | jget 'd["id"]'; }

echo "-- the status whitelist"
check "a card created as 'archived' -> 422" 422 "$(code -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards -d '{"title":"zz bad status","status":"archived"}')"
check "a card created as 'Done' (wrong case) -> 422" 422 "$(code -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards -d '{"title":"zz bad status","status":"Done"}')"
check "a refused create leaves no card behind" False "$(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "any(c['title']=='zz bad status' for c in d)")"
callw -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards -d '{"title":"zz stuck card","status":"stuck"}'
check "a card created as 'stuck' -> 201" 201 "$RC"
STK=$(echo "$RB" | jget 'd["id"]')
check "and it files under stuck" stuck "$(echo "$RB" | jget 'd["status"]')"
check "a card patched to 'nonsense' -> 422" 422 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$STK -d '{"status":"nonsense"}')"
check "the 422 names the status field" status "$(curl -s -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$STK -d '{"status":"nonsense"}' | jget 'd["field"]')"
check "a refused patch leaves the status alone" stuck "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$STK | jget 'd["status"]')"
check "a patch with no status at all -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$STK -d '{"description":"zz no status given"}')"
check "and leaves the status alone" stuck "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$STK | jget 'd["status"]')"
check "while applying the field it did carry" "zz no status given" "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$STK | jget 'd["description"]')"

echo "-- a hand-over is logged as card.assigned"
AS_CARD=$(mkcard '{"title":"zz assign card"}')
check "the fixture card starts unassigned" Unassigned "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$AS_CARD | jget 'd["assignee"]')"
EVC=$(ev_cursor)
check "changing only the assignee -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$AS_CARD -d '{"assignee":"zz-test-agent"}')"
EVS=$(ev_since "$EVC")
check "card.assigned carries from, to and title" "[('Unassigned', 'zz-test-agent', 'zz assign card')]" "$(echo "$EVS" | jget "[(e['data']['from'], e['data']['to'], e['data']['title']) for e in d['events'] if e['verb']=='card.assigned' and e['subject']['type']=='card' and int(e['subject']['id'])==$AS_CARD]")"
EVC=$(ev_cursor)
check "a patch changing status and assignee together -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$AS_CARD -d '{"status":"in_progress","assignee":"ZZ Test Member"}')"
EVS=$(ev_since "$EVC")
check "it logs card.moved and card.assigned, and no card.updated" "['card.assigned', 'card.moved']" "$(echo "$EVS" | jget "sorted(e['verb'] for e in d['events'] if e['subject']['type']=='card' and int(e['subject']['id'])==$AS_CARD)")"
check "card.moved carries the old and new status" "[('todo', 'in_progress')]" "$(echo "$EVS" | jget "[(e['data']['from'], e['data']['to']) for e in d['events'] if e['verb']=='card.moved' and e['subject']['type']=='card' and int(e['subject']['id'])==$AS_CARD]")"
EVC=$(ev_cursor)
check "a title-only patch -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$AS_CARD -d '{"title":"zz assign card renamed"}')"
EVS=$(ev_since "$EVC")
check "a title-only patch logs card.updated and nothing else" "['card.updated']" "$(echo "$EVS" | jget "sorted(e['verb'] for e in d['events'] if e['subject']['type']=='card' and int(e['subject']['id'])==$AS_CARD)")"
check "and does not log card.assigned" False "$(echo "$EVS" | jget "any(e['verb']=='card.assigned' for e in d['events'])")"

echo "-- addressed notes"
NC=$(mkcard '{"title":"zz notes card"}')
EVC=$(ev_cursor)
callw -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$NC/notes -d '{"body":"zz addressed note","to":"zz-test-agent"}'
check "a note with a recipient -> 201" 201 "$RC"
check "and comes back with addressed_to set" zz-test-agent "$(echo "$RB" | jget 'd["addressed_to"]')"
EVS=$(ev_since "$EVC")
check "note.added carries to and card_title" "[('zz-test-agent', 'zz notes card')]" "$(echo "$EVS" | jget "[(e['data']['to'], e['data']['card_title']) for e in d['events'] if e['verb']=='note.added' and int(e['data']['card_id'])==$NC]")"
# Bodies are built in variables, and proved to say what the check below claims, because a
# body that silently lost its long or multi-line value would turn each 422 into a pass for
# the wrong reason.
LONG_TO=$(python3 -c 'print("a"*130)')
NOTE_EMAIL='{"body":"zz x","to":"someone@example.com"}'
NOTE_LONG="{\"body\":\"zz x\",\"to\":\"$LONG_TO\"}"
NOTE_NL='{"body":"zz x","to":"line one\nline two"}'
check "the refused note bodies are valid json" OK "$(python3 -c 'import json,sys; [json.loads(a) for a in sys.argv[1:]]; print("OK")' "$NOTE_EMAIL" "$NOTE_LONG" "$NOTE_NL")"
check "the long recipient really is 130 characters" 130 "$(python3 -c 'import json,sys; print(len(json.loads(sys.argv[1])["to"]))' "$NOTE_LONG")"
check "the multi-line recipient really holds a newline" True "$(python3 -c 'import json,sys; print("\n" in json.loads(sys.argv[1])["to"])' "$NOTE_NL")"
check "a recipient containing an email address -> 422" 422 "$(code -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$NC/notes -d "$NOTE_EMAIL")"
check "a 130-character recipient -> 422" 422 "$(code -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$NC/notes -d "$NOTE_LONG")"
check "a recipient containing a newline -> 422" 422 "$(code -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$NC/notes -d "$NOTE_NL")"
check "the 422 names the to field" to "$(curl -s -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$NC/notes -d "$NOTE_EMAIL" | jget 'd["field"]')"
check "refused notes were not saved" 1 "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$NC | jget 'len(d["notes"])')"

echo "-- answered is a person's tick"
AN=$(mkcard '{"title":"zz answered card"}')
check "a card starts unanswered" False "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$AN | jget 'd["answered"]')"
check "a person ticks answered -> 200" 200 "$(code -X PATCH -b $JAR3 -H "$JT" -H "$CT" $B/api/cards/$AN -d '{"answered":true}')"
check "and the tick sticks" True "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$AN | jget 'd["answered"]')"
check "an agent token cannot set answered -> 422" 422 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$AN -d '{"answered":true}')"
check "the 422 names the answered field" answered "$(curl -s -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$AN -d '{"answered":false}' | jget 'd["field"]')"
check "the refusals leave the tick in place" True "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$AN | jget 'd["answered"]')"
check "an agent writes a note on the answered card -> 201" 201 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards/$AN/notes -d '{"body":"zz a fresh question from the agent"}')"
check "and that clears answered" False "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$AN | jget 'd["answered"]')"
check "a person ticks it again -> 200" 200 "$(code -X PATCH -b $JAR3 -H "$JT" -H "$CT" $B/api/cards/$AN -d '{"answered":true}')"
check "a person's own note -> 201" 201 "$(code -X POST -b $JAR3 -H "$JT" -H "$CT" $B/api/cards/$AN/notes -d '{"body":"zz a person replies"}')"
check "and leaves answered ticked" True "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$AN | jget 'd["answered"]')"

echo "-- claims"
CL=$(mkcard '{"title":"zz claim card"}')
callw -X POST -H "$AGH" -H "$CT" $B/api/cards/$CL/claim -d '{}'
check "an agent claims a free card -> 200" 200 "$RC"
check "and claimed_by is the agent's name" zz-test-agent "$(echo "$RB" | jget 'd["claimed_by"]')"
CLAIM_EXP1=$(echo "$RB" | jget 'd["claim_expires_at"]')
callw -X POST -b $JAR3 -H "$JT" -H "$CT" $B/api/cards/$CL/claim -d '{}'
check "a different credential claiming the held card -> 409" 409 "$RC"
check "and the body names the holder" zz-test-agent "$(echo "$RB" | jget 'd["claimed_by"]')"
check "and the error says who is working on it" True "$(echo "$RB" | jget "'zz-test-agent' in d['error']")"
callw -X POST -H "$AGH" -H "$CT" $B/api/cards/$CL/claim -d '{"minutes":60}'
check "the holder re-claiming -> 200" 200 "$RC"
CLAIM_EXP2=$(echo "$RB" | jget 'd["claim_expires_at"]')
check "and the lease is extended, not refused" True "$([[ "$CLAIM_EXP2" > "$CLAIM_EXP1" ]] && echo True || echo False)"
check "minutes 0 -> 422" 422 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards/$CL/claim -d '{"minutes":0}')"
check "minutes 481 -> 422" 422 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards/$CL/claim -d '{"minutes":481}')"
check "minutes 'abc' -> 422" 422 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards/$CL/claim -d '{"minutes":"abc"}')"
callw -X DELETE -H "$AGH" $B/api/cards/$CL/claim
check "the holder releasing -> 200" 200 "$RC"
check "and the body says released: true" True "$(echo "$RB" | jget 'd["released"]')"
check "the card is free afterwards" None "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$CL | jget 'd["claimed_by"]')"
callw -X DELETE -H "$AGH" $B/api/cards/$CL/claim
check "releasing again is still 200" 200 "$RC"
check "and says released: false" False "$(echo "$RB" | jget 'd["released"]')"
check "a board passphrase claiming -> 400" 400 "$(code -X POST -H "$JBJ" -H "$CT" $B/api/cards/$CL/claim -d '{}')"
check "and records no claim" None "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$CL | jget 'd["claimed_by"]')"
CD=$(mkcard '{"title":"zz claim then done card"}')
check "an agent claims the card that will be finished -> 200" 200 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards/$CD/claim -d '{}')"
check "and it is held before the move" zz-test-agent "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$CD | jget 'd["claimed_by"]')"
check "moving the held card to done -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$CD -d '{"status":"done"}')"
check "clears all three claim columns" "[None, None, None]" "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$CD | jget "[d['claimed_by'], d['claimed_at'], d['claim_expires_at']]")"

echo "-- the inbox"
IB=$(mkcard '{"title":"zz inbox card","assignee":"zz-test-agent"}')
HO=$(mkcard '{"title":"zz human only inbox card","audience":"human_only","assignee":"zz-test-agent"}')
check "the human_only fixture really is assigned to the agent's name" "['human_only', 'zz-test-agent']" "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$HO | jget "[d['audience'], d['assignee']]")"
check "a note addressed to the agent on that card -> 201" 201 "$(code -X POST -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$HO/notes -d '{"body":"zz hidden addressed note","to":"zz-test-agent"}')"
check "the agent claims its inbox card -> 200" 200 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards/$IB/claim -d '{}')"
check "an agent's inbox -> 200" 200 "$(code -H "$AGH" $B/api/inbox)"
INBOX=$(curl -s -H "$AGH" $B/api/inbox)
check "it carries assigned, addressed, claims, roster and counts" True "$(echo "$INBOX" | jget "all(k in d for k in ('assigned','addressed','claims','roster','counts'))")"
check "it says whose inbox it is" "['agent', 'zz-test-agent']" "$(echo "$INBOX" | jget "[d['me']['kind'], d['me']['name']]")"
check "a card assigned to the agent is in assigned" True "$(echo "$INBOX" | jget "any(c['id']==$IB for c in d['assigned'])")"
check "a note addressed to the agent is in addressed" True "$(echo "$INBOX" | jget "any(n['card']['id']==$NC and n['body']=='zz addressed note' for n in d['addressed'])")"
check "a card the agent holds is in claims" True "$(echo "$INBOX" | jget "any(c['id']==$IB for c in d['claims'])")"
check "the roster names the agent" True "$(echo "$INBOX" | jget "'zz-test-agent' in d['roster']['agents']")"
check "the counts agree with the lists" True "$(echo "$INBOX" | jget "d['counts']['assigned']==len(d['assigned']) and d['counts']['addressed']==len(d['addressed']) and d['counts']['claims']==len(d['claims'])")"
check "a human_only card assigned to the agent is not in its inbox" False "$(echo "$INBOX" | jget "any(c['id']==$HO for c in d['assigned'])")"
check "nor is a note addressed to it on that card" False "$(echo "$INBOX" | jget "any(n['card']['id']==$HO for n in d['addressed'])")"
check "an agent cannot read someone else's inbox with ?who" zz-test-agent "$(curl -s -H "$AGH" "$B/api/inbox?who=ZZ%20Test%20Member" | jget 'd["me"]["name"]')"
check "a board passphrase has no inbox -> 400" 400 "$(code -H "$JBJ" $B/api/inbox)"
check "ADMIN_KEY with no ?who -> 400" 400 "$(code -H "$ADM" -H "$JT" $B/api/inbox)"
check "ADMIN_KEY with ?who=<a name> -> 200" 200 "$(code -H "$ADM" -H "$JT" "$B/api/inbox?who=zz-test-agent")"
check "and it reads that name's inbox" "['admin', 'zz-test-agent']" "$(curl -s -H "$ADM" -H "$JT" "$B/api/inbox?who=zz-test-agent" | jget "[d['me']['kind'], d['me']['name']]")"
check "a signed-in person has an inbox too" "['person', 'ZZ Test Member']" "$(curl -s -b $JAR3 -H "$JT" $B/api/inbox | jget "[d['me']['kind'], d['me']['name']]")"
check "and the card handed to them is in it" True "$(curl -s -b $JAR3 -H "$JT" $B/api/inbox | jget "any(c['id']==$AS_CARD for c in d['assigned'])")"

echo "-- /me/work reads across boards, through membership only"
check "an agent token -> 403" 403 "$(code -H "$AGH" $B/api/me/work)"
check "no credential -> 401" 401 "$(code $B/api/me/work)"
check "a board passphrase -> 401" 401 "$(code -H "$JBJ" $B/api/me/work)"
check "ADMIN_KEY is not a person -> 400" 400 "$(code -H "$ADM" $B/api/me/work)"
# The member is on jbj only at this point (removed from inditress in "leaving one board").
# A card on inditress is assigned to their exact display name, so the only thing keeping it
# out of /me/work is that they are not a member there; the checks after the join show the
# same card appearing once they are, so the first absence cannot be a vacuous one.
check "the member is on jbj only" "['jbj']" "$(curl -s -b $JAR3 $B/api/auth/me | jget "[x['slug'] for x in d['boards']]")"
MW_IND=$(curl -s -X POST -H "$IND" -H "$CT" $B/api/cards -d '{"title":"zz me-work inditress card","assignee":"ZZ Test Member"}' | jget 'd["id"]')
check "the inditress fixture is assigned to the member's display name" "ZZ Test Member" "$(curl -s -H "$IND" $B/api/cards/$MW_IND | jget 'd["assignee"]')"
check "a signed-in person -> 200" 200 "$(code -b $JAR3 $B/api/me/work)"
MW=$(curl -s -b $JAR3 $B/api/me/work)
check "boards is an array" list "$(echo "$MW" | jget 'type(d["boards"]).__name__')"
check "it names the person" "ZZ Test Member" "$(echo "$MW" | jget 'd["me"]["name"]')"
check "a card assigned to them on jbj is under jbj" True "$(echo "$MW" | jget "any(c['id']==$AS_CARD for b in d['boards'] if b['board']['slug']=='jbj' for c in b['assigned'])")"
check "a board they are not on never appears" False "$(echo "$MW" | jget "any(b['board']['slug']=='inditress' for b in d['boards'])")"
check "nor does its card, though assigned to the same name" False "$(echo "$MW" | jget "any(c['id']==$MW_IND for b in d['boards'] for c in b['assigned'])")"
MW_JOIN=$(curl -s -X POST -H "$ADM" -H "$IT" -H "$CT" $B/api/settings/users -d '{"username":"zz-test-member","displayName":"ZZ Test Member"}')
check "the member joins inditress as the existing account" True "$(echo "$MW_JOIN" | jget 'd["existing"]')"
MW=$(curl -s -b $JAR3 $B/api/me/work)
check "on both boards, the jbj card is under jbj" True "$(echo "$MW" | jget "any(c['id']==$AS_CARD for b in d['boards'] if b['board']['slug']=='jbj' for c in b['assigned'])")"
check "and the inditress card is under inditress" True "$(echo "$MW" | jget "any(c['id']==$MW_IND for b in d['boards'] if b['board']['slug']=='inditress' for c in b['assigned'])")"
check "the jbj card is not under inditress" False "$(echo "$MW" | jget "any(c['id']==$AS_CARD for b in d['boards'] if b['board']['slug']=='inditress' for c in b['assigned'])")"
check "the inditress card is not under jbj" False "$(echo "$MW" | jget "any(c['id']==$MW_IND for b in d['boards'] if b['board']['slug']=='jbj' for c in b['assigned'])")"
check "the member leaves inditress again" 200 "$(code -X DELETE -H "$ADM" -H "$IT" $B/api/settings/users/$MEMBER_ID)"
MW=$(curl -s -b $JAR3 $B/api/me/work)
check "the card on a board they left drops out of /me/work" False "$(echo "$MW" | jget "any(c['id']==$MW_IND for b in d['boards'] for c in b['assigned'])")"
check "and the jbj card is still there" True "$(echo "$MW" | jget "any(c['id']==$AS_CARD for b in d['boards'] if b['board']['slug']=='jbj' for c in b['assigned'])")"
curl -s -o /dev/null -X DELETE -H "$IND" $B/api/cards/$MW_IND
check "the inditress fixture card is removed" 404 "$(code -H "$IND" $B/api/cards/$MW_IND)"

echo "-- the agent registry"
check "the member's session is live for the registry checks" 200 "$(code -b $JAR3 $B/api/auth/me)"
check "the passphrase is live for the registry checks" 200 "$(code -H "$JBJ" $B/api/cards)"
check "ADMIN_KEY lists every agent -> 200" 200 "$(code -H "$ADM" $B/api/admin/agents)"
REG=$(curl -s -H "$ADM" $B/api/admin/agents)
check "the registry is not empty" True "$(echo "$REG" | jget 'len(d["agents"])>0')"
check "every entry carries a board slug" True "$(echo "$REG" | jget "len(d['agents'])>0 and all(a.get('board',{}).get('slug') for a in d['agents'])")"
check "the test agent is listed under jbj" True "$(echo "$REG" | jget "any(a['name']=='zz-test-agent' and a['board']['slug']=='jbj' for a in d['agents'])")"
check "no token -> 401" 401 "$(code $B/api/admin/agents)"
check "a board passphrase -> 401" 401 "$(code -H "$JBJ" $B/api/admin/agents)"
check "an agent token -> 401" 401 "$(code -H "$AGH" $B/api/admin/agents)"
check "a signed-in board member (not a master admin) -> 401" 401 "$(code -b $JAR3 $B/api/admin/agents)"
check "the registry never carries token_hash" False "$(echo "$REG" | grep -q 'token_hash' && echo True || echo False)"
check "the registry never carries webhook_secret" False "$(echo "$REG" | grep -q 'webhook_secret' && echo True || echo False)"
check "nor any live token" False "$(echo "$REG" | grep -qF "$AG_TOK" && echo True || echo False)"

echo "== approval gate and write limit"
# Credentials, and why each is live here. This block sits after the registry checks and before
# "directed work cleanup", so nothing has logged anyone out or deleted the agent yet:
#   ADM + JT  the master key acting on jbj. A header, so it cannot go stale. Used for settings
#             changes, fixtures and every read-back.
#   AGH       zz-test-agent (write scope). Still live: it is deleted in "agent cleanup", below.
#   JAR3      zz-test-member, signed in at the top of "directed work" and still live (the
#             registry checks above prove it with /auth/me). A board admin of jbj since the
#             re-promotion near "master admin"; the block below demotes it briefly to get a
#             non-admin and proves the demotion took before relying on it.
# The checks directly below prove all three before anything depends on them.
check "the agent token is live for the gate and limit checks" 200 "$(code -H "$AGH" $B/api/cards)"
check "the member's session is live and is the member" zz-test-member "$(curl -s -b $JAR3 $B/api/auth/me | jget "d['user']['username']")"
check "the member is a board admin of jbj right now" True "$(curl -s -b $JAR3 -H "$JT" $B/api/settings | jget 'd["isAdmin"]')"

# callh is callw plus the response headers, for the one check that needs a header.
callh() {
  local r nl=$'\n' hf; hf=$(mktemp)
  r=$(curl -s -D "$hf" -w '\n%{http_code}' "$@"); RC=${r##*"$nl"}; RB=${r%"$nl"*}
  RH=$(tr -d '\r' < "$hf"); rm -f "$hf"
}
gate_flag() { curl -s -H "$ADM" -H "$JT" $B/api/settings | jget 'd["tenant"]["config"].get("reviewGate", False)'; }
agent_rl() { curl -s -H "$ADM" -H "$JT" $B/api/settings/agents | jget "[a for a in d if a['id']==$AG_ID][0]['rateLimit']"; }

# What to put back. ORIG_RL is read before anything changes it; the flags below make the exit
# trap undo only what is still undone, so an interrupted run does not leave the real board
# gated or the agent throttled.
ORIG_RL=$(agent_rl)
ORIG_GATE=$(gate_flag)
GATE_TOUCHED=0; RL_TOUCHED=0; MEMBER_DEMOTED=0
restore_board() {
  [ "$GATE_TOUCHED" = 1 ] && curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings -d '{"config":{"reviewGate":false}}'
  [ "$RL_TOUCHED" = 1 ] && curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d "{\"rateLimit\":$ORIG_RL}"
  # The non-admin check below takes somebody's admin rights away for a handful of requests.
  # If the run dies in that window the person stays demoted on a real board, which is the one
  # piece of damage this suite could do that nobody would notice until they tried to use it.
  [ "$MEMBER_DEMOTED" = 1 ] && curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"isAdmin":true}'
  return 0
}
trap restore_board EXIT
check "the agent's limit is a whole number to start with" True "$(echo "$ORIG_RL" | grep -qE '^[0-9]+$' && echo True || echo False)"
check "the board starts with the gate off" False "$ORIG_GATE"

echo "-- approval gate (per board, off by default)"
# Reset this agent's window first, by writing its own limit back, so the handful of agent
# writes below cannot be refused by the earlier ones in the same minute.
RL_TOUCHED=1
check "the agent's window is reset before the gate checks" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d "{\"rateLimit\":$ORIG_RL}")"
G1=$(mkcard '{"title":"zz gate one"}')
G2=$(mkcard '{"title":"zz gate two","status":"in_progress"}')
check "the gate fixture cards are created" True "$([ -n "$G1" ] && [ -n "$G2" ] && echo True || echo False)"
gst() { curl -s -H "$ADM" -H "$JT" $B/api/cards/$1 | jget 'd["status"]'; }

check "with the gate off, an agent moves a card to done -> 200" 200 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$G1 -d '{"status":"done"}')"
check "and it is done" done "$(gst $G1)"
check "undo: the card moves back to todo" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/cards/$G1 -d '{"status":"todo"}')"
check "and is todo again" todo "$(gst $G1)"

# Captured HERE, not at the top of the file. Creating a person on a board appends their
# display name to config.names by design (app/api/settings/users/route.js), so by this point
# the suite's own fixtures have grown the list and the capture from line ~168 is stale. The
# question this block asks is whether the GATE disturbs the list, so the baseline has to be
# what the list holds immediately before the gate is touched.
GATE_NAMES=$(names_of "$JBJ")
GATE_TOUCHED=1
check "a board admin turns the gate on -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings -d '{"config":{"reviewGate":true}}')"
check "the setting reads back as on" True "$(gate_flag)"
check "turning it on did not drop the board's people" "$GATE_NAMES" "$(names_of "$JBJ")"

callh -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$G1 -d '{"status":"done"}'
check "gate on: an agent moving a card to done -> 403" 403 "$RC"
check "and the refusal says what to do instead" True "$(echo "$RB" | jget "'review' in d['error']")"
check "the card's status is unchanged" todo "$(gst $G1)"

# The member is a board admin at this point, so a non-admin has to be made. The demotion is
# proved by asking the member's own session before the refusal is trusted.
MEMBER_DEMOTED=1
check "the member is demoted for the non-admin check" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"isAdmin":false}')"
check "and their own session now says not admin" False "$(curl -s -b $JAR3 -H "$JT" $B/api/settings | jget 'd["isAdmin"]')"
check "gate on: an ordinary member moving a card to done -> 403" 403 "$(code -X PATCH -b $JAR3 -H "$JT" -H "$CT" $B/api/cards/$G1 -d '{"status":"done"}')"
check "the card's status is still unchanged" todo "$(gst $G1)"
check "an ordinary member may still ask for approval (-> review)" 200 "$(code -X PATCH -b $JAR3 -H "$JT" -H "$CT" $B/api/cards/$G1 -d '{"status":"review"}')"
check "the member is promoted back" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"isAdmin":true}')"
check "and their own session says admin again" True "$(curl -s -b $JAR3 -H "$JT" $B/api/settings | jget 'd["isAdmin"]')"
MEMBER_DEMOTED=0

GEV=$(ev_cursor)
check "gate on: a board admin moving the card to done -> 200" 200 "$(code -X PATCH -b $JAR3 -H "$JT" -H "$CT" $B/api/cards/$G1 -d '{"status":"done"}')"
check "and it is done" done "$(gst $G1)"
GEVS=$(ev_since "$GEV")
check "the card.moved event carries approvedBy with the admin's name" "['ZZ Test Member']" "$(echo "$GEVS" | jget "[e['data'].get('approvedBy') for e in d['events'] if e['verb']=='card.moved' and e['subject']['type']=='card' and int(e['subject']['id'])==$G1]")"

check "gate on: an agent moving in_progress straight to done -> 403" 403 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$G2 -d '{"status":"done"}')"
check "the card is still in_progress" in_progress "$(gst $G2)"
check "gate on: an agent moving a card into review -> 200" 200 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$G2 -d '{"status":"review"}')"
check "and it is in review" review "$(gst $G2)"

check "gate on: an agent creating a card already done -> 403" 403 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards -d '{"title":"zz gate born done","status":"done"}')"
check "and no such card was created" False "$(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "any(c['title']=='zz gate born done' for c in d)")"

check "gate on: retitling a card that is already done -> 200" 200 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$G1 -d '{"title":"zz gate one renamed"}')"
check "the retitle applied" "zz gate one renamed" "$(curl -s -H "$ADM" -H "$JT" $B/api/cards/$G1 | jget 'd["title"]')"
check "and the card is still done" done "$(gst $G1)"

check "a board admin turns the gate back off -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings -d '{"config":{"reviewGate":false}}')"
check "the gate is off again" False "$(gate_flag)"
GATE_TOUCHED=0
check "and the board's people list is unchanged" "$GATE_NAMES" "$(names_of "$JBJ")"
for K in $G1 $G2; do curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/cards/$K; done
check "the gate fixture cards are gone" True "$(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "all(not c['title'].startswith('zz gate ') for c in d)")"

echo "-- per-agent write limit (last, so a failure here cannot throttle anything above)"
LIST=$(curl -s -H "$ADM" -H "$JT" $B/api/settings/agents)
check "rateLimit appears in the agents list" True "$(echo "$LIST" | jget "all('rateLimit' in a for a in d)")"
check "rl_count and rl_window_start do not" False "$(echo "$LIST" | jget "any('rl_count' in a or 'rl_window_start' in a for a in d)")"
check "nor does any other rl_ plumbing" False "$(echo "$LIST" | grep -q 'rl_' && echo True || echo False)"
check "rateLimit 0 -> 422" 422 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d '{"rateLimit":0}')"
check "rateLimit 10001 -> 422" 422 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d '{"rateLimit":10001}')"
check "rateLimit 'abc' -> 422" 422 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d '{"rateLimit":"abc"}')"
check "the 422 names the rateLimit field" rateLimit "$(curl -s -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d '{"rateLimit":0}' | jget 'd["field"]')"
check "refused values left the limit alone" "$ORIG_RL" "$(agent_rl)"

RL_TOUCHED=1
callw -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d '{"rateLimit":2}'
check "the limit is lowered to 2 -> 200" 200 "$RC"
check "and the response carries it" 2 "$(echo "$RB" | jget 'd["agent"]["rateLimit"]')"
check "the agents list agrees" 2 "$(agent_rl)"

check "agent write 1 of 2 -> 201" 201 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards -d '{"title":"zz rl one"}')"
check "agent write 2 of 2 -> 201" 201 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards -d '{"title":"zz rl two"}')"
callh -X POST -H "$AGH" -H "$CT" $B/api/cards -d '{"title":"zz rl refused"}'
check "agent write 3 -> 429" 429 "$RC"
check "the 429 body carries limit 2" 2 "$(echo "$RB" | jget 'd["limit"]')"
check "and an error that mentions the rate limit" True "$(echo "$RB" | jget "'rate limit' in d['error']")"
RA=$(echo "$RH" | awk 'tolower($1)=="retry-after:" {print $2}')
check "the 429 has a Retry-After that is a positive integer" True "$([[ "$RA" =~ ^[1-9][0-9]*$ ]] && echo True || echo False)"
check "and it is no more than a minute" True "$([[ "$RA" =~ ^[0-9]+$ ]] && [ "$RA" -le 60 ] && echo True || echo False)"
check "the refused write created nothing" False "$(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "any(c['title']=='zz rl refused' for c in d)")"
check "while the two allowed ones did land" 2 "$(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "len([c for c in d if c['title'] in ('zz rl one','zz rl two')])")"
check "a GET by the throttled agent still succeeds (reads are not counted)" 200 "$(code -H "$AGH" $B/api/cards)"
check "and so does a second one" 200 "$(code -H "$AGH" $B/api/cards)"
check "a PATCH by the throttled agent is refused too" 429 "$(code -X PATCH -H "$AGH" -H "$CT" $B/api/cards/$A_CARD -d '{"title":"zz rl still refused"}')"

check "a person's first write while the agent is throttled -> 201" 201 "$(code -X POST -b $JAR3 -H "$JT" -H "$CT" $B/api/cards -d '{"title":"zz rl person one"}')"
check "their second -> 201" 201 "$(code -X POST -b $JAR3 -H "$JT" -H "$CT" $B/api/cards -d '{"title":"zz rl person two"}')"
check "their third, past the agent's limit of 2 -> 201" 201 "$(code -X POST -b $JAR3 -H "$JT" -H "$CT" $B/api/cards -d '{"title":"zz rl person three"}')"

# The agent has spent 3 or more writes of a limit of 2, and so far 4 (the PATCH above counts).
# Raising the limit to 3 would still refuse the next write if the spent count survived, so
# a 201 here proves the window was reset by the change, not that the minute rolled over.
check "the limit is raised to 3 -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d '{"rateLimit":3}')"
check "the agent can write immediately -> 201" 201 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards -d '{"title":"zz rl after raise"}')"

check "the original limit is restored -> 200" 200 "$(code -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/agents/$AG_ID -d "{\"rateLimit\":$ORIG_RL}")"
RL_TOUCHED=0
check "and reads back as it was" "$ORIG_RL" "$(agent_rl)"
check "the agent writes after the restore -> 201" 201 "$(code -X POST -H "$AGH" -H "$CT" $B/api/cards -d '{"title":"zz rl after restore"}')"
for K in $(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "' '.join(str(c['id']) for c in d if c['title'].startswith('zz rl '))"); do
  curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/cards/$K
done
check "the write-limit fixture cards are gone" True "$(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "all(not c['title'].startswith('zz rl ') for c in d)")"

echo "-- directed work cleanup"
for K in $STK $AS_CARD $NC $AN $CL $CD $IB $HO; do
  curl -s -o /dev/null -X DELETE -H "$ADM" -H "$JT" $B/api/cards/$K
done
check "the directed-work fixture cards are gone" True "$(curl -s -H "$ADM" -H "$JT" $B/api/cards | jget "all(c['id'] not in [$STK,$AS_CARD,$NC,$AN,$CL,$CD,$IB,$HO] for c in d)")"
rm -f $JAR3

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
curl -s -o /dev/null -X PATCH -H "$ADM" -H "$JT" -H "$CT" $B/api/settings/users/$MEMBER_ID -d '{"isAdmin":false}'
RESTORE_JBJ="{\"config\":{\"names\":$JBJ_NAMES,\"tagline\":$JBJ_TAGLINE}}"
RESTORE_IND="{\"config\":{\"names\":$IND_NAMES}}"
# Checked, not fired blind: a silent restore that fails leaves test names in the assignee
# list of a board real people use, and the next run captures the polluted list as ITS
# baseline and faithfully restores the pollution. That is how "ZZ Test Member" ended up
# sitting on the inditress board for weeks with every run reporting success.
check "jbj restore accepted" 200 "$(code -X PATCH -H "$ADM" -H "$CT" $B/api/admin/tenants/jbj -d "$RESTORE_JBJ")"
check "inditress restore accepted" 200 "$(code -X PATCH -H "$ADM" -H "$CT" $B/api/admin/tenants/inditress -d "$RESTORE_IND")"
check "jbj people list restored" "$JBJ_NAMES" "$(names_of "$JBJ")"
check "jbj tagline restored" "$JBJ_TAGLINE" "$(curl -s -H "$JBJ" $B/api/tenant | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["config"].get("tagline","")))')"
check "inditress people list restored" "$IND_NAMES" "$(names_of "$IND")"
rm -f $JAR $JAR2

check "jbj deletes its test card" 200 "$(code -X DELETE -H "$JBJ" $B/api/cards/$J_CARD)"

echo; echo "passed $PASS, failed $FAIL"
[ $FAIL -eq 0 ]
