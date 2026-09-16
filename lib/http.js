const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Tenant',
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
