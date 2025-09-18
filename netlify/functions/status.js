// netlify/functions/status.js — Supabase version (remplace GitHub/state.json)
// Renvoie le même shape que l'ancien /status :
// { ok, sold, locks, regions }
//
// sold   : { [idx]: { name, linkUrl, ts, regionId } }
// locks  : { [idx]: { uid, until } }     // until en ms epoch
// regions: { [regionId]: { rect:{x,y,w,h}, imageUrl } }
//
// Auth: on accepte ton JWT anonyme via requireAuth (comme les autres endpoints)

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function j(status, obj){ return {
  statusCode: status,
  headers: { 'content-type':'application/json', 'cache-control':'no-store' },
  body: JSON.stringify(obj)
};}
const bad = (s,e,extra={}) => j(s, { ok:false, error:e, ...extra, signature:'status.supabase.v1' });
const ok  = (b)         => j(200,{ ok:true, signature:'status.supabase.v1', ...b });

exports.handler = async (event) => {
  try{
    // Auth (tolérant et rapide)
    const auth = requireAuth(event);
    if (auth.statusCode) return auth; // garde la même politique que tes autres fn

    if (!SUPABASE_URL || !SUPA_SERVICE_KEY)
      return bad(500, 'SUPABASE_CONFIG_MISSING');

    // Import ESM dynamique (compatible CommonJS)
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, {
      auth: { persistSession: false }
    });

    // ===== 1) SOLD: cells vendues + métadonnées région
    // idx, region_id, sold_at (joint aux regions pour name/link_url)
    const { data: soldRows, error: soldErr } = await supabase
      .from('cells')
      .select('idx, region_id, sold_at, regions!inner ( id, name, link_url )', { count: 'exact' })
      .not('sold_at', 'is', null);

    if (soldErr) return bad(500, 'DB_SOLD_QUERY_FAILED', { message: soldErr.message });

    const sold = {};
    for (const row of (soldRows || [])) {
      const idx       = Number(row.idx);
      const rid       = row.region_id;
      const soldAt    = row.sold_at ? new Date(row.sold_at).getTime() : Date.now();
      const r         = row.regions || {};
      const name      = r.name || '';
      const linkUrl   = r.link_url || '';

      if (Number.isFinite(idx) && rid) {
        sold[idx] = { name, linkUrl, ts: soldAt, regionId: rid };
      }
    }

    //new pagination
    // Dans status.js, remplacer la requête locks par :
const lockRows = [];
let from = 0;
const pageSize = 1000;
const nowIso = new Date().toISOString();
while (true) {
  const { data, error } = await supabase
    .from('locks')
    .select('idx, uid, until')
    .gt('until', nowIso)
    .range(from, from + pageSize - 1);
    
  if (error) return bad(500, 'DB_LOCKS_QUERY_FAILED', { message: error.message });
  if (!data || data.length === 0) break;
  
  lockRows.push(...data);
  if (data.length < pageSize) break;
  from += pageSize;
}
    //new pagination

    // ===== 2) LOCKS: verrous non expirés
    /*const nowIso = new Date().toISOString();
    const { data: lockRows, error: lockErr } = await supabase
      .from('locks')
      .select('idx, uid, until')
      .gt('until', nowIso);

    if (lockErr) return bad(500, 'DB_LOCKS_QUERY_FAILED', { message: lockErr.message });

    const locks = {};
    for (const r of (lockRows || [])) {
      const k = String(r.idx);
      const untilMs = r.until ? new Date(r.until).getTime() : 0;
      locks[k] = { uid: r.uid, until: untilMs };
    }*/

    // ===== 3) REGIONS: rectangles + image_url
    const { data: regionRows, error: regErr } = await supabase
      .from('regions')
      .select('id, x, y, w, h, image_url');

    if (regErr) return bad(500, 'DB_REGIONS_QUERY_FAILED', { message: regErr.message });

    const regions = {};
    for (const r of (regionRows || [])) {
      regions[r.id] = {
        rect: { x: Number(r.x)||0, y: Number(r.y)||0, w: Number(r.w)||0, h: Number(r.h)||0 },
        imageUrl: r.image_url || ''
      };
    }

    return ok({ sold, locks, regions });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
