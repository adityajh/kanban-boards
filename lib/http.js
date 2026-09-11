const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
export function options() { return new Response(null, { status: 204, headers: CORS }); }
export function authed(req) {
  const h = req.headers.get('authorization') || '';
  const t = h.replace(/^Bearer\s+/i, '').trim();
  return t && t === process.env.BOARD_KEY;
}
