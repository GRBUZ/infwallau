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
async function ghGetStateJson() {
  // 1) RAW GitHub (supporte bien les gros fichiers et évite les encodages exotiques)
  try {
    const raw = await fetch(
      `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${STATE_PATH}`,
      { headers: { "User-Agent": "netlify-fn" } }
    );
    if (raw.ok) {
      const txt = await raw.text();
      try {
        return JSON.parse(txt || "{}");
      } catch {
        // Si le JSON est mal formé ici, on essaie le fallback "contents"
      }
    } else if (raw.status === 404) {
      // Si le fichier n'existe pas, on retourne un état vide
      return { sold:{}, locks:{}, regions:{} };
    }
  } catch (_) {
    // ignore, on tente le fallback
  }

  // 2) GitHub contents API (legacy)
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(STATE_PATH)}?ref=${GH_BRANCH}`,
    { headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json", "User-Agent":"netlify-fn" } }
  );

  if (r.status === 404) return { sold:{}, locks:{}, regions:{} };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);

  const data = await r.json();

  // 2.a) Décode en fonction de l'encodage annoncé
  if (typeof data.content === 'string') {
    try {
      const enc = (data.encoding === 'base64') ? 'base64' : (data.encoding || 'utf-8');
      const buf = Buffer.from(data.content || "", enc);
      return JSON.parse(buf.toString('utf-8') || "{}");
    } catch {
      // 2.b) Dernier secours : télécharger via download_url si disponible
      if (data.download_url) {
        try {
          const dl = await fetch(data.download_url, { headers: { "User-Agent":"netlify-fn" } });
          if (dl.ok) {
            const txt = await dl.text();
            return JSON.parse(txt || "{}");
          }
        } catch {}
      }
    }
  }

  // Si tout échoue, retourner un état vide (évite de casser le front)
  return { sold:{}, locks:{}, regions:{} };
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
