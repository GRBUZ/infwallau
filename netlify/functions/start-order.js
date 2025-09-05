// netlify/functions/start-order.js
// Crée une commande *sans modifier state.json* :
// - upload l'image en staging
// - écrit data/orders/<orderId>.json (status: "pending")
// - renvoie { orderId, regionId, stagingUrl }

const { requireAuth } = require('./auth-middleware');

const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || 'main';
const ORDERS_DIR = process.env.ORDERS_DIR || 'data/orders'; // dossier des commandes
const N          = 100;              // grille 100x100
const TTL_MS     = 3 * 60 * 1000;    // 3 minutes

const API_BASE = 'https://api.github.com';

// ---------- petites utilitaires ----------
function ok(obj){ return { statusCode:200, headers:hdr(), body:JSON.stringify({ ok:true, ...obj }) }; }
function bad(status, error, extra={}){ return { statusCode:status, headers:hdr(), body:JSON.stringify({ ok:false, error, ...extra }) }; }
function hdr(){ return { 'content-type':'application/json', 'cache-control':'no-store' }; }

function safeFilename(name){
  const parts = String(name || 'image').split('/').pop().split('\\');
  const base  = parts[parts.length-1];
  const cleaned = base.replace(/\s+/g, '-').replace(/[^\w.\-]/g, '_').slice(0, 100);
  const stem = cleaned.replace(/\.[^.]*$/, '') || 'image';
  const ext  = cleaned.match(/\.[^.]*$/)?.[0] || '.jpg';
  return `${stem}_${Date.now()}_${Math.random().toString(36).slice(2,8)}${ext}`;
}
function idxToXY(idx){ return { x: idx % N, y: (idx / N) | 0 }; }
function boundsFromIndices(indices){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for (const i of indices){
    const p = idxToXY(i);
    if (p.x<x0) x0=p.x; if (p.x>x1) x1=p.x;
    if (p.y<y0) y0=p.y; if (p.y>y1) y1=p.y;
  }
  return { x:x0, y:y0, w:(x1-x0+1), h:(y1-y0+1) };
}

// ---------- GitHub helpers ----------
async function ghPutJson(path, jsonData, sha /*peut être null*/, message){
  const pretty = JSON.stringify(jsonData, null, 2) + '\n';
  const body = {
    message: message || 'chore: write json',
    content: Buffer.from(pretty, 'utf-8').toString('base64'),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha; // on ne s’en sert pas ici
  const r = await fetch(`${API_BASE}/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method:'PUT',
    headers:{
      'Authorization': `Bearer ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'netlify-fn',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GH_PUT_JSON_FAILED:${r.status}`);
  return r.json();
}

async function ghPutBinary(path, buffer, message){
  const baseURL = `${API_BASE}/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const headers = {
    'Authorization': `Bearer ${GH_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'netlify-fn'
  };
  // probe (pour SHA si déjà existant)
  let sha = null;
  const probe = await fetch(`${baseURL}?ref=${encodeURIComponent(GH_BRANCH)}`, { headers });
  if (probe.ok) {
    const j = await probe.json();
    sha = j.sha || null;
  } else if (probe.status !== 404) {
    throw new Error(`GH_GET_PROBE_FAILED:${probe.status}`);
  }
  const body = {
    message: message || `feat: upload ${path}`,
    content: Buffer.from(buffer).toString('base64'),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  const put = await fetch(baseURL, { method:'PUT', headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`GH_PUT_BIN_FAILED:${put.status}`);
  return put.json();
}

// ---------- handler ----------
exports.handler = async (event) => {
  try {
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const uid = auth.uid;

    if (event.httpMethod !== 'POST') return bad(405, 'METHOD_NOT_ALLOWED');
    if (!GH_REPO || !GH_TOKEN) return bad(500, 'GITHUB_CONFIG_MISSING', { GH_REPO, GH_BRANCH });

    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return bad(400, 'BAD_JSON'); }

    const name        = String(body.name || '').trim();
    const linkUrl     = String(body.linkUrl || '').trim();
    const blocks      = Array.isArray(body.blocks) ? body.blocks.map(n=>parseInt(n,10)).filter(Number.isInteger) : [];
    const filenameRaw = body.filename || 'image.jpg';
    const contentType = String(body.contentType || '');
    const b64         = String(body.contentBase64 || '');

    if (!name || !linkUrl)                 return bad(400, 'MISSING_FIELDS');
    if (!blocks.length)                    return bad(400, 'NO_BLOCKS');
    if (!b64)                              return bad(400, 'NO_FILE_BASE64');
    if (!contentType.startsWith('image/')) return bad(400, 'NOT_IMAGE');

    // 1) Staging image
    const orderId    = `o_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
    const regionId   = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
    const filename   = safeFilename(filenameRaw);
    const buffer     = Buffer.from(b64, 'base64');
    const stagingKey = `assets/staging/${orderId}/${filename}`;

    await ghPutBinary(stagingKey, buffer, `feat: staging upload for ${orderId}`);
    const stagingUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${stagingKey}`;

    // 2) Order JSON (un fichier par commande — pas de SHA nécessaire)
    const rect = boundsFromIndices(blocks);
    const orderPath = `${ORDERS_DIR}/${orderId}.json`;
    const now = Date.now();
    const orderJson = {
      orderId,
      uid,
      blocks: Array.from(new Set(blocks)).sort((a,b)=>a-b),
      name,
      linkUrl,
      regionId,         // utilisé par /dev-complete-order ou ton webhook
      rect,
      status: 'pending',
      ts: now,
      expiresAt: now + TTL_MS,
      stagingUrl,
      contentType,
      filename
    };

    await ghPutJson(orderPath, orderJson, null, `feat: create order ${orderId}`);

    // 3) Done
    return ok({ orderId, regionId, stagingUrl });

  } catch (e) {
    return bad(500, 'SERVER_ERROR', { message: String(e?.message || e) });
  }
};
