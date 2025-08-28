// netlify/functions/finalize.js
// Finalisation: exige une image déjà uploadée pour regionId, sinon refuse.

const { requireAuth, getAuthenticatedUID } = require('./jwt-middleware.js');

// utils communs (copier en haut de chaque fn)
const CORS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const ok = (obj) => ({ statusCode: 200, headers: CORS, body: JSON.stringify(obj) });
const bad = (status, error, extra={}) => ({ statusCode: status, headers: CORS, body: JSON.stringify({ ok:false, error, ...extra }) });

const GH_REPO   = process.env.GH_REPO;
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const STATE_PATH = process.env.STATE_PATH || 'data/state.json';

const API_BASE = 'https://api.github.com';

function jres(status, obj) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

async function ghGetFile(path) {
  const url = `${API_BASE}/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `token ${GH_TOKEN}`,
      'User-Agent': 'netlify-fn',
      'Accept': 'application/vnd.github+json'
    }
  });
  if (r.status === 404) return { sha: null, content: null, status: 404 };
  if (!r.ok) throw new Error(`GITHUB_GET_FAILED ${r.status}`);
  const data = await r.json();
  const buf = Buffer.from(data.content || '', data.encoding || 'base64');
  return { sha: data.sha, content: buf.toString('utf8'), status: 200 };
}

async function ghPutFile(path, content, sha, message) {
  const url = `${API_BASE}/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GH_TOKEN}`,
      'User-Agent': 'netlify-fn',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GITHUB_PUT_FAILED ${r.status}`);
  const data = await r.json();
  return data.content.sha;
}

function parseState(raw) {
  if (!raw) return { sold:{}, locks:{}, regions:{} };
  try {
    const obj = JSON.parse(raw);
    if (!obj.sold) obj.sold = {};
    if (!obj.locks) obj.locks = {};
    if (!obj.regions) obj.regions = {};
    return obj;
  } catch {
    return { sold:{}, locks:{}, regions:{} };
  }
}

function pruneLocks(locks) {
  const now = Date.now();
  const out = {};
  for (const [k,v] of Object.entries(locks || {})) {
    if (v && typeof v.until === 'number' && v.until > now) out[k] = v;
  }
  return out;
}

exports.handler = async (event, context) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') return ok({ ok: true });

  // Auth JWT (ne JAMAIS lire req.headers.authorization directement)
  const auth = requireAuth(event);
  if (auth && auth.statusCode) return auth; // 401 déjà formatée par le middleware
  const uid = auth.uid;

  // Parse JSON body
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return bad(400, 'BAD_JSON');
  }

  const blocks = Array.isArray(body.blocks) ? body.blocks.map(n => parseInt(n, 10)).filter(Number.isInteger) : [];
  const ttl    = Number(body.ttl || 180000);
  if (!blocks.length) return bad(400, 'NO_BLOCKS');

  try {
    if (event.httpMethod !== 'POST') return jres(405, { ok:false, error:'METHOD_NOT_ALLOWED' });
    if (!GH_REPO || !GH_TOKEN) return jres(500, { ok:false, error:'GITHUB_CONFIG_MISSING' });

    const uid = getAuthenticatedUID(event);
    const body = JSON.parse(event.body || '{}');
    const regionId = String(body.regionId || '').trim();
    const name = (body.name || '').toString().trim();
    const linkUrl = (body.linkUrl || '').toString().trim();

    if (!regionId || !name || !linkUrl) return jres(400, { ok:false, error:'MISSING_FIELDS' });

    // Charger état
    let got = await ghGetFile(STATE_PATH);
    let st = parseState(got.content);
    st.locks = pruneLocks(st.locks);

    const region = st.regions[regionId];
    if (!region) return jres(404, { ok:false, error:'REGION_NOT_FOUND' });
    if (region.uid !== uid) return jres(403, { ok:false, error:'NOT_REGION_OWNER' });

    // Vérifier que l’image est bien uploadée AVANT finalisation
    if (!region.imageUrl) return jres(409, { ok:false, error:'NO_IMAGE_UPLOADED' });

    // Vérifier qu’il reste un lock actif (sinon, réservation expirée)
    const relocks = Object.entries(st.locks)
      .filter(([k,v]) => v && v.regionId === regionId && v.uid === uid);
    if (relocks.length === 0) return jres(409, { ok:false, error:'LOCK_EXPIRED' });

    const now = Date.now();
    const blocks = Array.isArray(region.blocks) ? region.blocks : relocks.map(([k]) => parseInt(k,10));

    // Marquer sold + clear locks
    for (const b of blocks) {
      const key = String(b);
      st.sold[key] = { name, linkUrl, ts: now, regionId };
      if (st.locks[key] && st.locks[key].regionId === regionId) {
        delete st.locks[key];
      }
    }

    // Solidifier la région (enregistrer meta)
    region.name = name;
    region.linkUrl = linkUrl;
    st.regions[regionId] = region;

    const newContent = JSON.stringify(st, null, 2);
    await ghPutFile(STATE_PATH, newContent, got.sha, `finalize ${blocks.length} by ${uid} -> ${regionId}`);

    return jres(200, { ok:true, regionId, soldCount: blocks.length });
  } catch (e) {
    return jres(500, { ok:false, error:'FINALIZE_FAILED', message:String(e&&e.message||e) });
  }
});
