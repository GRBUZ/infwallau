// upload-addon.js — handles profile photo upload to assets/images via Netlify Function
(function(){
  const input = document.getElementById('avatar');
  const out   = document.getElementById('uploadedUrl');
  const btn   = document.getElementById('copyUrl');

  if (!input || !out) return;

  function toBase64(file){
    return new Promise((resolve, reject)=>{
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Read failed'));
      fr.onload  = () => resolve(fr.result);
      fr.readAsDataURL(file);
    });
  }

  input.addEventListener('change', async (e)=>{
    const file = input.files && input.files[0];
    if (!file) return;
    out.value = 'Uploading… please wait';
    try{
      if (file.size > 1.5 * 1024 * 1024) {
        throw new Error('File too large. Please keep under ~1.5 MB.');
      }
      const dataUrl = await toBase64(file); // "data:image/png;base64,xxxx"
      const m = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
      if (!m) throw new Error('Unsupported image format.');
      const contentType = m[1];
      const b64 = m[2];

      const r = await fetch('/.netlify/functions/upload', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ filename: file.name, contentType, data: b64 })
      });
      const res = await r.json();
      if (!r.ok || !res.ok) throw new Error(res.message || res.error || ('HTTP '+r.status));
      out.value = res.url || '';
      out.dataset.path = res.path || '';
    }catch(err){
      console.error(err);
      out.value = 'Upload failed: ' + (err?.message || err);
    }
  });

  if (btn && out){
    btn.addEventListener('click', ()=>{
      if (!out.value) return;
      out.select();
      try { document.execCommand('copy'); } catch {}
    });
  }
})();
// Après l'UPLOAD OK
// Supposons que tu as:
const regionId = out.regionId;                 // récupéré après /finalize
const repoPath = `assets/images/${regionId}/${filename}`; // ou ce que ton upload a produit
// OU si tu as déjà l’URL: const imageUrl = "https://raw.githubusercontent.com/…"

const linkPayload = {
  regionId,
  imageUrl: repoPath   // <- peut être un chemin repo OU une URL http(s)
};

const resp = await fetch('/.netlify/functions/link-image', {
  method: 'POST',
  headers: { 'content-type':'application/json' },
  body: JSON.stringify(linkPayload)
});
const j = await resp.json();
if (!j.ok) { console.warn('link-image failed:', j); } else { console.log('image linked', j.imageUrl); }

// Optionnel: refresh pour dessiner immédiatement
if (typeof refreshStatus === 'function') await refreshStatus();
