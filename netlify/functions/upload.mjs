// netlify/functions/upload.mjs (v2, avec diagnostics)
const STATE_PATH = process.env.STATE_PATH || "data/state.json";
const GH_REPO    = process.env.GH_REPO;
const GH_TOKEN   = process.env.GH_TOKEN;
const GH_BRANCH  = process.env.GH_BRANCH || "main";

function bad(status, error, extra = {}) {
  return new Response(JSON.stringify({ ok:false, error, ...extra, signature:"upload.v2" }), {
    status, headers: { "content-type":"application/json", "cache-control":"no-store" }
  });
}

function safeFilename(name) {
  const parts = String(name || "image").split("/").pop().split("\\");
  const base  = parts[parts.length - 1];
  return base.replace(/\s+/g, "-").replace(/[^\w.\-]/g, "_").slice(0, 120) || "image.jpg";
}

async function ghGetJson(path){
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}?ref=${GH_BRANCH}`,
    { headers: { "Authorization": `Bearer ${GH_TOKEN}`, "Accept":"application/vnd.github+json" } }
  );
  if (r.status === 404) return { json:null, sha:null };
  if (!r.ok) throw new Error(`GH_GET_FAILED:${r.status}`);
  const data = await r.json();
  const content = Buffer.from(data.content || "", "base64").toString("utf-8");
  return { json: JSON.parse(content || "{}"), sha: data.sha };
}

async function ghPutJson(path, jsonData, sha, message){
  const pretty = JSON.stringify(jsonData, null, 2) + "\n";
  const body = {
    message: message || "chore: set region imageUrl",
    content: Buffer.from(pretty, "utf-8").toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha; // n’ajouter sha que s’il existe, sinon 422
  const r = await fetch(
    `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${GH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  if (!r.ok) throw new Error(`GH_PUT_JSON_FAILED:${r.status}`);
  return r.json(); // contient { commit:{ sha:... }, content:{ sha:... } }
}

// Remplace ta ghPutBinary par cette version "upsert"
async function ghPutBinary(path, buffer, message){
  const baseURL = `https://api.github.com/repos/${GH_REPO}/contents/${encodeURIComponent(path)}`;
  const headers = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "Content-Type": "application/json"
  };

  // 1) probe: existe-t-il déjà ? (pour récupérer le sha)
  let sha = null;
  const probe = await fetch(`${baseURL}?ref=${GH_BRANCH}`, { headers });
  if (probe.ok) {
    const j = await probe.json();
    sha = j.sha || null;
  } else if (probe.status !== 404) {
    // autre erreur (ex: 409 si branche), on lève
    throw new Error(`GH_GET_PROBE_FAILED:${probe.status}`);
  }

  // 2) PUT avec ou sans sha (update si sha présent, sinon create)
  const body = {
    message: message || `feat: upload ${path}`,
    content: Buffer.from(buffer).toString("base64"),
    branch: GH_BRANCH
  };
  if (sha) body.sha = sha;

  const put = await fetch(baseURL, { method: "PUT", headers, body: JSON.stringify(body) });
  if (!put.ok) throw new Error(`GH_PUT_BIN_FAILED:${put.status}`);
  return put.json();
}

export default async (req) => {
  try {
    if (req.method !== "POST") return bad(405, "METHOD_NOT_ALLOWED");
    if (!GH_REPO || !GH_TOKEN)  return bad(500, "GITHUB_CONFIG_MISSING", { GH_REPO, GH_BRANCH });

    const ct = (req.headers.get("content-type") || "").toLowerCase();

    let regionId = "";
    let filename = "";
    let buffer   = null;

    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      regionId   = String(form.get("regionId") || "").trim();
      if (!file || !file.name) return bad(400, "NO_FILE");
      if (!file.type || !file.type.startsWith("image/")) return bad(400, "NOT_IMAGE");
      filename = safeFilename(file.name);
      buffer   = Buffer.from(await file.arrayBuffer());
    } else {
      const body = await req.json().catch(() => null);
      if (!body) return bad(400, "BAD_JSON");
      regionId = String(body.regionId || "").trim();
      filename = safeFilename(body.filename || "image.jpg");
      const b64 = String(body.contentBase64 || "");
      if (!b64) return bad(400, "NO_FILE_BASE64");
      buffer   = Buffer.from(b64, "base64");
    }

    if (!regionId) return bad(400, "MISSING_REGION_ID");

    // 1) commit du binaire
    const repoPath = `assets/images/${regionId}/${filename}`;
    const putBin   = await ghPutBinary(repoPath, buffer, `feat: upload ${filename} for ${regionId}`);
    const binSha   = putBin?.commit?.sha;

    // 2) URL RAW
    const imageUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/${repoPath}`;

    // 3) mise à jour state.json → regions[regionId].imageUrl
    const { json: state0, sha } = await ghGetJson(STATE_PATH);
    const state = state0 || { sold:{}, locks:{}, regions:{} };
    (state.regions ||= {});
    (state.regions[regionId] ||= { imageUrl:"", rect:{ x:0, y:0, w:1, h:1 } });
    state.regions[regionId].imageUrl = imageUrl;

    const putJson = await ghPutJson(STATE_PATH, state, sha, `chore: set imageUrl for ${regionId}`);
    const jsonSha = putJson?.commit?.sha;

    return new Response(JSON.stringify({
      ok: true,
      signature: "upload.v2",
      regionId,
      path: repoPath,
      imageUrl,
      GH_REPO,
      GH_BRANCH,
      binSha,
      jsonSha
    }), { headers: { "content-type":"application/json", "cache-control":"no-store" } });
  } catch (e) {
    return bad(500, "SERVER_ERROR", { message: String(e?.message || e), signature:"upload.v2" });
  }
};
