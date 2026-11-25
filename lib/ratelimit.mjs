// The pure half of per-agent write limiting, kept free of lib/db and lib/tenant so a test
// can reach it under plain node. The counting itself is one UPDATE in withTenant.

// Roughly two writes a second sustained: far above what an agent doing real work needs and
// far below what a retry loop produces. Mirrors the column default in migration 011.
export const DEFAULT_WRITE_LIMIT = 120;
export const MAX_WRITE_LIMIT = 10000;

// Absent, null and '' all mean "not supplied", so a form that sends an empty field leaves
// the limit alone instead of failing. Anything else must be a real integer in range: a
// string such as "5" is refused rather than coerced, because a client that sends one has
// usually mixed up two fields and silently accepting it would hide that.
export function rateLimitRefusal(limit) {
  if (limit === undefined || limit === null || limit === '') return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WRITE_LIMIT) {
    return { field: 'rateLimit', error: `rateLimit must be a whole number from 1 to ${MAX_WRITE_LIMIT} (writes per minute)` };
  }
  return null;
}

// Whole seconds until the fixed minute window that began at `windowStart` ends. Never less
// than 1: a caller sleeps on this number, and 0 would invite an immediate retry that is
// refused again and counted again. Rounded up for the same reason — sleeping 4 seconds when
// 4.2 remain would land the retry inside the window.
export function retryAfterSeconds(windowStart, now = Date.now()) {
  const start = windowStart instanceof Date ? windowStart.getTime() : new Date(windowStart).getTime();
  const left = Math.ceil((start + 60000 - now) / 1000);
  return Number.isFinite(left) && left > 1 ? left : 1;
}
