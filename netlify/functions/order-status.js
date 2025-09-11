// netlify/functions/order-status.js — GH order + Supabase verification (no state.json)
// GET ?orderId=...  -> { ok, orderId, status, regionId, imageUrl, amount, currency, updatedAt }

const { requireAuth } = require('./auth-middleware');

const ORDERS_DIR = process.env.ORDERS_DIR || "data/orders";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "order-status.supabase.v1" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "order-status.supabase.v1", ...body })
  };
}

// --- GitHub helpers (lecture simple ; pas d'écriture ici)
async function ghGetJson(path){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`,
    { headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" } }
  );
  if (r.status === 404) return { json:null, sha:null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}

exports.handler = async (event) => {
  try {
    // Auth (même logique que le reste de tes endpoints)
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "GET") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING", { GH_REPO, GH_BRANCH });

    const qs = event.queryStringParameters || {};
    const orderId = String(qs.orderId || "").trim();
    if (!orderId) return bad(400, "MISSING_ORDER_ID");

    // 1) Lire l'order JSON côté GitHub (source de vérité du front pour l'instant)
    const { json: order } = await ghGetJson(`${ORDERS_DIR}/${orderId}.json`);
    if (!order) return bad(404, "ORDER_NOT_FOUND");
    if (order.uid && order.uid !== uid) return bad(403, "FORBIDDEN");

    let status    = order.status || "pending";
    let regionId  = order.regionId || null;
    let imageUrl  = (order.image && order.image.url) || order.finalImageUrl || null;
    const amount  = order.amount ?? null;
    const currency= order.currency || "USD";
    let updatedAt = order.updatedAt || order.createdAt || null;

    // 2) Si on est encore "pending" et qu'on a Supabase, on vérifie la réalité en DB :
    //    - s'il existe des cells soldées pour cette region -> l'order est effectively completed
    if (status !== "completed" && regionId && SUPABASE_URL && SUPA_SERVICE_KEY) {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(SUPABASE_URL, SUPA_SERVICE_KEY, { auth: { persistSession:false } });

        // Vérifier s'il y a des cells vendues pour cette region
        const { data: soldRows, error: soldErr } = await supabase
          .from('cells')
          .select('idx', { count: 'exact', head: false })
          .eq('region_id', regionId)
          .not('sold_at', 'is', null)
          .limit(1);

        if (!soldErr && soldRows && soldRows.length > 0) {
          // Considère la commande comme complétée (atomiquement côté DB via finalize_paid_order)
          status = "completed";
          updatedAt = Date.now();

          // On récupère l'image de la région en DB si possible
          const { data: regRows, error: regErr } = await supabase
            .from('regions')
            .select('image_url')
            .eq('id', regionId)
            .limit(1);

          if (!regErr && regRows && regRows[0] && regRows[0].image_url) {
            imageUrl = regRows[0].image_url;
          }
        }
      } catch (_e) {
        // En cas d'erreur Supabase, on ne casse pas la réponse : on renvoie l'état GH "pending"
      }
    }

    return ok({ orderId, status, regionId, imageUrl, amount, currency, updatedAt });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
