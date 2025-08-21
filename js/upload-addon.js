// upload-addon.js — handles profile photo upload to assets/images via Netlify Function + JWT auth
(function(){
  const input = document.getElementById('avatar');
  const out   = document.getElementById('uploadedUrl');
  const btn   = document.getElementById('copyUrl');

  if (!input || !out) return;

  // === JWT Authentication helpers ===
  function getAuthToken() {
    return localStorage.getItem('authToken');
  }

  function isTokenValid(token) {
    if (!token) return false;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  }

  function getAuthHeaders() {
    const token = getAuthToken();
    if (token && isTokenValid(token)) {
      return { 'Authorization': `Bearer ${token}` };
    }
    return {};
  }

  function requireAuth() {
    const token = getAuthToken();
    if (!token || !isTokenValid(token)) {
      alert('Veuillez vous connecter pour uploader des images');
      return false;
    }
    return true;
  }

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
    
    // Vérifier l'authentification avant upload
    if (!requireAuth()) {
      input.value = ''; // Reset file input
      return;
    }

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

      const authHeaders = getAuthHeaders();
      
      const r = await fetch('/.netlify/functions/upload', {
        method:'POST',
        headers:{
          'content-type':'application/json',
          ...authHeaders // JWT Authentication
        },
        body: JSON.stringify({ filename: file.name, contentType, data: b64 })
      });
      
      const res = await r.json();
      
      if (r.status === 401) {
        throw new Error('Session expirée. Veuillez vous reconnecter.');
      }
      
      if (!r.ok || !res.ok) {
        throw new Error(res.message || res.error || ('HTTP '+r.status));
      }
      
      out.value = res.url || '';
      out.dataset.path = res.path || '';
      
    }catch(err){
      console.error(err);
      out.value = 'Upload failed: ' + (err?.message || err);
      
      // Si erreur d'auth, nettoyer le token
      if (err.message && err.message.includes('Session expirée')) {
        localStorage.removeItem('authToken');
        // Optionnel: rediriger vers login ou recharger la page
        // window.location.reload();
      }
    }
  });

  if (btn && out){
    btn.addEventListener('click', ()=>{
      if (!out.value) return;
      out.select();
      try { document.execCommand('copy'); } catch {}
    });
  }

  // === Enhanced link-image functionality with JWT ===
  async function linkImageToRegion(regionId, imageUrl) {
    if (!requireAuth()) return null;

    try {
      const authHeaders = getAuthHeaders();
      
      const linkPayload = {
        regionId,
        imageUrl // <- peut être un chemin repo OU une URL http(s)
      };

      const resp = await fetch('/.netlify/functions/link-image', {
        method: 'POST',
        headers: { 
          'content-type':'application/json',
          ...authHeaders 
        },
        body: JSON.stringify(linkPayload)
      });
      
      const j = await resp.json();
      
      if (resp.status === 401) {
        alert('Session expirée. Veuillez vous reconnecter.');
        localStorage.removeItem('authToken');
        return null;
      }
      
      if (!j.ok) { 
        console.warn('link-image failed:', j); 
        return null;
      } else { 
        console.log('image linked', j.imageUrl); 
        
        // Optionnel: refresh pour dessiner immédiatement
        if (typeof window.refreshStatus === 'function') {
          await window.refreshStatus();
        }
        
        return j;
      }
    } catch (error) {
      console.error('Error linking image:', error);
      return null;
    }
  }

  // Expose la fonction globalement pour utilisation externe
  window.linkImageToRegion = linkImageToRegion;

  // === Auto-link functionality ===
  // Si on veut automatiquement lier l'image après upload
  // (nécessite que regionId soit disponible quelque part)
  window.autoLinkAfterUpload = async function(regionId) {
    if (!regionId || !out.dataset.path) return;
    
    const result = await linkImageToRegion(regionId, out.dataset.path);
    if (result) {
      alert(`Image liée avec succès à la région ${regionId}`);
    } else {
      alert('Erreur lors de la liaison de l\'image');
    }
  };

  console.log('[upload-addon] JWT auth enabled. Functions: linkImageToRegion, autoLinkAfterUpload');
})();

// === Usage Examples (à utiliser depuis d'autres scripts) ===
/*
// Exemple 1: Lier manuellement après avoir un regionId
const regionId = "r_abc123";
const imageUrl = "assets/images/myimage.jpg";
await window.linkImageToRegion(regionId, imageUrl);

// Exemple 2: Auto-link après upload réussi
// (à appeler depuis votre logique de finalize)
await window.autoLinkAfterUpload(regionId);

// Exemple 3: Workflow complet
async function completeWorkflow() {
  // 1. Finalize pour obtenir regionId
  const finalizeResult = await fetch('/.netlify/functions/finalize', {
    method: 'POST',
    headers: { 
      'content-type': 'application/json',
      'Authorization': `Bearer ${localStorage.getItem('authToken')}`
    },
    body: JSON.stringify({ name, linkUrl, blocks })
  });
  const finalized = await finalizeResult.json();
  
  // 2. Si image uploadée, la lier automatiquement
  if (finalized.ok && finalized.regionId && document.getElementById('uploadedUrl').dataset.path) {
    await window.autoLinkAfterUpload(finalized.regionId);
  }
}
*/