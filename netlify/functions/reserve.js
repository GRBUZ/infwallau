const { requireAuth } = require('./auth-middleware');
const crypto = require('crypto');

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
  if (!raw) return { sold:{}, locks:{}, regions:{} };
  try {
    const obj = JSON.parse(raw);
    if (!obj.sold)   obj.sold   = {};
    if (!obj.locks)  obj.locks  = {};
    if (!obj.regions) obj.regions = {};  // ← s'assure que regions existe
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

// Helpers ajoutés (stables, sans impacter le reste)
function genRegionId(uid, blocks) {
  const arr = Array.from(new Set(blocks)).sort((a,b)=>a-b);
  const seed = `${uid}|${arr.join(',')}`;
  return crypto.createHash('sha1').update(seed).digest('hex').slice(0, 12);
}
function computeRectFromBlocks(blocks, gridW = 100) {
  if (!Array.isArray(blocks) || !blocks.length) return { x:0, y:0, w:1, h:1 };
  let minR=1e9, minC=1e9, maxR=-1, maxC=-1;
  for (const idx of blocks) {
    const r = Math.floor(idx / gridW);
    const c = idx % gridW;
    if (r < minR) minR = r;
    if (c < minC) minC = c;
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  return { x:minC, y:minR, w:(maxC-minC+1), h:(maxR-minR+1) };
}

const TTL_MS = 3 * 60 * 1000; // 3 minutes

exports.handler = async (event) => {
  try {
    // Authentification requise (inchangé)
    const auth = requireAuth(event);
    if (auth.statusCode) return auth;
    const authenticatedUID = auth.uid;

    if (event.httpMethod !== 'POST') return jres(405, { ok:false, error:'METHOD_NOT_ALLOWED' });

    const body = JSON.parse(event.body || '{}');
    const uid = authenticatedUID;
    const blocks = Array.isArray(body.blocks)
      ? body.blocks.map(n=>parseInt(n,10)).filter(n=>Number.isInteger(n)&&n>=0&&n<10000)
      : [];
    if (!uid || blocks.length===0) return jres(400, { ok:false, error:'MISSING_FIELDS' });

    // Read state
    let got = await ghGetFile(STATE_PATH);
    let sha = got.sha;
    let st = parseState(got.content);
    st.locks = pruneLocks(st.locks);

    // Build lock set — on NE modifie pas st.locks ici pour pouvoir calculer regionId sur "locked"
    const now = Date.now();
    const locked = [];
    const conflicts = [];

    for (const b of blocks) {
      const key = String(b);
      if (st.sold[key]) { conflicts.push(b); continue; }
      const l = st.locks[key];
      if (l && l.until > now && l.uid !== uid) { conflicts.push(b); continue; }
      // candidat verrouillable
      locked.push(b);
    }

    // S'il n'y a rien de nouveau à verrouiller, on peut renvoyer l'état actuel (comportement historique)
    if (!locked.length) {
      return jres(200, {
        ok: true,
        locked: [],
        conflicts,
        locks: st.locks,
        ttlSeconds: Math.round(TTL_MS/1000)
      });
    }

    // Générer un regionId STABLE pour *les blocs réellement verrouillés*
    const regionId = genRegionId(uid, locked);

    // Écrire les locks maintenant, avec cap dur de 3 min par "premier lock"
    let regionUntil = 0; // max des until pour la région
    for (const b of locked) {
      const key = String(b);
      const cur = st.locks[key];

      // first = première fois où CE uid a posé le lock (sinon maintenant)
      const first = (cur && cur.uid === uid && typeof cur.first === 'number') ? cur.first : now;
      // capUntil = first + TTL_MS (figé à la première pose pour ce uid)
      const capUntil = (cur && cur.uid === uid && typeof cur.capUntil === 'number') ? cur.capUntil : (first + TTL_MS);
      // on étend au plus à now+TTL_MS, mais jamais au-delà de capUntil
      const proposed = now + TTL_MS;
      const until = Math.min(proposed, capUntil);

      st.locks[key] = { uid, first, until, capUntil, regionId };
      if (until > regionUntil) regionUntil = until;
    }

    // Mettre à jour/Créer le stub de région (reservedUntil = max des until — vérité serveur)
    st.regions ||= {};
    const rect = computeRectFromBlocks(locked);
    if (!st.regions[regionId]) {
      st.regions[regionId] = {
        rect,
        blocks: Array.from(new Set(locked)).sort((a,b)=>a-b),
        imageUrl: st.regions[regionId]?.imageUrl || '',
        name:     st.regions[regionId]?.name     || '',
        linkUrl:  st.regions[regionId]?.linkUrl  || '',
        uid,
        reservedUntil: regionUntil
      };
    } else {
      const reg = st.regions[regionId];
      reg.uid = uid;
      reg.blocks = Array.from(new Set(locked)).sort((a,b)=>a-b);
      reg.rect = rect;
      reg.reservedUntil = Math.max(reg.reservedUntil || 0, regionUntil);
    }

    // Commit
    const newContent = JSON.stringify(st, null, 2);
    try {
      // juste avant d’écrire newState
      const oldState = parseState(got.content || '{}'); // tu l’as déjà dans la plupart des handlers
      const oldSoldCount = Object.keys(oldState.sold || {}).length;
      const newSoldCount = Object.keys(newState.sold || {}).length;
      if (newSoldCount < oldSoldCount) {
        // on n’écrit pas → quelque chose aurait écrasé l’historique
        return jres(409, { ok:false, error:'SOLD_SHRANK_ABORT' });
      }

      await ghPutFile(STATE_PATH, newContent, sha, `reserve ${locked.length} blocks by ${uid} -> ${regionId}`);
    } catch (e) {
      // Retry once on conflict
      if (String(e).includes('GITHUB_PUT_FAILED 409')) {
        got = await ghGetFile(STATE_PATH);
        sha = got.sha;
        st = parseState(got.content);
        st.locks = pruneLocks(st.locks);

        // Recalcule "locked" avec l'état actuel
        const locked2 = [];
        const now2 = Date.now();
        for (const b of blocks) {
          const key = String(b);
          if (st.sold[key]) continue;
          const l = st.locks[key];
          if (l && l.until > now2 && l.uid !== uid) continue;
          locked2.push(b);
        }

        if (!locked2.length) {
          return jres(200, {
            ok: true,
            locked: [],
            conflicts,
            locks: st.locks,
            ttlSeconds: Math.round(TTL_MS/1000)
          });
        }

        const regionId2 = genRegionId(uid, locked2);

        // Re-écrire les locks avec le même cap dur (first/capUntil) et calculer le until max régional
        let regionUntil2 = 0;
        for (const b of locked2) {
          const key = String(b);
          const cur = st.locks[key];

          const first = (cur && cur.uid === uid && typeof cur.first === 'number') ? cur.first : now2;
          const capUntil = (cur && cur.uid === uid && typeof cur.capUntil === 'number') ? cur.capUntil : (first + TTL_MS);
          const proposed = now2 + TTL_MS;
          const until = Math.min(proposed, capUntil);

          st.locks[key] = { uid, first, until, capUntil, regionId: regionId2 };
          if (until > regionUntil2) regionUntil2 = until;
        }

        st.regions ||= {};
        const rect2 = computeRectFromBlocks(locked2);
        if (!st.regions[regionId2]) {
          st.regions[regionId2] = {
            rect: rect2,
            blocks: Array.from(new Set(locked2)).sort((a,b)=>a-b),
            imageUrl: '',
            name: '',
            linkUrl: '',
            uid,
            reservedUntil: regionUntil2
          };
        } else {
          const reg2 = st.regions[regionId2];
          reg2.uid = uid;
          reg2.blocks = Array.from(new Set(locked2)).sort((a,b)=>a-b);
          reg2.rect = rect2;
          reg2.reservedUntil = Math.max(reg2.reservedUntil || 0, regionUntil2);
        }

        const content2 = JSON.stringify(st, null, 2);
        // juste avant d’écrire newState
        const oldState = parseState(got.content || '{}'); // tu l’as déjà dans la plupart des handlers
        const oldSoldCount = Object.keys(oldState.sold || {}).length;
        const newSoldCount = Object.keys(newState.sold || {}).length;
        if (newSoldCount < oldSoldCount) {
          // on n’écrit pas → quelque chose aurait écrasé l’historique
          return jres(409, { ok:false, error:'SOLD_SHRANK_ABORT' });
        }

        await ghPutFile(STATE_PATH, content2, got.sha, `reserve(retry) ${locked2.length} by ${uid} -> ${regionId2}`);

        return jres(200, {
          ok: true,
          locked: locked2,
          conflicts,
          locks: st.locks,
          ttlSeconds: Math.round(TTL_MS/1000),
          regionId: regionId2,
          until: regionUntil2
        });
      }
      throw e;
    }

    // Réponse (compatible + champs additionnels utiles)
    return jres(200, {
      ok: true,
      locked,
      conflicts,
      locks: st.locks,
      ttlSeconds: Math.round(TTL_MS/1000),
      regionId,
      until: regionUntil
    });

  } catch (e) {
    return jres(500, { ok:false, error:'RESERVE_FAILED', message: String(e) });
  }
};
