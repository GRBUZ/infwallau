// netlify/functions/unlock.js — Supabase version (plus de GitHub/state.json)
// POST { blocks: number[] }  ->  { ok:true, locks:{ [idx]:{ uid, until(ms) } } }

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function j(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => j(s, { ok:false, error:e, ...extra, signature:'unlock.supabase.v1' });
const ok  = (b)           => j(200,{ ok:true,  signature:'unlock.supabase.v1', ...b });

exports.handler = async (event) => {
  try{
    // Auth obligatoire
    const auth = requireAuth(event);
    if (auth?.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== 'POST')            return bad(405,'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY)     return bad(500,'SUPABASE_CONFIG_MISSING');

    // Parse body
    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return bad(400,'BAD_JSON'); }
    let blocks = Array.isArray(body.blocks)
      ? body.blocks.map(x=>parseInt(x,10)).filter(Number.isFinite)
      : [];
    if (!blocks.length) return bad(400,'NO_BLOCKS');

    // Dédup pour éviter des clauses IN plus grosses que nécessaire
    blocks = Array.from(new Set(blocks));

    // Supabase client (import ESM dynamique)
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 1) Delete my locks for these blocks (idempotent) — en tranches
    const CHUNK = 1000;
    for (let i = 0; i < blocks.length; i += CHUNK) {
      const slice = blocks.slice(i, i + CHUNK);
      const { error: delErr } = await supabase
        .from('locks')
        .delete()
        .eq('uid', uid)
        .in('idx', slice);
      if (delErr) return bad(500,'LOCKS_DELETE_FAILED', { message: delErr.message });
    }

    // 2) Retourner l'état actuel des locks non expirés pour que le front reste sync
    const nowIso = new Date().toISOString();
    const { data: lockRows, error: qErr } = await supabase
      .from('locks')
      .select('idx, uid, until')
      .gt('until', nowIso);

    if (qErr) return bad(500,'LOCKS_QUERY_FAILED', { message: qErr.message });

    const locks = {};
    for (const r of (lockRows || [])) {
      const k = String(r.idx);
      locks[k] = { uid: r.uid, until: r.until ? new Date(r.until).getTime() : 0 };
    }

    return ok({ locks });

  } catch (e) {
    return bad(500,'UNLOCK_FAILED', { message: String(e?.message || e) });
  }
};
