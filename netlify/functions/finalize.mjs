// netlify/functions/finalize.mjs — regions-aware finalize
// Env required:
//   GH_REPO   = "OWNER/REPO"
//   GH_TOKEN  = "<fine-grained PAT>"
//   GH_BRANCH = "main"
// Optional:
//   STATE_PATH = "data/state.json"

const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO = process.env.GH_REPO;
const GH_TOKEN = process.env.GH_TOKEN;
const GH_BRANCH = process.env.GH_BRANCH || "main";

const N = 100;

function bad(status, error, extra={}){
  return new Response(JSON.stringify({ ok:false, error, ...extra }), {
    status, headers: { "content-type":"application/json", "cache-control":"no-store" }
  });
}

function idxToXY(idx){ return { x: idx % N, y: (idx / N) | 0 }; }
function boundsFromIndices(indices){
  let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
  for(const i of indices){
    const p = idxToXY(i);
    if (p.x<x0) x0=p.x; if (p.x>x1) x1=p.x;
    if (p.y<y0) y0=p.y; if (p.y>y1) y1=p.y;
  }
  return { x:x0, y:y0, w:(x1-x0+1), h:(y1-y0+1) };
}

async function ghGetJson(path){
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`, {
    headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" }
  });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}

async function ghPutJson(path, jsonData, sha){
  // pretty-print (indent=2) + newline final pour une lecture propre dans GitHub
  const pretty = JSON.stringify(jsonData, null, 2) + "\n";
  const content = Buffer.from(pretty, "utf-8").toString("base64");
  const body = {
    message: "chore: update state (pretty JSON)",
    content,
    branch: GH_BRANCH,
    sha
  };
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`GH_PUT_FAILED:${r.status}`);
  return r.json();
}


export default async (req) => {
  try {
    if (req.method !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN) return bad(500, "GITHUB_CONFIG_MISSING");

    const payload = await req.json().catch(()=>null);
    if (!payload) return bad(400, "BAD_JSON");

    const name = String(payload.name || "").trim().slice(0, 40);
    const blocks = Array.isArray(payload.blocks) ? payload.blocks.map(n => Number(n)) : [];

    // remplace ces lignes :
// const linkUrl = String(payload.linkUrl || "").trim();
// if (!name || !linkUrl || !blocks.length) return bad(400, "MISSING_FIELDS");
// if (!/^https?:\/\//i.test(linkUrl)) return bad(400, "INVALID_URL");

// par :
const rawUrl = String(payload.linkUrl || "").trim();
if (!name || !rawUrl || !blocks.length) return bad(400, "MISSING_FIELDS");

let linkUrl;
try {
  linkUrl = normalizeUrl(rawUrl);
} catch (e) {
  return bad(400, "INVALID_URL");
}

function normalizeUrl(raw) {
  let s = (raw || "").trim();
  if (!s) throw new Error("EMPTY");
  // Si l'utilisateur n'a pas mis de schéma, on préfixe en https://
  if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) {
    s = "https://" + s;
  }
  let u;
  try { u = new URL(s); } catch { throw new Error("INVALID_URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("INVALID_URL_SCHEME");
  }
  u.hash = "";            // on enlève l’ancre (#...)
  return u.toString();    // URL normalisée
}


    // Load state.json
    const { json: state0, sha } = await ghGetJson(STATE_PATH);
    const state = state0 || { sold:{}, locks:{}, regions:{} };

    // Anti-double-achat: blocs libres
    for (const idx of blocks) {
      if (state.sold[idx]) return bad(409, "ALREADY_SOLD", { idx });
      const lk = state.locks[idx];
      if (lk && lk.uid && lk.uid !== payload.uid) return bad(409, "LOCKED_BY_OTHER", { idx });
    }

    // Crée une région unique pour cette sélection
    const regionId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`;
    const rect = boundsFromIndices(blocks);
    if (!state.regions) state.regions = {};
    state.regions[regionId] = { imageUrl: "", rect };

    // Ecrit les blocs vendus avec regionId
    const ts = Date.now();
    for (const idx of blocks) {
      state.sold[idx] = { name, linkUrl, ts, regionId };
      if (state.locks) delete state.locks[idx];
    }

    await ghPutJson(STATE_PATH, state, sha);
    return new Response(JSON.stringify({ ok:true, regionId, rect, soldCount: blocks.length }), {
      headers: { "content-type":"application/json", "cache-control":"no-store" }
    });
  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e && e.message || e) });
  }
};
