const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant',
  // Without this a cross-origin caller cannot read the header at all, and an agent would
  // never learn that rows were withheld from its view of the board.
  // A header a caller cannot read may as well not be sent: a browser hides every
  // response header from cross-origin JavaScript unless it is named here. X-Hidden-Cards
  // tells an agent how much of the board it was not shown; Retry-After tells a throttled
  // one how long to wait, which is the entire use of a 429.
  'Access-Control-Expose-Headers': 'X-Hidden-Cards, Retry-After',
};
// `extra` carries Set-Cookie on the auth routes. Note CORS stays a wildcard with no
// Allow-Credentials, so cookies are never sent cross-origin.
export function json(data, status = 200, extra) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}
export function options() { return new Response(null, { status: 204, headers: CORS }); }
export function bearer(req) {
  const h = req.headers.get('authorization') || '';
  return h.replace(/^Bearer\s+/i, '').trim();
}
// Route ids are serial ints; anything else can't match a row.
export function idParam(params) {
  const id = Number(params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}
