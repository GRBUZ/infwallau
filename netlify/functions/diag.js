const GH_REPO   = process.env.GH_REPO;
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const PATH_JSON = process.env.PATH_JSON || 'data/state.json';

const API_BASE = 'https://api.github.com';

function jres(status, obj) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify(obj)
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
  const buf = Buffer.from(data.content, data.encoding || 'base64');
  return { sha: data.sha, content: buf.toString('utf8'), status: 200 };
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
    // Pas d'auth requise - fonction de diagnostic publique
    
    if (!GH_REPO || !GH_TOKEN) {
      return jres(500, { 
        ok: false, 
        error: 'MISSING_ENV', 
        need: ['GH_REPO','GH_TOKEN'], 
        have: { GH_REPO: !!GH_REPO, GH_TOKEN: !!GH_TOKEN } 
      });
    }
    
    const got = await ghGetFile(PATH_JSON);
    if (got.status === 404) {
      return jres(200, { 
        ok: true, 
        readable: false, 
        status: 404, 
        message: 'state.json not found yet (will be created on first finalize)' 
      });
    }
    
    const st = parseState(got.content);
    const prunedLocks = pruneLocks(st.locks);
    
    return jres(200, { 
      ok: true, 
      readable: true, 
      counts: { 
        sold: Object.keys(st.sold).length, 
        locks: Object.keys(prunedLocks).length,
        regions: Object.keys(st.regions || {}).length
      },
      health: 'OK'
    });
    
  } catch (e) {
    return jres(500, { 
      ok: false, 
      error: 'DIAG_FAILED', 
      message: String(e) 
    });
  }
};