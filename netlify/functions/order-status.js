// netlify/functions/order-status.js
const { requireAuth } = require('./auth-middleware');

const ORDERS_DIR = process.env.ORDERS_DIR || "data/orders";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: false, error, ...extra, signature: "order-status.v1" })
  };
}
function ok(body) {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ ok: true, signature: "order-status.v1", ...body })
  };
}

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
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== "GET") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING", { GH_REPO, GH_BRANCH });

    const qs = event.queryStringParameters || {};
    const orderId = String(qs.orderId || "").trim();
    if (!orderId) return bad(400, "MISSING_ORDER_ID");

    const { json: order } = await ghGetJson(`${ORDERS_DIR}/${orderId}.json`);
    if (!order) return bad(404, "ORDER_NOT_FOUND");
    if (order.uid && order.uid !== uid) return bad(403, "FORBIDDEN");

    // Retourne le statut & infos utiles (sans b64 ni secrets)
    return ok({
      orderId,
      status: order.status || "pending",
      regionId: order.regionId || null,
      imageUrl: order.image?.url || null,
      amount: order.amount ?? null,
      currency: order.currency || "USD",
      updatedAt: order.updatedAt || order.createdAt || null
    });

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};
