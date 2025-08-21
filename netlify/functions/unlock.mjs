
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

export default async (req) => {
  try {
    if (req.method !== 'POST') return jres(405, { ok:false, error:'METHOD_NOT_ALLOWED' });
    const body = await req.json();
    const uid = (body.uid || '').toString();
    const blocks = Array.isArray(body.blocks) ? body.blocks.map(n=>parseInt(n,10)).filter(n=>Number.isInteger(n)&&n>=0&&n<10000) : [];
    if (!uid || blocks.length===0) return jres(400, { ok:false, error:'MISSING_FIELDS' });

    let got = await ghGetFile(PATH_JSON);
    let sha = got.sha;
    let st = parseState(got.content);
    st.locks = pruneLocks(st.locks);

    let changed = false;
    for (const b of blocks) {
      const key = String(b);
      const l = st.locks[key];
      if (l && l.uid === uid) { delete st.locks[key]; changed = true; }
    }

    if (!changed) return jres(200, { ok:true, locks: st.locks });

    const newContent = JSON.stringify(st, null, 2);
    try {
      const newSha = await ghPutFile(PATH_JSON, newContent, sha, `unlock ${blocks.length} by ${uid}`);
      return jres(200, { ok:true, locks: st.locks });
    } catch (e) {
      if (String(e).includes('GITHUB_PUT_FAILED 409')) {
        // Refetch and return current locks; client will refresh via /status soon
        got = await ghGetFile(PATH_JSON);
        const st2 = parseState(got.content);
        st2.locks = pruneLocks(st2.locks);
        return jres(200, { ok:true, locks: st2.locks });
      }
      throw e;
    }
  } catch (e) {
    return jres(500, { ok:false, error:'UNLOCK_FAILED', message: String(e) });
  }
};
