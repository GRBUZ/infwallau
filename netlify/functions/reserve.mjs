
const GH_REPO   = process.env.GH_REPO;
const GH_TOKEN  = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || 'main';
const PATH_JSON = process.env.PATH_JSON || 'data/state.json';

const API_BASE = 'https://api.github.com';

function jres(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
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

const TTL_MS = 3 * 60 * 1000;

export default async (req) => {
  try {
    if (req.method !== 'POST') return jres(405, { ok:false, error:'METHOD_NOT_ALLOWED' });
    const body = await req.json();
    const uid = (body.uid || '').toString();
    const blocks = Array.isArray(body.blocks) ? body.blocks.map(n=>parseInt(n,10)).filter(n=>Number.isInteger(n)&&n>=0&&n<10000) : [];
    if (!uid || blocks.length===0) return jres(400, { ok:false, error:'MISSING_FIELDS' });

    // Read current state
    let got = await ghGetFile(PATH_JSON);
    let sha = got.sha;
    let st = parseState(got.content);
    st.locks = pruneLocks(st.locks);

    // Build lock set
    const now = Date.now();
    const until = now + TTL_MS;
    const locked = [];
    const conflicts = [];

    for (const b of blocks) {
      const key = String(b);
      if (st.sold[key]) { conflicts.push(b); continue; }
      const l = st.locks[key];
      if (l && l.until > now && l.uid !== uid) { conflicts.push(b); continue; }
      st.locks[key] = { uid, until };
      locked.push(b);
    }

    // Commit only if something changed
    const newContent = JSON.stringify(st, null, 2);
    let newSha;
    try {
      newSha = await ghPutFile(PATH_JSON, newContent, sha, `reserve ${locked.length} blocks by ${uid}`);
    } catch (e) {
      // Retry once on conflict (sha changed)
      if (String(e).includes('GITHUB_PUT_FAILED 409')) {
        got = await ghGetFile(PATH_JSON);
        sha = got.sha; st = parseState(got.content); st.locks = pruneLocks(st.locks);
        // recompute with fresh state (single pass)
        const locked2 = [];
        const now2 = Date.now(); const until2 = now2 + TTL_MS;
        for (const b of blocks) {
          const key = String(b);
          if (st.sold[key]) continue;
          const l = st.locks[key];
          if (l && l.until > now2 && l.uid !== uid) continue;
          st.locks[key] = { uid, until: until2 };
          locked2.push(b);
        }
        const content2 = JSON.stringify(st, null, 2);
        newSha = await ghPutFile(PATH_JSON, content2, got.sha, `reserve(retry) ${locked2.length} by ${uid}`);
        return jres(200, { ok:true, locked: locked2, conflicts, locks: st.locks, ttlSeconds: Math.round(TTL_MS/1000) });
      }
      throw e;
    }
    return jres(200, { ok:true, locked, conflicts, locks: st.locks, ttlSeconds: Math.round(TTL_MS/1000) });
  } catch (e) {
    return jres(500, { ok:false, error:'RESERVE_FAILED', message: String(e) });
  }
};
