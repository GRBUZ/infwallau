// netlify/functions/status.js — returns sold, locks, regions (robuste + rétro-compat artCells)
const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

function bad(status, error){
  return {
    statusCode: status,
    headers: { "content-type":"application/json", "cache-control":"no-store" },
    body: JSON.stringify({ ok: false, error })
  };
}

function pruneLocks(locks) {
  const now = Date.now();
  const out = {};
  for (const [k, v] of Object.entries(locks || {})) {
    if (v && typeof v.until === 'number' && v.until > now) {
      out[k] = v;
    }
  }
  return out;
}

// --- Lecture robuste du state : via GitHub API (pas de RAW CDN) ---
async function ghGetStateJson() {
  const baseUrl = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(STATE_PATH)}?ref=${GH_BRANCH}`;
  const baseHeaders = { 
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "netlify-fn"
  };

  // 1) Appel "contents" standard pour récupérer metadata (size, encoding, etc.)
  const metaRes = await fetch(baseUrl, { headers: baseHeaders });
  if (metaRes.status === 404) return { sold:{}, locks:{}, regions:{} };
  if (!metaRes.ok) throw new Error(`GH_GET_FAILED:${metaRes.status}`);

  const meta = await metaRes.json();

  // 2) Si petit contenu base64, décodons directement
  if (typeof meta.content === 'string' && meta.encoding === 'base64' && Number(meta.size || 0) < 900000) {
    try {
      const buf = Buffer.from(meta.content, 'base64');
      return JSON.parse(buf.toString('utf-8') || "{}");
    } catch {
      // en cas d'échec, on tente le raw via l'API ci-dessous
    }
  }

  // 3) Sinon re-demander le RAW via l'API (pas le CDN)
  const rawHeaders = {
    ...baseHeaders,
    "Accept": "application/vnd.github.raw"
  };
  const rawRes = await fetch(baseUrl, { headers: rawHeaders });
  if (rawRes.status === 404) return { sold:{}, locks:{}, regions:{} };
  if (!rawRes.ok) throw new Error(`GH_GET_RAW_FAILED:${rawRes.status}`);

  const txt = await rawRes.text();
  try {
    return JSON.parse(txt || "{}");
  } catch {
    return { sold:{}, locks:{}, regions:{} };
  }
}

// --- Rétro-compat : fusionner artCells -> sold si nécessaire ---
function normalizeState(stateIn){
  const st = stateIn && typeof stateIn === 'object' ? stateIn : {};
  const sold = st.sold && typeof st.sold === 'object' ? { ...st.sold } : {};
  const locks = st.locks && typeof st.locks === 'object' ? { ...st.locks } : {};
  const regions = st.regions && typeof st.regions === 'object' ? { ...st.regions } : {};

  // Ancien format : artCells = { idx: { name|n, linkUrl|u, ts } }
  if (st.artCells && typeof st.artCells === 'object') {
    for (const [k, v] of Object.entries(st.artCells)) {
      // Ne pas écraser un sold déjà présent
      if (!sold.hasOwnProperty(k) && v) {
        sold[k] = {
          name:    v.name || v.n || '',
          linkUrl: v.linkUrl || v.u || '',
          ts:      v.ts || Date.now(),
          // pas de regionId historique, on laisse vide
        };
      }
    }
  }

  return { sold, locks, regions };
}

exports.handler = async (event) => {
  try {
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    const rawState = await ghGetStateJson();
    const norm = normalizeState(rawState);

    const sold = norm.sold || {};
    const locks = pruneLocks(norm.locks || {});
    const regions = norm.regions || {};

    return {
      statusCode: 200,
      headers: { "content-type":"application/json", "cache-control":"no-store" },
      body: JSON.stringify({ ok: true, sold, locks, regions })
    };
  } catch (e) {
    return bad(500, "SERVER_ERROR");
  }
};
