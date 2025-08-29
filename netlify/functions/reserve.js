// netlify/functions/reserve.js
// Réservation + génération d’un regionId dès le lock

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

function computeRectFromBlocks(blocks) {
  // blocks: array d’indices 0..9999 (grille 100x100)
  let minX=1e9, minY=1e9, maxX=-1, maxY=-1;
  for (const b of blocks) {
    const x = b % 100;
    const y = Math.floor(b / 100);
    if (x<minX) minX=x;
    if (y<minY) minY=y;
    if (x>maxX) maxX=x;
    if (y>maxY) maxY=y;
  }
  if (minX===1e9) { minX=minY=0; maxX=maxY=0; }
  return { x:minX, y:minY, w:(maxX-minX+1), h:(maxY-minY+1) };
}

function genRegionId(uid, blocks) {
  const ts = Date.now().toString(36);
  const blk = blocks.slice(0,6).join('-'); // court mais stable
  return `r_${uid.slice(0,8)}_${ts}_${blk}`;
}

// Handler protégé
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

    const uid = getAuthenticatedUID(event); // du middleware (extrait du JWT)
    const body = JSON.parse(event.body || '{}');
    const blocks = Array.isArray(body.blocks)
      ? body.blocks.map(n=>parseInt(n,10)).filter(n=>Number.isInteger(n)&&n>=0&&n<10000)
      : [];
    const ttl = Math.max(60_000, Math.min(parseInt(body.ttl||'180000',10)||180_000, 10*60_000));
    if (!blocks.length) return jres(400, { ok:false, error:'NO_BLOCKS' });

    // Charger state
    let got = await ghGetFile(STATE_PATH);
    let st = parseState(got.content);
    st.locks = pruneLocks(st.locks);

    // Vérifier collisions
    for (const b of blocks) {
      const key = String(b);
      if (st.sold[key]) return jres(409, { ok:false, error:'ALREADY_SOLD' });
      const l = st.locks[key];
      if (l && l.until > Date.now() && l.uid !== uid) {
        return jres(409, { ok:false, error:'LOCKED_BY_OTHER' });
      }
    }

    // Générer regionId pour CETTE réservation
    const regionId = genRegionId(uid, blocks);
    const until = Date.now() + ttl;

    // Poser les locks (tous pointent vers le même regionId)
    for (const b of blocks) {
      st.locks[String(b)] = { uid, until, regionId };
    }

    // Init stub de région si absent
    st.regions ||= {};
    if (!st.regions[regionId]) {
      st.regions[regionId] = {
        rect: computeRectFromBlocks(blocks),
        blocks,
        imageUrl: '',
        name: '',
        linkUrl: '',
        uid
      };
    }

    // Commit
    const newContent = JSON.stringify(st, null, 2);
    await ghPutFile(STATE_PATH, newContent, got.sha, `reserve ${blocks.length} by ${uid} -> ${regionId}`);

    return jres(200, { ok:true, regionId, until, locks: st.locks });
  } catch (e) {
    return jres(500, { ok:false, error:'RESERVE_FAILED', message:String(e&&e.message||e) });
  }
};
