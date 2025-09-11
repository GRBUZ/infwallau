// netlify/functions/paypal-webhook.js
// Webhook PayPal -> finalisation server-side (prix serveur, tout ou rien, via Supabase RPC)
// Vérif simplifiée par secret, puis:
//  1) charge la commande (GitHub JSON)
//  2) vérifie pas déjà vendus / pas lockés par autre
//  3) (ré)applique des locks pour uid (courte durée)
//  4) calcule PRIX SERVEUR & (option) compare à paidTotal
//  5) appelle RPC finalize_paid_order (_amount = prix serveur)
//  6) marque la commande "completed" dans GitHub + journal prix

const PAYPAL_WEBHOOK_SECRET = process.env.PAYPAL_WEBHOOK_SECRET;

const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || 'main';
const ORDERS_DIR = process.env.ORDERS_DIR || 'data/orders';

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const { verifyPayPalWebhook } = require('./_paypal-verify');

function json(status, obj){
  return {
    statusCode: status,
    headers: { 'content-type':'application/json', 'cache-control':'no-store' },
    body: JSON.stringify(obj)
  };
}
const bad = (s,e,extra={}) => json(s, { ok:false, error:e, ...extra, signature:'paypal-webhook.v2' });
const ok  = (b)         => json(200,{ ok:true,  signature:'paypal-webhook.v2', ...b });

