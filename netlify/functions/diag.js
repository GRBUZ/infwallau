// netlify/functions/diag.js — 100% Supabase
// GET → { ok, readable, counts:{ sold, locks, regions }, health }

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function jres(status, obj) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(obj)
  };
}

exports.handler = async (event) => {
  try {
    // Public, read-only
    if (event.httpMethod && event.httpMethod !== 'GET') {
      return jres(405, { ok:false, error:'METHOD_NOT_ALLOWED' });
    }

    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) {
      return jres(500, {
        ok: false,
        error: 'SUPABASE_CONFIG_MISSING',
        need: ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'],
        have: { SUPABASE_URL: !!SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: !!SUPA_SERVICE_KEY }
      });
    }

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession: false } });

    const nowIso = new Date().toISOString();

    // 1) sold cells
    const soldQ = supabase
      .from('cells')
      .select('idx', { count: 'exact', head: true })
      .not('sold_at', 'is', null);

    // 2) active locks
    const locksQ = supabase
      .from('locks')
      .select('idx', { count: 'exact', head: true })
      .gt('until', nowIso);

    // 3) regions
    const regionsQ = supabase
      .from('regions')
      .select('id', { count: 'exact', head: true });

    const [{ count: soldCount, error: soldErr },
           { count: locksCount, error: locksErr },
           { count: regionsCount, error: regionsErr }] =
      await Promise.all([soldQ, locksQ, regionsQ]);

    if (soldErr || locksErr || regionsErr) {
      return jres(500, {
        ok: false,
        error: 'DB_READ_FAILED',
        details: {
          sold: soldErr?.message || null,
          locks: locksErr?.message || null,
          regions: regionsErr?.message || null
        }
      });
    }

    return jres(200, {
      ok: true,
      signature: 'diag.supabase.v1',
      readable: true,
      counts: {
        sold:    soldCount    || 0,
        locks:   locksCount   || 0,
        regions: regionsCount || 0
      },
      health: 'OK'
    });

  } catch (e) {
    return jres(500, {
      ok: false,
      error: 'DIAG_FAILED',
      message: String(e?.message || e)
    });
  }
};
