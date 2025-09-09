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

async function ghGetFile(path) {
  const baseUrl = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(GH_BRANCH)}`;
  const headers = {
    'Authorization': `token ${GH_TOKEN}`,
    'User-Agent': 'netlify-fn',
    'Accept': 'application/vnd.github+json'
  };

  try {
    // 1) Essayer l'API Contents d'abord
    const r = await fetch(baseUrl, { headers });
    if (r.status === 404) return { sha: null, content: null, status: 404 };
    if (!r.ok) throw new Error(`GITHUB_GET_FAILED ${r.status}`);

    const data = await r.json();
    const fileSize = Number(data.size || 0);

    // 2) Si le fichier est gros, utiliser l'URL RAW
    if (fileSize > 800000) {
      console.log(`[RESERVE] Large file detected (${Math.round(fileSize/1024)}KB), using RAW URL`);
      const rawUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${path}`;
      const rawRes = await fetch(rawUrl, { 
        headers: { 'User-Agent': 'netlify-fn' },
        timeout: 60000
      });
      if (rawRes.ok) {
        const text = await rawRes.text();
        return { sha: data.sha, content: text, status: 200 };
      } else {
        console.error(`[RESERVE] RAW URL failed: ${rawRes.status}`);
      }
    }

    // 3) Fichier normal via base64
    if (typeof data.content === 'string' && data.encoding === 'base64') {
      const buf = Buffer.from(data.content, 'base64');
      return { sha: data.sha, content: buf.toString('utf8'), status: 200 };
    }

    // 4) Fallback vers download_url si disponible
    if (data.download_url) {
      console.log('[RESERVE] Using download_url fallback');
      const dlRes = await fetch(data.download_url, { 
        headers: { 'User-Agent': 'netlify-fn' }
      });
      if (dlRes.ok) {
        const text = await dlRes.text();
        return { sha: data.sha, content: text, status: 200 };
      }
    }

    throw new Error('GITHUB_GET_FAILED - no valid content method worked');

  } catch (error) {
    console.error(`[RESERVE] Error loading ${path}:`, error.message);
    throw error;
  }
}

async function ghPutFile(path, content, sha, message) {
  const url = `${API_BASE}/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  
  // Vérifier la taille du contenu
  const contentSize = Buffer.from(content, 'utf8').length;
  if (contentSize > 1048576) { // 1MB
    console.warn(`[WARNING] File ${path} is ${contentSize} bytes - may fail`);
  }
  
  const body = {
    message: message || `Update ${path}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;
  
  const options = {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GH_TOKEN}`,
      'User-Agent': 'netlify-fn',
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    timeout: 60000 // 60s timeout pour gros fichiers
  };
  
  const r = await fetch(url, options);
  if (!r.ok) {
    const errorText = await r.text().catch(() => 'unknown');
    throw new Error(`GITHUB_PUT_FAILED ${r.status}: ${errorText}`);
  }
  
  const data = await r.json();
  return data.content?.sha || sha;
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
  console.log(`[RESERVE] Processing ${blocks.length} blocks for uid=${uid}`);
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
