// netlify/functions/status.js — returns sold, locks, regions
const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

function bad(status, error){
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok: false, error })
  };
}

function pruneLocks(locks) {
  const now = Date.now();
  const out = {};
  for (const [k, v] of Object.entries(locks || {})) {
    if (v && typeof v.until === 'number' && v.until > now) {
      out[k] = v;
    }
  }
  return out;
}

exports.handler = async (event) => {
  try {
    // Pas d'auth requise - fonction publique pour afficher l'état du grid
    
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");
    
    const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(STATE_PATH)}?ref=${GH_BRANCH}`, {
      headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" }
    });
    
    if (r.status === 404){
      return {
        statusCode: 200,
        headers: { "content-type":"application/json", "cache-control":"no-store" },
        body: JSON.stringify({ ok: true, sold: {}, locks: {}, regions: {} })
      };
    }
    
    if (!r.ok) return bad(r.status, "GH_GET_FAILED");
    
    const data = await r.json();
    const content = Buffer.from(data.content || "", "base64").toString("utf-8");
    const state = JSON.parse(content || "{}");
    
    const sold = state.sold || {};
    const locks = pruneLocks(state.locks || {}); // Nettoie les locks expirés
    const regions = state.regions || {};
    
    return {
      statusCode: 200,
      headers: { "content-type":"application/json", "cache-control":"no-store" },
      body: JSON.stringify({ ok: true, sold, locks, regions })
    };
    
  } catch (e) {
    return bad(500, "SERVER_ERROR");
  }
};