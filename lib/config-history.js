import { sql } from './db';

// Every change to a board's config keeps its predecessor. This is the price of letting
// anything but one careful person edit the plan, and it is the one part that cannot be
// added later: history you did not record is gone.
//
// The history holds the WHOLE config rather than just the plan. `names`, `tags` and `brand`
// go stale and get mis-edited too, and a revert that restores only part of a config is a
// revert that half works. Migration 017 seeds version 1 for every board, so there is always
// a floor to go back to.

// The current version is the highest row in the board's history, derived rather than stored
// on the config itself: two places holding a version number is two places that can disagree.
// A board whose history has not started reads as 0, and its first write records version 1.
export async function configVersion(tenantId) {
  const [row] = await sql`select max(version) as v from config_versions where tenant_id=${tenantId}`;
  return Number(row?.v || 0);
}

const CONFLICT = '23505'; // unique_violation on (tenant_id, version)

// The config and the row that explains it are written by ONE statement, so there is no
// window in which the board has changed and its history does not say so.
//
// Two writers who both read version 5 will both try to insert version 6, and the unique
// index refuses the second. That is the behaviour we want rather than a problem to solve:
// the loser is told to re-read instead of silently flattening the winner. Callers get
// `{ conflict: true }` and turn it into a 409.
export async function writeConfig(tenantId, { config, name, changedBy, change }) {
  const blob = JSON.stringify(config);
  try {
    const [row] = await sql`
      with next as (
        select coalesce(max(version), 0) + 1 as v from config_versions where tenant_id=${tenantId}
      ), ins as (
        insert into config_versions (tenant_id, version, config, changed_by, change)
        select ${tenantId}, next.v, ${blob}::jsonb, ${changedBy}, ${change} from next
        returning version
      ), upd as (
        update tenants set name=${name}, config=${blob}::jsonb where id=${tenantId}
        returning slug, name, config, created_at
      )
      select ins.version, upd.slug, upd.name, upd.config, upd.created_at from ins, upd`;
    if (!row) return { conflict: true };
    return {
      version: Number(row.version),
      tenant: { slug: row.slug, name: row.name, config: row.config, created_at: row.created_at },
    };
  } catch (e) {
    if (e && (e.code === CONFLICT || String(e.message || '').includes('config_versions'))) {
      return { conflict: true };
    }
    throw e;
  }
}

// Newest first. The configs themselves are deliberately left out of the list: a board's
// config is a few kilobytes and fourteen of them in one response is a page nobody reads.
// Ask for one by version to get its contents.
export const configHistory = (tenantId, limit = 50) => sql`
  select version, changed_by, change, changed_at,
         (config->'plan') is not null as has_plan
    from config_versions where tenant_id=${tenantId}
   order by version desc limit ${limit}`;

export const configAtVersion = (tenantId, version) => sql`
  select version, config, changed_by, change, changed_at
    from config_versions where tenant_id=${tenantId} and version=${version}`;
