// netlify/functions/link-image.js
// POST JSON: { regionId, imageUrl }  // imageUrl peut être absolu (https://...)
//                                        ou un chemin repo ("assets/images/...")

const { requireAuth } = require('./auth-middleware');

const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

function bad(status, error, extra = {}) {
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok:false, error, ...extra })
  };
}

async function ghGetJson(path){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`,
    { headers: { "Authorization":`Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" } }
  );
  if (r.status === 404) return { json:null, sha:null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}

async function ghPutJson(path, jsonData, sha, msg){
  const pretty = JSON.stringify(jsonData, null, 2) + "\n";
  const body = {
    message: msg || "chore: set regions[regionId].imageUrl",
    content: Buffer.from(pretty, "utf-8").toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;  // ajoute sha seulement s'il existe
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GH_PUT_FAILED:${r.status}`);
  return r.json();
}

function toAbsoluteUrl(imageUrl){
  // Si on reçoit "assets/images/…", on fabrique l'URL RAW GitHub
  if (/^https?:\/\//i.test(imageUrl)) return imageUrl;
  const p = String(imageUrl).replace(/^\/+/, ""); // enlève /
  return `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${p}`;
}

async function linkImageWithRetry(regionId, url, maxAttempts = 3) {
  let attempt = 0;
  let delay = 150; // ms

  while (attempt < maxAttempts) {
    attempt++;
    // 1) lire l'état FRAIS
    const { json: state0, sha } = await ghGetJson(STATE_PATH);
    const state = state0 || { sold:{}, locks:{}, regions:{} };
    state.regions ||= {};
    const existing = state.regions[regionId] || {};

    // 2) appliquer SANS perdre les autres champs
    state.regions[regionId] = { ...existing, imageUrl: url };

    // 3) tenter le PUT
    try {
      await ghPutJson(STATE_PATH, state, sha, `chore: link imageUrl for ${regionId}`);
      return; // ✅ succès
    } catch (err) {
      const msg = String(err?.message || err);
      // 409 => re-lire + re-tenter (backoff)
      if (msg.includes('409') && attempt < maxAttempts) {
        await new Promise(r => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      // autre erreur -> remonter
      throw err;
    }
  }

  throw new Error('LINK_IMAGE_MAX_RETRIES_EXCEEDED');
}

exports.handler = async (event) => {
  try {
    // Authentification requise
    const auth = requireAuth(event);
    if (auth.statusCode) return auth; // Erreur d'auth
    
    const authenticatedUID = auth.uid;
    
    if (event.httpMethod !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    const body = JSON.parse(event.body || '{}');
    if (!body.regionId || !body.imageUrl) return bad(400, "MISSING_FIELDS");

    const regionId = String(body.regionId).trim();
    const url = toAbsoluteUrl(String(body.imageUrl).trim());

    // Optionnel: vérifier que l'utilisateur authentifié possède cette région
    // (si vous avez cette logique dans votre business model)

    // url absolutisée (tu as déjà toAbsoluteUrl), validations faites…
    await linkImageWithRetry(regionId, url);

    return {
      statusCode: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({ ok: true, regionId, imageUrl: url })
    };

  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e) });
  }
};