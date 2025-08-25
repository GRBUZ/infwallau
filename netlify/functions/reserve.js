// reserve.js — Version simplifiée pour debug
const { requireAuth } = require('./auth-middleware');

const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const STATE_PATH = process.env.STATE_PATH || 'data/state.json';

function jres(status, obj) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(obj)
  };
}

async function ghGetFile(path) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const r = await fetch(url, {
    headers: {
      'Authorization': `token ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json'
    }
  });
  
  if (r.status === 404) return { sha: null, content: null, status: 404 };
  if (!r.ok) throw new Error(`GITHUB_GET_FAILED ${r.status}`);
  
  const data = await r.json();
  const buf = Buffer.from(data.content, data.encoding || 'base64');
  return { sha: data.sha, content: buf.toString('utf8'), status: 200 };
}

async function ghPutFile(path, content, sha, message) {
  const url = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
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
  if (!raw) return { sold: {}, locks: {} };
  try {
    const obj = JSON.parse(raw);
    if (!obj.sold) obj.sold = {};
    if (!obj.locks) obj.locks = {};
    return obj;
  } catch {
    return { sold: {}, locks: {} };
  }
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes

exports.handler = async (event) => {
  try {
    console.log('[Reserve] Request received:', event.httpMethod);
    
    // Auth requise
    const auth = requireAuth(event);
    if (auth.statusCode) {
      console.log('[Reserve] Auth failed:', auth.statusCode);
      return auth;
    }
    
    const authenticatedUID = auth.uid;
    console.log('[Reserve] Authenticated as:', authenticatedUID);

    if (event.httpMethod !== 'POST') {
      return jres(405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
    }

    const body = JSON.parse(event.body || '{}');
    const blocks = Array.isArray(body.blocks) ? body.blocks.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 0 && n < 10000) : [];
    
    console.log('[Reserve] Request data:', { uid: authenticatedUID, blocks: blocks.length });

    if (blocks.length === 0) {
      return jres(400, { ok: false, error: 'NO_BLOCKS' });
    }

    // Lire l'état actuel
    let got = await ghGetFile(STATE_PATH);
    let sha = got.sha;
    let st = parseState(got.content);

    console.log('[Reserve] Current state loaded, sold blocks:', Object.keys(st.sold).length);

    // Nettoyer les locks expirés
    const now = Date.now();
    const cleanLocks = {};
    for (const [k, v] of Object.entries(st.locks || {})) {
      if (v && typeof v.until === 'number' && v.until > now) {
        cleanLocks[k] = v;
      }
    }
    st.locks = cleanLocks;

    // Vérifier disponibilité
    const locked = [];
    const conflicts = [];
    const until = now + TTL_MS;

    for (const b of blocks) {
      const key = String(b);
      
      // Déjà vendu ?
      if (st.sold[key]) {
        conflicts.push(b);
        continue;
      }
      
      // Locké par un autre ?
      const l = st.locks[key];
      if (l && l.until > now && l.uid !== authenticatedUID) {
        conflicts.push(b);
        continue;
      }
      
      // OK à locker
      st.locks[key] = { uid: authenticatedUID, until };
      locked.push(b);
    }

    console.log('[Reserve] Processing result:', { locked: locked.length, conflicts: conflicts.length });

    // Sauvegarder si changements
    if (locked.length > 0) {
      const newContent = JSON.stringify(st, null, 2);
      try {
        await ghPutFile(STATE_PATH, newContent, sha, `reserve ${locked.length} blocks by ${authenticatedUID}`);
        console.log('[Reserve] State saved successfully');
      } catch (e) {
        console.error('[Reserve] Save failed:', e);
        return jres(500, { ok: false, error: 'SAVE_FAILED' });
      }
    }

    return jres(200, { 
      ok: true, 
      locked, 
      conflicts, 
      locks: st.locks, 
      ttlSeconds: Math.round(TTL_MS / 1000) 
    });

  } catch (e) {
    console.error('[Reserve] Error:', e);
    return jres(500, { ok: false, error: 'RESERVE_FAILED', message: String(e) });
  }
};