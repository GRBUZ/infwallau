// netlify/functions/status.js — returns sold, locks, regions
const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

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

// --- Lecture robuste du state : RAW d'abord, fallback contents (et download_url si besoin)
// --- Lecture robuste du state : via GitHub API (pas de RAW CDN) ---
async function ghGetStateJson() {
  const baseUrl = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(STATE_PATH)}?ref=${GH_BRANCH}`;
  const baseHeaders = { 
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "netlify-fn"
  };

  // 1) Appel "contents" standard pour récupérer metadata (size, encoding, download_url, etc.)
  const metaRes = await fetch(baseUrl, { headers: baseHeaders });
  if (metaRes.status === 404) return { sold:{}, locks:{}, regions:{} };
  if (!metaRes.ok) throw new Error(`GH_GET_FAILED:${metaRes.status}`);

  const meta = await metaRes.json();

  // 2) Si on a du contenu base64 "petit", décodons directement
  if (typeof meta.content === 'string' && meta.encoding === 'base64' && Number(meta.size || 0) < 900000) {
    try {
      const buf = Buffer.from(meta.content, 'base64');
      return JSON.parse(buf.toString('utf-8') || "{}");
    } catch {
      // si décodage JSON échoue, on tente le raw via l'API ci-dessous
    }
  }

  // 3) Pour les gros fichiers / encodage non standard / décodage raté :
  //    on rappelle la même route "contents" mais en demandant le RAW via l’API (pas le CDN)
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
    // En ultime recours, état vide pour ne pas casser le front
    return { sold:{}, locks:{}, regions:{} };
  }
}


exports.handler = async (event) => {
  try {
    // Pas d'auth requise - fonction publique pour afficher l'état du grid
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    const state = await ghGetStateJson();

    const sold    = state.sold || {};
    const locks   = pruneLocks(state.locks || {}); // Nettoie les locks expirés
    const regions = state.regions || {};

    return {
      statusCode: 200,
      headers: { "content-type":"application/json", "cache-control":"no-store" },
      body: JSON.stringify({ ok: true, sold, locks, regions })
    };

  } catch (e) {
    // En cas de vrai incident, on garde ton comportement existant
    return bad(500, "SERVER_ERROR");
  }
};
