// netlify/functions/price.js
const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(status, body) {
  return { statusCode: status, headers: { 'content-type':'application/json', 'cache-control':'no-store' }, body: JSON.stringify(body) };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'price.v1' });
const ok  = (b)           => json(200,{ ok:true,  signature:'price.v1', ...b });

exports.handler = async (event) => {
  try {
    // Auth pas obligatoire si tu veux afficher en public :
    // const auth = requireAuth(event);
    // if (auth.statusCode) return auth;

    if (event.httpMethod !== 'GET') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, 'SUPABASE_CONFIG_MISSING');

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    const { count, error } = await supabase
      .from('cells')
      .select('idx', { count: 'exact', head: true })
      .not('sold_at', 'is', null);
    if (error) return bad(500, 'DB_ERROR', { message: error.message });

    const blocksSold  = count || 0;
    const pixelsSold  = blocksSold * 100;
    const tier        = Math.floor(blocksSold / 10);             // = floor(pixelsSold/1000)
    const unitPrice   = Math.round((1 + tier * 0.01) * 100) / 100;

    return ok({ unitPrice, blocksSold, pixelsSold, currency:'USD' });
  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
