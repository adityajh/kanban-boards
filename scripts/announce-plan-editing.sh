#!/bin/bash
# Tell the counsellor board's agents what changed on 26 November 2026.
#
#   ADMIN_KEY='…' bash scripts/announce-plan-editing.sh [base-url]
#
# Writes one document (the protocol, which stays as reference) and one card carrying a note
# addressed to each agent (work in motion, deleted once they have read it). Posted through
# the API rather than into the database, because that is what fires AdiGrok's webhook and
# wakes it within seconds instead of whenever it next polls.
#
# Safe to re-run: the document is addressed by key so a second run replaces it, and the card
# is only created if one with the same title is not already open.
set -u
B="${1:-https://board-iota-nine.vercel.app}"; B="${B%/}"
: "${ADMIN_KEY:?set ADMIN_KEY}"
H=(-H "Authorization: Bearer $ADMIN_KEY" -H "X-Tenant: counsellor" -H "Content-Type: application/json")
CARD_TITLE="Read the new plan-editing protocol"
DOC_KEY=protocol/plan-editing
jp() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

python3 - > /tmp/plan-proto.$$.json <<'PY'
import json
body = """Two things you could not do yesterday.

## You may edit the Plan's sections

    GET   /api/plan/sections           ids, titles, positions, planVersion
    GET   /api/plan/sections/<id>      one section
    PATCH /api/plan/sections/<id>      edit it - send expected_version
    POST  /api/plan/sections           add one; the assigned id comes back
    GET   /api/plan/history            every version, who changed what

Every section now has a stable id that does NOT follow its title. Rename
"The math" to "The arithmetic" and it is still `the-math`, because the id is
what cards, the history and your own last read all point at.

`planVersion` comes back with GET /api/tracker. Send it as `expected_version`
and a 409 means somebody edited the plan first: re-read, reapply, retry.

    PATCH /api/plan/sections/the-math
    { "note": "updated after the 25 Nov meeting", "expected_version": 7 }

Editable: title, note, text, bullets, diagram, diagramDoc, links, columns,
rows. A null clears a field. Arrays REPLACE rather than append - send the rows
you want the table to have, not the ones you are adding. Any other field is a
422 naming the field.

Until today the part of the board that went stale fastest was the one part no
agent could touch, and the only route to fixing a sentence was a card asking
Adi. If you see prose that is wrong, fix it.

## You may settle a decision

`proposed`, `decided` and `superseded` are all yours now. This was refused to
agents until today.

If you would rather a person or the other agent took the call, assign a card
to them and say what you would do and why. That is the whole mechanism - there
is no proposal queue, deliberately: the board has exactly one place where
things wait on a person, and a second one would be the one nobody checks.

Settle what you have actually established. Escalate what turns on something
you cannot see - somebody's intent, a commercial judgement, a promise made to
a person.

## Write many rows in one call

    POST /api/tracker/batch
    { "ops": [
      { "op": "put",   "kind": "status",    "id": "s-outreach", "title": "...", "lane": "now" },
      { "op": "patch", "kind": "milestone", "id": "m-webinar",  "state": "done", "version": 3 }
    ] }

Up to 50 operations, applied together or not at all. Use it whenever you are
writing more than two or three rows - after a meeting, or a sweep that touches
a status and the milestone it belongs to. The last Plan update took about 40
separate calls, and a failure part way through left the Plan contradicting
itself with nobody aware.

A refusal names the failing operation by `index` and says `applied: 0`. Do not
send the same kind/id twice in one batch; combine them. A batch costs one write
per operation against your rate limit, not one per request.

## You may add the next period, never its targets

    GET   /api/plan/periods         ids, labels, whether targets are set
    POST  /api/plan/periods         {"id":"2027-01","label":"Jan 2027"}
    PATCH /api/plan/periods/<id>    change the label, or move it

A period is a column of the Targets table. You could not add one before, so
every month somebody waited on Adi for a calendar fact.

Add the month; leave the numbers. Sending `targets` is a 403. A period with no
targets asserts nothing - it says January exists and will be measured. A
target is what your `actual` is judged against, so changing one would turn
last month's miss into a hit without anybody touching the figure. Add the
period, then ask for the numbers.

The id is yours to choose and is NOT derived from the label: use the same key
you will file the actual under, `2026-11` style. It cannot be changed later.

## What is still not yours, and why

The goal, the metrics, and any period's targets. Changing a metric key
reinterprets every number already filed under it, so those stay with Adi.

A metric key that already has actuals recorded against it cannot be renamed or
dropped by ANYONE, Adi included - the numbers do not move with the key. On this
board that protects contacted, engaged, activated, enrolled, guide_sent,
referred and referring. The three webinar metrics have no numbers yet and are
still open to change.

Deleting a section, deleting a period, and reverting the plan are a person's
acts. Somebody who
is not the editor has to be able to put it back - that is the reason the
editing could be opened up at all.

## Write as if somebody will read the history

Because they will. Every edit records your name and keeps the previous version.
"""
print(json.dumps({"title": "Protocol: editing the Plan (26 Nov 2026)", "body": body}))
PY

echo -n "document $DOC_KEY: "
curl -s -X PUT "${H[@]}" --data-binary @/tmp/plan-proto.$$.json $B/api/docs/$DOC_KEY \
  | jp 'd.get("key","FAILED") + " v" + str(d.get("version","?"))'
rm -f /tmp/plan-proto.$$.json

CARD=$(curl -s "${H[@]}" $B/api/cards \
  | jp "([str(c['id']) for c in d if c['title']=='$CARD_TITLE'] or [''])[0]")
if [ -z "$CARD" ]; then
  CARD=$(curl -s -X POST "${H[@]}" $B/api/cards -d "{
    \"title\": \"$CARD_TITLE\",
    \"status\": \"todo\",
    \"description\": \"See document $DOC_KEY. You can now edit Plan section prose and settle decisions. Delete this card once you have read it.\"
  }" | jp 'd["id"]')
  echo "card $CARD created"
else
  echo "card $CARD already open, reusing it"
fi

for A in AdiClaude AdiGrok; do
  echo -n "note -> $A: "
  curl -s -X POST "${H[@]}" $B/api/cards/$CARD/notes -d "{
    \"to\": \"$A\",
    \"body\": \"You can now edit the Plan's sections and settle decisions. Read $DOC_KEY (GET /api/docs/$DOC_KEY) before your next Plan write. Section ids are stable and do not follow titles; send expected_version from GET /api/tracker. Use POST /api/tracker/batch for multi-row updates. You can also add a period now (POST /api/plan/periods) but not its targets. The goal, the metrics and any period's targets are still Adi's.\"
  }" | jp 'd.get("addressed_to") or d.get("addressedTo") or "FAILED"'
done

echo
echo "AdiGrok has a bearer webhook, so it should be woken within seconds."
echo "AdiClaude has none and will see this on its next read of /api/events or /api/inbox."
