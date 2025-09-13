// netlify/functions/order-status.js — 100% Supabase
// GET ?orderId=...  -> { ok, orderId, status, regionId, imageUrl, amount, currency, updatedAt }

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "order-status.supabase.v2" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "order-status.supabase.v2", ...body })
  };
}

exports.handler = async (event) => {
  try {
    // Auth (même logique que le reste de tes endpoints)
    const auth = requireAuth(event);
    if (auth?.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "GET") return bad(405, "METHOD_NOT_ALLOWED");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    const qs = event.queryStringParameters || {};
    const orderId = String(qs.orderId || "").trim();
    if (!orderId) return bad(400, "MISSING_ORDER_ID");

    // Supabase client
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 1) Lire l'ordre côté DB
    const { data: order, error: getErr } = await supabase
      .from('orders')
      .select('id, order_id, uid, status, region_id, image_url, amount, total, currency, updated_at, created_at, expires_at')
      .eq('order_id', orderId)
      .single();

    if (getErr || !order) return bad(404, "ORDER_NOT_FOUND");
    if (order.uid && order.uid !== uid) return bad(403, "FORBIDDEN");

    // 2) Statut/expiration
    let status    = order.status || "pending";
    const nowMs   = Date.now();
    if (status === 'pending' && order.expires_at && new Date(order.expires_at).getTime() < nowMs) {
      // best-effort: marquer expiré en DB
      try {
        await supabase.from('orders').update({
          status: 'expired',
          updated_at: new Date().toISOString()
        }).eq('id', order.id);
      } catch (_) {}
      status = 'expired';
    }

    // 3) Champs à retourner
    let regionId  = order.region_id || null;
    let imageUrl  = order.image_url || null;
    const currency= (order.currency || "USD").toUpperCase();
    // Par compat, "amount" = total (serveur). Si absent, retombe sur amount.
    const amount  = (order.total != null ? Number(order.total) : (order.amount != null ? Number(order.amount) : null));
    let updatedAt = order.updated_at ? new Date(order.updated_at).getTime()
                    : (order.created_at ? new Date(order.created_at).getTime() : null);

    // 4) Si encore "pending" mais la DB montre des cells vendues pour la region => completed (best-effort)
    if (status !== "completed" && regionId) {
      const { count: soldCount, error: soldErr } = await supabase
        .from('cells')
        .select('idx', { count:'exact', head:true })
        .eq('region_id', regionId)
        .not('sold_at', 'is', null);

      if (!soldErr && (soldCount || 0) > 0) {
        status = "completed";
        updatedAt = nowMs;
        // best-effort: refléter en DB
        try {
          await supabase.from('orders').update({
            status: 'completed',
            updated_at: new Date().toISOString()
          }).eq('id', order.id);
        } catch (_) {}

        // si image_url manquante, on tente de la récupérer depuis regions
        if (!imageUrl) {
          try {
            const { data: reg, error: regErr } = await supabase
              .from('regions')
              .select('image_url')
              .eq('id', regionId)
              .single();
            if (!regErr && reg?.image_url) imageUrl = reg.image_url;
          } catch (_) {}
        }
      }
    }

    return ok({ orderId, status, regionId, imageUrl, amount, currency, updatedAt });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
