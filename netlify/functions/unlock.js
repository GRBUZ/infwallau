const { requireAuth } = require('./auth-middleware');

const GH_REPO   = process.env.GH_REPO;
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const STATE_PATH = process.env.STATE_PATH || "data/state.json";

const API_BASE = 'https://api.github.com';

function jres(status, obj) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(obj)
  };
}

/*async function ghGetFile(path) {
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
  const buf = Buffer.from(data.content, data.encoding || 'base64');
  return { sha: data.sha, content: buf.toString('utf8'), status: 200 };
}*/
async function ghGetFile(path) {
  const url = `${API_BASE}/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const headers = {
    'Authorization': `token ${GH_TOKEN}`,
    'User-Agent'   : 'netlify-fn',
    'Accept'       : 'application/vnd.github+json'
  };

  const r = await fetch(url, { headers });
  if (r.status === 404) return { sha: null, content: null, status: 404 };
  if (!r.ok) throw new Error(`GITHUB_GET_FAILED ${r.status}`);

  const data = await r.json();

  // Cas normal: content + base64
  if (typeof data.content === 'string' && String(data.encoding).toLowerCase() === 'base64') {
    const buf = Buffer.from(data.content, 'base64');
    return { sha: data.sha, content: buf.toString('utf8'), status: 200 };
  }

  // Fallback 1: Git Blob API (fiable pour gros fichiers)
  if (data.sha) {
    const r2 = await fetch(`${API_BASE}/repos/${GH_REPO}/git/blobs/${data.sha}`, { headers });
    if (r2.ok) {
      const blob = await r2.json(); // { content, encoding: 'base64' | ... }
      const txt = String(blob.encoding).toLowerCase() === 'base64'
        ? Buffer.from(blob.content || '', 'base64').toString('utf8')
        : String(blob.content || '');
      return { sha: data.sha, content: txt, status: 200 };
    }
  }

  // Fallback 2: download_url (suffit souvent pour repo public)
  if (data.download_url) {
    const r3 = await fetch(data.download_url, { headers: { 'User-Agent': 'netlify-fn' } });
    if (!r3.ok) throw new Error(`GITHUB_RAW_FAILED ${r3.status}`);
    const text = await r3.text();
    return { sha: data.sha || null, content: text, status: 200 };
  }

  // Ultime: si on a quand même un string, on le prend tel quel
  if (typeof data.content === 'string') {
    return { sha: data.sha || null, content: data.content, status: 200 };
  }

  throw new Error('GITHUB_GET_FAILED unknown content encoding');
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
  if (!raw) return { sold:{}, locks:{} };
  try {
    const obj = JSON.parse(raw);
    // Back-compat: if previous format was {artCells:{...}}
    if (obj.artCells && !obj.sold) {
      const sold = {};
      for (const [k,v] of Object.entries(obj.artCells)) {
        sold[k] = { name: v.name || v.n || '', linkUrl: v.linkUrl || v.u || '', ts: v.ts || Date.now() };
      }
      return { sold, locks: obj.locks || {} };
    }
    if (!obj.sold) obj.sold = {};
    if (!obj.locks) obj.locks = {};
    return obj;
  } catch {
    return { sold:{}, locks:{} };
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

exports.handler = async (event) => {
  try {
    // Authentification requise
    const auth = requireAuth(event);
    if (auth.statusCode) return auth; // Erreur d'auth
    
    const authenticatedUID = auth.uid;
    
    if (event.httpMethod !== 'POST') return jres(405, { ok:false, error:'METHOD_NOT_ALLOWED' });
    const body = JSON.parse(event.body || '{}');
    const uid = authenticatedUID; // Utiliser l'UID authentifié
    const blocks = Array.isArray(body.blocks) ? body.blocks.map(n=>parseInt(n,10)).filter(n=>Number.isInteger(n)&&n>=0&&n<10000) : [];
    if (!uid || blocks.length===0) return jres(400, { ok:false, error:'MISSING_FIELDS' });

    // 1) Lire l'état courant
    let got = await ghGetFile(STATE_PATH);
    let sha = got.sha;
    let st = parseState(got.content);
    st.locks = pruneLocks(st.locks);

    // 2) Supprimer mes locks pour les indices demandés
    let changed = false;
    for (const b of blocks) {
      const key = String(b);
      const l = st.locks[key];
      if (l && l.uid === uid) { delete st.locks[key]; changed = true; }
    }

    if (!changed) {
      // Rien à faire, renvoyer l'état actuel (déjà nettoyé)
      return jres(200, { ok:true, locks: st.locks });
    }

    // 3) Commit
    const newContent = JSON.stringify(st, null, 2);
    try {
      await ghPutFile(STATE_PATH, newContent, sha, `unlock ${blocks.length} by ${uid}`);
      // Important: renvoyer la map complète de locks après commit
      return jres(200, { ok:true, locks: st.locks });
    } catch (e) {
      // 409 GitHub: re-fetch, re-appliquer les suppressions, re-commit
      if (String(e).includes('GITHUB_PUT_FAILED 409')) {
        // Recharger l'état le plus frais
        got = await ghGetFile(STATE_PATH);
        sha = got.sha;
        let st2 = parseState(got.content);
        st2.locks = pruneLocks(st2.locks);

        // Re-appliquer la même suppression (idempotent)
        let changed2 = false;
        for (const b of blocks) {
          const key = String(b);
          const l = st2.locks[key];
          if (l && l.uid === uid) { delete st2.locks[key]; changed2 = true; }
        }

        if (changed2) {
          const content2 = JSON.stringify(st2, null, 2);
          await ghPutFile(STATE_PATH, content2, sha, `unlock(retry) ${blocks.length} by ${uid}`);
        }
        // Renvoyer l'état frais (qu'il ait changé ou pas)
        return jres(200, { ok:true, locks: st2.locks });
      }
      throw e;
    }
  } catch (e) {
    return jres(500, { ok:false, error:'UNLOCK_FAILED', message: String(e) });
  }
};