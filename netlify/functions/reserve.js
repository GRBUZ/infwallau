// netlify/functions/reserve.js — Supabase version (remplace GitHub/state.json)
// Renvoie la même forme que l'ancien endpoint :
// { ok, locked, conflicts, locks, ttlSeconds, regionId, until }

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function j(status, obj){ return {
  statusCode: status,
  headers: { 'content-type':'application/json', 'cache-control':'no-store' },
  body: JSON.stringify(obj)
};}
const bad = (s,e,extra={}) => j(s, { ok:false, error:e, ...extra, signature:'reserve.supabase.v1' });
const ok  = (b)         => j(200,{ ok:true, signature:'reserve.supabase.v1', ...b });

// même algo que ta version GitHub (regionId stable par uid + set de blocs)
const crypto = require('crypto');
function genRegionId(uid, blocks){
  const arr = Array.from(new Set(blocks)).sort((a,b)=>a-b);
  const seed = `${uid}|${arr.join(',')}`;
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

exports.handler = async (event) => {
  try{
    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, 'SUPABASE_CONFIG_MISSING');

    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    let body={}; try{ body = JSON.parse(event.body||'{}'); }catch{ return bad(400,'BAD_JSON'); }
    const blocks = Array.isArray(body.blocks) ? body.blocks.map(x=>parseInt(x,10)).filter(Number.isFinite) : [];
    if (!blocks.length) return bad(400, 'NO_BLOCKS');

    // TTL front était en ms ; la RPC prend des secondes
    let ttlMs  = Math.max(1000, parseInt(body.ttl || 180000, 10));
    let ttlSec = Math.max(1, Math.round(ttlMs / 1000));
    // garde une borne 15s..180s pour éviter les TTL délirants
    ttlSec = Math.max(15, Math.min(180, ttlSec));

    // ESM import (compat require/exports.handler)
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 1) Réserver via RPC (concurrence safe sur la table locks)
    const { data: reservedArr, error: rpcErr } = await supabase
      .rpc('reserve_blocks', { _uid: uid, _blocks: blocks, _ttl_seconds: ttlSec });

    if (rpcErr) return bad(500, 'RPC_RESERVE_FAILED', { message: rpcErr.message });

    const reserved = Array.isArray(reservedArr) ? reservedArr.map(Number) : [];

    // 2) Filtrer les blocs déjà vendus (au cas où)
    const { data: soldRows, error: soldErr } = await supabase
      .from('cells')
      .select('idx')
      .in('idx', blocks)
      .not('sold_at', 'is', null);

    if (soldErr) return bad(500, 'CELLS_QUERY_FAILED', { message: soldErr.message });

    const soldSet = new Set((soldRows||[]).map(r=>Number(r.idx)));
    const locked = reserved.filter(i => !soldSet.has(i));

    // 3) Construire conflicts = demandés – locked
    const reqSet = new Set(blocks);
    locked.forEach(i => reqSet.delete(i));
    soldSet.forEach(i => reqSet.delete(i)); // déjà exclus, mais on peut les compter comme conflits
    const conflicts = Array.from(reqSet);

    // 4) Reconstituer l'état des locks pour le front (tous les locks courants)
    const nowIso = new Date().toISOString();
    const { data: lockRows, error: lockErr } = await supabase
      .from('locks')
      .select('idx, uid, until')
      .gt('until', nowIso);

    if (lockErr) return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr.message });

    const locks = {};
    for (const r of (lockRows||[])) {
      const k = String(r.idx);
      const untilMs = r.until ? new Date(r.until).getTime() : 0;
      locks[k] = { uid: r.uid, until: untilMs };
    }

    // 5) regionId + until (max des until pour les blocs lockés par ce user)
    let until = 0;
    if (locked.length) {
      const { data: myLockRows, error: myErr } = await supabase
        .from('locks')
        .select('until')
        .eq('uid', uid)
        .in('idx', locked)
        .gt('until', nowIso);

      if (myErr) return bad(500, 'LOCKS_SELF_QUERY_FAILED', { message: myErr.message });
      for (const r of (myLockRows||[])) {
        const t = r.until ? new Date(r.until).getTime() : 0;
        if (t > until) until = t;
      }
    }
    const regionId = genRegionId(uid, locked);

    return ok({
      locked,
      conflicts,
      locks,
      ttlSeconds: ttlSec,
      regionId,
      until
    });

  }catch(e){
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
