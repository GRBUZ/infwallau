// netlify/functions/order-status.js — AMÉLIORÉ
// GET ?orderId=...  -> { ok, orderId, status, effectiveStatus, regionId, imageUrl, amount, currency, updatedAt, needsSupport }

const { requireAuth } = require('./auth-middleware');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "order-status.v4" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "order-status.v4", ...body })
  };
}

exports.handler = async (event) => {
  try {
    const auth = requireAuth(event);
    if (auth?.statusCode) return auth;
    const uid = auth.uid;

    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    const qs = event.queryStringParameters || {};
    const orderId = String(qs.orderId || "").trim();
    const action = String(qs.action || "").trim().toLowerCase(); // ✅ NOUVEAU
    
    if (!orderId) return bad(400, "MISSING_ORDER_ID");

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 1) Lire l'ordre
    const { data: order, error: getErr } = await supabase
      .from('orders')
      .select('id, order_id, uid, status, region_id, image_url, total, currency, updated_at, created_at, expires_at, fail_reason, refund_id, needs_manual_refund')
      .eq('order_id', orderId)
      .maybeSingle();

    if (getErr) return bad(500, "DB_READ_FAILED", { message: getErr.message });
    if (!order) return bad(404, "ORDER_NOT_FOUND");
    if (order.uid && order.uid !== uid) return bad(403, "FORBIDDEN");

    // ✅ ACTION CANCEL : Marquer l'order comme cancelled
    if (action === 'cancel') {
      const currentStatus = String(order.status || '').toLowerCase();
      
      // Ne marquer cancelled QUE si status = pending
      if (currentStatus !== 'pending') {
        return ok({ 
          orderId,
          status: currentStatus,
          message: 'Order already processed'
        });
      }

      const { error: updateErr } = await supabase
        .from('orders')
        .update({
          status: 'cancelled',
          fail_reason: 'USER_CANCELLED',
          updated_at: new Date().toISOString()
        })
        .eq('order_id', orderId);

      if (updateErr) {
        return bad(500, "UPDATE_FAILED", { message: updateErr.message });
      }

      return ok({ 
        orderId, 
        status: 'cancelled',
        effectiveStatus: 'cancelled',
        message: 'Payment cancelled by user.'
      });
    }

    // Si pas d'action, continuer avec la logique normale de status check

    // 2) Variables de base
    let status    = order.status || "pending";
    const nowMs   = Date.now();
    const createdMs = order.created_at ? new Date(order.created_at).getTime() : nowMs;
    const ageMinutes = (nowMs - createdMs) / (1000 * 60);
    
    let regionId  = order.region_id || null;
    let imageUrl  = order.image_url || null;
    const currency= (order.currency || "USD").toUpperCase();
    const amount  = (order.total != null ? Number(order.total) : null);
    let updatedAt = order.updated_at ? new Date(order.updated_at).getTime()
                    : (order.created_at ? new Date(order.created_at).getTime() : null);

    // 3) DÉTECTION PROACTIVE : pending expiré
    if (status === 'pending' && order.expires_at && new Date(order.expires_at).getTime() < nowMs) {
      try {
        await supabase.from('orders').update({
          status: 'expired',
          fail_reason: 'TIMEOUT_EXPIRED',
          updated_at: new Date().toISOString()
        }).eq('order_id', orderId);
      } catch (_) {}
      status = 'expired';
    }

    // 4) DÉTECTION PROACTIVE : pending mort (> 10 min sans activité)
    if (status === 'pending' && ageMinutes > 10 && regionId) {
      const { count: soldCount } = await supabase
        .from('cells')
        .select('idx', { count:'exact', head:true })
        .eq('region_id', regionId)
        .not('sold_at', 'is', null);

      if ((soldCount || 0) === 0) {
        // Aucun cell vendu après 10 min → échec
        try {
          await supabase.from('orders').update({
            status: 'failed',
            fail_reason: 'TIMEOUT_ABANDONED',
            updated_at: new Date().toISOString()
          }).eq('order_id', orderId);
        } catch (_) {}
        status = 'failed';
      } else {
        // Des cells vendues → récupération en completed
        status = 'completed';
        updatedAt = nowMs;
        try {
          await supabase.from('orders').update({
            status: 'completed',
            updated_at: new Date().toISOString()
          }).eq('order_id', orderId);
        } catch (_) {}
        
        if (!imageUrl) {
          try {
            const { data: reg } = await supabase
              .from('regions')
              .select('image_url')
              .eq('id', regionId)
              .maybeSingle();
            if (reg?.image_url) imageUrl = reg.image_url;
          } catch (_) {}
        }
      }
    }

    // 5) RÉCUPÉRATION : pending mais cells vendues (même si < 10 min)
    if (status === 'pending' && regionId) {
      const { count: soldCount } = await supabase
        .from('cells')
        .select('idx', { count:'exact', head:true })
        .eq('region_id', regionId)
        .not('sold_at', 'is', null);

      if ((soldCount || 0) > 0) {
        status = "completed";
        updatedAt = nowMs;
        try {
          await supabase.from('orders').update({
            status: 'completed',
            updated_at: new Date().toISOString()
          }).eq('order_id', orderId);
        } catch (_) {}

        if (!imageUrl) {
          try {
            const { data: reg } = await supabase
              .from('regions')
              .select('image_url')
              .eq('id', regionId)
              .maybeSingle();
            if (reg?.image_url) imageUrl = reg.image_url;
          } catch (_) {}
        }
      }
    }

    // 6) NORMALISATION pour le frontend (effectiveStatus)
    let effectiveStatus = status;
    let needsSupport = false;
    let message = null;

    switch(status) {
      case 'completed':
        effectiveStatus = 'completed';
        message = 'Payment successful!';
        break;
      
      case 'pending':
        effectiveStatus = 'pending';
        message = 'Processing payment...';
        break;
      
      case 'cancelled':
        effectiveStatus = 'cancelled';
        message = 'Payment cancelled by user.';
        break;
      
      case 'expired':
      case 'failed':
        effectiveStatus = 'failed';
        if (order.refund_id) {
          message = 'Payment was refunded. Please try again.';
        } else {
          message = 'Payment failed. Please try again.';
        }
        break;
      
      case 'refund_failed':
        effectiveStatus = 'failed';
        needsSupport = true;
        message = 'Payment issue. Our support team will contact you shortly.';
        break;
      
      default:
        effectiveStatus = status;
    }

    return ok({ 
      orderId, 
      status,              // Statut DB réel
      effectiveStatus,     // Statut normalisé pour frontend
      regionId, 
      imageUrl, 
      amount, 
      currency, 
      updatedAt,
      needsSupport,        // Flag pour afficher contact support
      message,             // Message prêt à afficher
      refundId: order.refund_id || null,
      failReason: order.fail_reason || null
    });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};