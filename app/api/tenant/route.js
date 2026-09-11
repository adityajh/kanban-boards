import { json, options } from '../../../lib/http';
import { withTenant, publicTenant } from '../../../lib/tenant';
export const dynamic = 'force-dynamic';
export async function OPTIONS() { return options(); }

// Which board does this passphrase open, and how should it look.
export const GET = withTenant(async (req, ctx, t) => json(publicTenant(t)));
