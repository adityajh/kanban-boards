// Pure agent-credential helpers: no database, no request handling. Kept as .mjs and free of
// imports beyond node builtins so tests/auth-test.mjs can run the shipped code directly,
// the same arrangement as lib/password.mjs.
import { randomBytes } from 'crypto';

// The token carries its board's slug in the clear. The slug is not a secret, and a token
// sitting in somebody's config file is far easier to place when it says which board it
// opens. The random part is 24 bytes — 192 bits.
export const newAgentToken = (slug) => `agt-${slug}-${randomBytes(24).toString('base64url')}`;

// Agent names are used as note authors and as card assignees, so they are kept token-like:
// no spaces, nothing that could be mistaken for a sentence or for a person's display name.
export const validAgentName = (n) => /^[a-z0-9][a-z0-9._-]{1,39}$/i.test(n);

export const SCOPES = ['read', 'write'];
