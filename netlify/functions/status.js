// netlify/functions/status.js — Supabase version OPTIMISÉE
const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function j(status, obj){ return {
  statusCode: status,
  headers: { 'content-type':'application/json', 'cache-control':'no-store' },
  body: JSON.stringify(obj)
};}
const bad = (s,e,extra={}) => j(s, { ok:false, error:e, ...extra, signature:'status.supabase.v2' });
const ok  = (b)         => j(200,{ ok:true, signature:'status.supabase.v2', ...b });

exports.handler = async (event) => {
  try{
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;

    if (!SUPABASE_URL || !SUPA_SERVICE_KEY)
      return bad(500, 'SUPABASE_CONFIG_MISSING');

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, {
      auth: { persistSession: false }
    });

    // ===== 1) REGIONS D'ABORD (pour le MAP) =====
    const { data: regionRows, error: regErr } = await supabase
      .from('regions')
      .select('id, name, link_url, x, y, w, h, image_url');

    if (regErr) return bad(500, 'DB_REGIONS_QUERY_FAILED', { message: regErr.message });

    // Créer MAP pour lookup rapide
    const regionsMap = {};
    const regions = {};
    
    for (const r of (regionRows || [])) {
      regionsMap[r.id] = {
        name: r.name || '',
        linkUrl: r.link_url || ''
      };
      
      regions[r.id] = {
        rect: { x: Number(r.x)||0, y: Number(r.y)||0, w: Number(r.w)||0, h: Number(r.h)||0 },
        imageUrl: r.image_url || ''
      };
    }

    // ===== 2) SOLD (SANS JOIN) =====
    const soldRows = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('cells')
          .select('idx, region_id, sold_at')  // ✅ SANS JOIN
          .not('sold_at', 'is', null)
          .order('idx', { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) return bad(500, 'DB_SOLD_QUERY_FAILED', { message: error.message });
        if (!data || data.length === 0) break;

        soldRows.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
      }
    }

    const sold = {};
    for (const row of (soldRows || [])) {
      const idx       = Number(row.idx);
      const rid       = row.region_id;
      const soldAt    = row.sold_at ? new Date(row.sold_at).getTime() : Date.now();
      
      // ✅ Lookup dans le MAP (rapide)
      const region    = regionsMap[rid] || {};
      const name      = region.name || '';
      const linkUrl   = region.linkUrl || '';

      if (Number.isFinite(idx) && rid) {
        sold[idx] = { name, linkUrl, ts: soldAt, regionId: rid };
      }
    }

    // ===== 3) LOCKS =====
    const lockRows = [];
    let from = 0;
    const pageSize = 1000;
    const cutoff = new Date(Date.now() - 15_000).toISOString();

    while (true) {
      const { data, error } = await supabase
        .from('locks')
        .select('idx, uid, until')
        .gt('until', cutoff)
        .order('idx', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) return bad(500, 'DB_LOCKS_QUERY_FAILED', { message: error.message });
      if (!data || data.length === 0) break;

      lockRows.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    const locks = {};
    for (const r of lockRows) {
      const k = String(r.idx);
      const untilMs = r.until ? new Date(r.until).getTime() : 0;
      locks[k] = { uid: r.uid, until: untilMs };
    }

    // ===== 4) PRIX COURANT =====
    const blocksSold = soldRows.length;
    const pixelsSold = blocksSold * 100;
    const currentPrice = 1 + Math.floor(pixelsSold / 1000) * 0.01;

    return ok({ sold, locks, regions, currentPrice });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};