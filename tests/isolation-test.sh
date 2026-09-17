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