async function ghGetJson(path){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`,
    { headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" } }
  );
  if (r.status === 404) return { json:null, sha:null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}
async function ghPutJson(path, jsonData, sha, message){
  const pretty = JSON.stringify(jsonData, null, 2) + "\n";
  const body = {
    message: message || "chore: write json",
    content: Buffer.from(pretty, "utf-8").toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) throw new Error(`GH_PUT_JSON_FAILED:${r.status}`);
  return r.json();
}

function isUuid(v){
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");
    if (!SUPABASE_URL || !SUPA_SERVICE_KEY) return bad(500, "SUPABASE_CONFIG_MISSING");

    // Vérif (simplifiée) du secret — à remplacer plus tard par la validation officielle PayPal
    const sig = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
    if (!sig || sig !== PAYPAL_WEBHOOK_SECRET) return bad(401, "UNAUTHORIZED");

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { return bad(400, "BAD_JSON"); }

    // Payload minimal attendu: { orderId, paidTotal?, currency? }
    const orderId   = String(body.orderId || "").trim();
    const paidTotal = (body.paidTotal != null) ? Number(body.paidTotal) : null;
    const currency  = (body.currency || 'USD').toUpperCase();
    if (!orderId) return bad(400, "MISSING_ORDER_ID");

    // 1) Charger la commande (GitHub JSON)
    const orderPath = `${ORDERS_DIR}/${orderId}.json`;
    const { json: order, sha: orderSha } = await ghGetJson(orderPath);
    if (!order) return bad(404, "ORDER_NOT_FOUND");

    // Idempotence
    if (order.status === "completed") {
      return ok({
        orderId,
        status: "completed",
        regionId: order.regionId || order.regionDbId,
        imageUrl: order.finalImageUrl || order.image?.url,
        unitPrice: order.unitPrice || null,
        total: order.total || null,
        currency: order.currency || currency
      });
    }

    const uid      = String(order.uid || '').trim();
    const name     = String(order.name || '').trim();
    const linkUrl  = String(order.linkUrl || '').trim();
    const blocks   = Array.isArray(order.blocks) ? order.blocks.map(n=>parseInt(n,10)).filter(Number.isFinite) : [];
    const regionIn = String(order.regionId || '').trim();
    const imageUrl = order.image?.url || '';

    if (!uid || !name || !linkUrl || !blocks.length || !imageUrl) {
      return bad(400, "ORDER_INVALID");
    }
    const regionUuid = isUuid(regionIn) ? regionIn : (await import('node:crypto')).randomUUID();

    // 2) Supabase client
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

    // 3) Conflits immédiats: déjà vendu ?
    const { data: soldRows, error: soldErr } = await supabase
      .from('cells').select('idx')
      .in('idx', blocks)
      .not('sold_at', 'is', null);
    if (soldErr) return bad(500, 'CELLS_QUERY_FAILED', { message: soldErr.message });
    if (soldRows && soldRows.length) {
      const updated = { ...order, status:'failed', updatedAt: Date.now(), failReason:'ALREADY_SOLD' };
      try { await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} failed (already sold)`); } catch {}
      return bad(409, 'ALREADY_SOLD', { idx: Number(soldRows[0].idx) });
    }

    // 4) Conflits locks par un autre UID ?
    const nowIso = new Date().toISOString();
    const { data: lockRows, error: lockErr } = await supabase
      .from('locks').select('idx, uid, until')
      .in('idx', blocks)
      .gt('until', nowIso)
      .neq('uid', uid);
    if (lockErr) return bad(500, 'LOCKS_QUERY_FAILED', { message: lockErr.message });
    if (lockRows && lockRows.length) {
      const updated = { ...order, status:'failed', updatedAt: Date.now(), failReason:'LOCKED_BY_OTHER' };
      try { await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} failed (locked by other)`); } catch {}
      return bad(409, 'LOCKED_BY_OTHER', { idx: Number(lockRows[0].idx) });
    }

    // 5) (Ré)appliquer des locks pour l'UID de l'ordre (2 minutes)
    //    - on ignore si déjà locké par uid (upsert écrase le until)
    const until = new Date(Date.now() + 2*60*1000).toISOString();
    const upsertRows = blocks.map(idx => ({ idx, uid, until }));
    const { error: upsertErr } = await supabase.from('locks').upsert(upsertRows, { onConflict: 'idx' });
    if (upsertErr) return bad(500, 'LOCKS_UPSERT_FAILED', { message: upsertErr.message });

    // 6) PRIX SERVEUR juste avant finaliser
    const { count, error: countErr } = await supabase
      .from('cells')
      .select('idx', { count:'exact', head:true })
      .not('sold_at', 'is', null);
    if (countErr) return bad(500, 'PRICE_QUERY_FAILED', { message: countErr.message });

    const blocksSold  = count || 0;
    const tier        = Math.floor(blocksSold / 10);                   // floor(pixelsSold/1000)
    const unitPrice   = Math.round((1 + tier * 0.01) * 100) / 100;     // 2 décimales
    const totalPixels = blocks.length * 100;
    const total       = Math.round(unitPrice * totalPixels * 100) / 100;
    const usedCurrency= (order.currency || currency || 'USD').toUpperCase();

    // 7) (Option) Vérification de paiement si fourni
    if (paidTotal != null) {
      // Refuse si montant payé < total serveur (anti-sous-paiement)
      if (!(Number.isFinite(paidTotal)) || paidTotal + 1e-9 < total) {
        const updated = { ...order, status:'failed', updatedAt: Date.now(), failReason:'UNDERPAID', serverTotal: total, paidTotal, currency: usedCurrency };
        try { await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} failed (underpaid)`); } catch {}
        return bad(409, 'UNDERPAID', { serverTotal: total, paidTotal, currency: usedCurrency });
      }
    }

    // 8) Appeler la RPC autoritaire (recalcule et refusera si PRICE_CHANGED)
    const orderUuid = (await import('node:crypto')).randomUUID();
    const { error: rpcErr } = await supabase.rpc('finalize_paid_order', {
      _order_id:  orderUuid,
      _uid:       uid,
      _name:      name,
      _link_url:  linkUrl,
      _blocks:    blocks,
      _region_id: regionUuid,
      _image_url: imageUrl,
      _amount:    unitPrice   // on fournit le prix serveur calculé juste avant
    });

    if (rpcErr) {
      const msg = (rpcErr.message || '').toUpperCase();

      if (msg.includes('PRICE_CHANGED')) {
        // Recalcule et retourne le prix serveur actuel pour que le back-office/cron rejoue si besoin
        const { count: c2 } = await supabase
          .from('cells').select('idx', { count:'exact', head:true })
          .not('sold_at', 'is', null);
        const bs2   = c2 || 0;
        const tier2 = Math.floor(bs2 / 10);
        const up2   = Math.round((1 + tier2 * 0.01) * 100) / 100;
        const tot2  = Math.round(up2 * totalPixels * 100) / 100;

        const updated = { ...order, status:'failed', updatedAt: Date.now(), failReason:'PRICE_CHANGED', serverUnitPrice: up2, serverTotal: tot2, currency: usedCurrency };
        try { await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} price_changed`); } catch {}
        return bad(409, 'PRICE_CHANGED', { serverUnitPrice: up2, serverTotal: tot2, currency: usedCurrency });
      }

      if (msg.includes('LOCKS_INVALID')) {
        const updated = { ...order, status:'failed', updatedAt: Date.now(), failReason:'LOCKS_INVALID' };
        try { await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} failed (locks invalid)`); } catch {}
        return bad(409, 'LOCK_MISSING_OR_EXPIRED');
      }
      if (msg.includes('ALREADY_SOLD') || msg.includes('CONFLICT')) {
        const updated = { ...order, status:'failed', updatedAt: Date.now(), failReason:'ALREADY_SOLD' };
        try { await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} failed (already sold)`); } catch {}
        return bad(409, 'ALREADY_SOLD');
      }
      if (msg.includes('NO_BLOCKS')) return bad(400, 'NO_BLOCKS');

      return bad(500, 'RPC_FINALIZE_FAILED', { message: rpcErr.message });
    }

    // 9) Succès — marquer completed + journaliser le prix utilisé
    try {
      const updated = {
        ...order,
        status: 'completed',
        updatedAt: Date.now(),
        finalImageUrl: imageUrl,
        regionDbId: regionUuid,
        unitPrice,
        total,
        currency: usedCurrency
      };
      await ghPutJson(orderPath, updated, orderSha, `chore: order ${orderId} completed (supabase)`);
    } catch(_) { /* non bloquant */ }

    return ok({ orderId, status:'completed', regionId: regionUuid, imageUrl, unitPrice, total, currency: usedCurrency });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
