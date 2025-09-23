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

// --- helpers pagination (anti-cap 1000)
async function selectAllLocks(supabase, { thresholdIso }) {
  const page = 1000;
  let from = 0;
  let out = [];
  for (;;) {
    const { data, error } = await supabase
      .from('locks')
      .select('idx, uid, until')
      .gt('until', thresholdIso)
      .order('idx', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < page) break;
    from += page;
  }
  return out;
}

async function selectAllMyLocksFor(supabase, { uid, idxs, thresholdIso }) {
  if (!Array.isArray(idxs) || !idxs.length) return [];
  const page = 1000;
  let from = 0;
  let out = [];
  for (;;) {
    const { data, error } = await supabase
      .from('locks')
      .select('until, idx')
      .eq('uid', uid)
      .in('idx', idxs)
      .gt('until', thresholdIso)
      .order('idx', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    out = out.concat(data);
    if (data.length < page) break;
    from += page;
  }
  return out;
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
    
    // Logique métier : 3 minutes maximum, mais on accepte les renouvellements
    // Garde une borne 30s..300s pour éviter les TTL délirants (5 minutes max pour PayPal)
    ttlSec = Math.max(30, Math.min(300, ttlSec));

    //console.log(`[reserve] uid=${uid}, blocks=${blocks.length}, ttlSec=${ttlSec}`);

    // ESM import (compat require/exports.handler)
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 1) Réserver via RPC (concurrence safe sur la table locks)
    const { data: reservedArr, error: rpcErr } = await supabase
      .rpc('reserve_blocks', { _uid: uid, _blocks: blocks, _ttl_seconds: ttlSec });

    if (rpcErr) {
      console.error('[reserve] RPC failed:', rpcErr);
      return bad(500, 'RPC_RESERVE_FAILED', { message: rpcErr.message });
    }

    const reserved = Array.isArray(reservedArr) ? reservedArr.map(Number) : [];
    //console.log(`[reserve] Reserved ${reserved.length}/${blocks.length} blocks`);

    // 2) Filtrer les blocs déjà vendus (au cas où)
    /*const { data: soldRows, error: soldErr } = await supabase
      .from('cells')
      .select('idx')
      .in('idx', blocks)
      .not('sold_at', 'is', null);

    if (soldErr) {
      console.error('[reserve] Sold check failed:', soldErr);
      return bad(500, 'CELLS_QUERY_FAILED', { message: soldErr.message });
    }

    const soldSet = new Set((soldRows||[]).map(r=>Number(r.idx)));
    const locked = reserved.filter(i => !soldSet.has(i));*/
    // 2) Filtrer les blocs déjà vendus (via RPC pour éviter 414)
const { data: soldIdxRows, error: soldErr } = await supabase
  .rpc('sold_in_blocks', { _blocks: blocks });

if (soldErr) {
  console.error('[reserve] Sold check failed (RPC):', soldErr);
  return bad(500, 'CELLS_QUERY_FAILED', { message: soldErr.message });
}

const soldSet = new Set((soldIdxRows || []).map(r => Number(r.idx)));
const locked = reserved.filter(i => !soldSet.has(i));


    //console.log(`[reserve] Final locked: ${locked.length} (${soldSet.size} already sold)`);

    // 3) Construire conflicts = demandés – locked
    const reqSet = new Set(blocks);
    locked.forEach(i => reqSet.delete(i));
    soldSet.forEach(i => reqSet.delete(i)); // déjà exclus, mais on peut les compter comme conflits
    const conflicts = Array.from(reqSet);

    // 4) Reconstituer l'état des locks pour le front (TOUS les locks courants, paginés)
    const thresholdIso = new Date(Date.now() - 15000).toISOString(); // petite fenêtre de grâce
    let lockRows;
    try {
      lockRows = await selectAllLocks(supabase, { thresholdIso });
    } catch (lockErr) {
      console.error('[reserve] Locks query (paged) failed:', lockErr);
      return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr.message });
    }

    const locks = {};
    for (const r of (lockRows||[])) {
      const k = String(r.idx);
      const untilMs = r.until ? new Date(r.until).getTime() : 0;
      locks[k] = { uid: r.uid, until: untilMs };
    }

    // 5) regionId + until (max des until pour les blocs lockés par ce user) — paginé
    /*let until = 0;
    if (locked.length) {
      let myLockRows = [];
      try {
        myLockRows = await selectAllMyLocksFor(supabase, {
          uid,
          idxs: locked,
          thresholdIso
        });
      } catch (myErr) {
        console.error('[reserve] Self locks query (paged) failed:', myErr);
        return bad(500, 'LOCKS_SELF_QUERY_FAILED', { message: myErr.message });
      }
      
      for (const r of (myLockRows||[])) {
        const t = r.until ? new Date(r.until).getTime() : 0;
        if (t > until) until = t;
      }
    }
    const regionId = genRegionId(uid, locked);

    const result = {
      locked,
      conflicts,
      locks,
      ttlSeconds: ttlSec,
      regionId,
      until
    };*/

   // 5) regionId + until (max des until pour les blocs lockés par ce user)
//    + unitPrice (prix garanti renvoyé par locks_by_uid_in)
//    → passer par RPC pour éviter un .in(...) en querystring (414)

// FIX: déclarer dans la portée *externe* (visible pour result)
let until = 0;
let unitPrice = null;
let totalAmount = 0;

if (locked.length) {
  const { data: myLockRows, error: myErr } = await supabase
    .rpc('locks_by_uid_in', { _uid: uid, _blocks: locked });

  if (myErr) {
    console.error('[reserve] Self locks RPC failed:', myErr);
    return bad(500, 'LOCKS_SELF_QUERY_FAILED', { message: myErr.message });
  }

  // FIX: ne *pas* redéclarer `let until` ici
  for (const r of (myLockRows || [])) {
    const t = r.until ? new Date(r.until).getTime() : 0;
    if (t > until) until = t;

    // FIX: accepter snake_case ou camelCase et caster en nombre
    const p = r.unit_price ?? r.unitPrice;
    if (p != null && !Number.isNaN(Number(p))) {
      //unitPrice = Number(p);
      //new claude
      totalAmount += Number(p) * 100; // ✅ Additionner
      //new claude
    }
  }
}

const regionId = genRegionId(uid, locked);

const result = {
  locked,
  conflicts,
  locks,
  ttlSeconds: ttlSec,
  regionId,
  until,
  totalAmount
  //unitPrice // OK: existe toujours (null si pas de locks)
};

    //console.log(`[reserve] Success: locked=${locked.length}, conflicts=${conflicts.length}, until=${until ? new Date(until).toISOString() : '0'}`);

    return ok(result);

  }catch(e){
    console.error('[reserve] Server error:', e);
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
