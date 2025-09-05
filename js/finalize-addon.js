// finalize-addon.js — Finalize flow patched to use CoreManager + UploadManager (+ LockManager) with robust error handling
// Responsibilities:
// - Re-reserve selection just before finalize
// - Call /finalize
// - Upload image for the returned regionId (optional)
// - Keep UI state in sync (sold/locks/regions), unlock on escape/blur
// - Emit 'finalize:success' event for other modules (e.g., upload-addon.js)
(function(){
  'use strict';

  // Hard deps
  if (!window.CoreManager) {
    console.error('[IW patch] CoreManager required. Load js/core-manager.js before this file.');
    return;
  }
  if (!window.UploadManager) {
    console.error('[IW patch] UploadManager required. Load js/upload-manager.js before this file.');
    return;
  }
  // LockManager strongly recommended
  if (!window.LockManager) {
    console.warn('[IW patch] LockManager not found. Reserve/unlock/merge will be degraded.');
  }
  if (!window.Errors) {
    console.warn('[IW patch] errors.js not found; falling back to alerts/console for user feedback.');
  }

  const { uid, apiCall } = window.CoreManager;

  // DOM handles (we tolerate multiple possible IDs to be resilient)
  const modal        = document.getElementById('modal');
  const confirmBtn   = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form         = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput    = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput    = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput    = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');
  if (fileInput && !fileInput.getAttribute('accept')) {
    fileInput.setAttribute('accept', 'image/*');
  }

  // --- pause/reprise du heartbeat pour éviter /reserve pendant le processing
  let __processing = false;
  function pauseHB(){
    if (__processing) return;
    __processing = true;
    try { window.LockManager?.heartbeat?.stop?.(); } catch {}
  }
  function resumeHB(){
    if (!__processing) return;
    __processing = false;
    try {
      // on ne relance que si le modal est encore ouvert et qu'il reste une sélection
      const sel = (typeof getSelectedIndices === 'function') ? getSelectedIndices() : [];
      if (modal && !modal.classList.contains('hidden') && sel && sel.length) {
        window.LockManager?.heartbeat?.start?.(sel); // interval/ttl par défaut
      }
    } catch {}
  }

  // UI helpers
  function uiWarn(msg){
    if (window.Errors && window.Errors.showToast) {
      window.Errors.showToast(msg, window.Errors.LEVEL?.warn || 'warn', 4000);
    } else {
      alert(msg);
    }
  }
  function uiInfo(msg){
    if (window.Errors && window.Errors.showToast) {
      window.Errors.showToast(msg, window.Errors.LEVEL?.info || 'info', 2500);
    } else {
      console.log('[Info]', msg);
    }
  }
  function uiError(err, ctx){
    if (window.Errors && window.Errors.notifyError) {
      window.Errors.notifyError(err, ctx);
    } else {
      console.error(ctx ? `[${ctx}]` : '[Error]', err);
      alert((err && err.message) || 'Something went wrong');
    }
  }
  function btnBusy(busy){
    if (!confirmBtn) return;
    try {
      if (busy) {
        confirmBtn.dataset._origText = confirmBtn.dataset._origText || confirmBtn.textContent;
        confirmBtn.textContent = 'Processing…';
        confirmBtn.disabled = true;
      } else {
        if (confirmBtn.dataset._origText) {
          confirmBtn.textContent = confirmBtn.dataset._origText;
          delete confirmBtn.dataset._origText;
        }
        confirmBtn.disabled = false;
      }
    } catch {}
  }

  // Local helpers
  function normalizeUrl(u){
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const url = new URL(u);
      url.hash = ''; // drop fragment
      return url.toString();
    } catch {
      return '';
    }
  }

  function getSelectedIndices(){
    // 1) If app.js exposed a helper
    if (typeof window.getSelectedIndices === 'function') {
      try { const arr = window.getSelectedIndices(); if (Array.isArray(arr)) return arr; } catch {}
    }
    // 2) If a global Set "selected" exists
    if (window.selected && window.selected instanceof Set) {
      return Array.from(window.selected);
    }
    // 3) Infer from DOM
    const out = [];
    document.querySelectorAll('.cell.sel').forEach(el=>{
      const idx = parseInt(el.dataset.idx, 10);
      if (Number.isInteger(idx)) out.push(idx);
    });
    return out;
  }

  async function refreshStatus(){
    try {
      const d = await apiCall('/status?ts=' + Date.now());
      if (!d || !d.ok) return;
      window.sold = d.sold || {};
      if (window.LockManager) {
        const merged = window.LockManager.merge(d.locks || {});
        window.locks = merged;
      } else {
        window.locks = d.locks || {};
      }
      window.regions = d.regions || {};
      if (typeof window.renderRegions === 'function') window.renderRegions();
    } catch (e) {
      // Silencieux pour éviter le spam; Errors.js notifie déjà sur l'échec API si nécessaire
      console.warn('[IW patch] refreshStatus failed', e);
    }
  }

  // Unlock helpers
  async function unlockSelection(){
    try{
      const blocks = getSelectedIndices();
      if (!blocks.length) return;
      if (window.LockManager) {
        await window.LockManager.unlock(blocks);
      } else {
        await apiCall('/unlock', { method:'POST', body: JSON.stringify({ blocks }) });
      }
    }catch(_){}
  }

  async function unlockKeepalive(){
    try{
      const blocks = getSelectedIndices();
      if (!blocks.length) return;
      if (window.LockManager) {
        await window.LockManager.unlock(blocks);
      } else {
        await apiCall('/unlock', {
          method:'POST',
          body: JSON.stringify({ blocks }),
          headers: { 'Content-Type': 'application/json' },
          keepalive: true
        });
      }
    }catch(_){}
  }


  // Global listeners to avoid "lost locks"
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') unlockSelection();
  }, { passive:true });


  // Finalize flow
  async function doConfirm(){
    const name = (nameInput && nameInput.value || '').trim();
    const linkUrl = normalizeUrl(linkInput && linkInput.value);
    const blocks = getSelectedIndices();

    if (!blocks.length){ uiWarn('Please select at least one block.'); return; }
    if (!name || !linkUrl){ uiWarn('Name and Profile URL are required.'); return; }

    // ✅ Pré-validation du fichier sélectionné AVANT toute finalisation
    try {
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (file) {
        // Vérifie type MIME réel + taille
        await window.UploadManager.validateFile(file);
      }
    } catch (preErr) {
      uiError(preErr, 'Upload');
      uiWarn('Veuillez sélectionner une image valide (PNG, JPG, GIF, WebP).');
      return; // ⛔️ on sort: PAS de /finalize
    }

    pauseHB();
    btnBusy(true);

    // Re-reserve just before finalize (defensive)
    try {
      if (window.LockManager) {
        const jr = await window.LockManager.lock(blocks, 180000);
        if (!jr || !jr.ok) {
          await refreshStatus();
          uiWarn((jr && jr.error) || 'Some blocks are already locked/sold. Please reselect.');
          btnBusy(false);
          resumeHB();
          return;
        }
      } else {
        const jr = await apiCall('/reserve', { method:'POST', body: JSON.stringify({ blocks, ttl: 180000 }) });
        if (!jr || !jr.ok) {
          await refreshStatus();
          uiWarn((jr && jr.error) || 'Some blocks are already locked/sold. Please reselect.');
          btnBusy(false);
          resumeHB();
          return;
        }
      }
    } catch (e) {
      // Non fatal; server will re-check on finalize
      console.warn('[IW patch] pre-finalize reserve warning:', e);
    }

    // === START-ORDER: on prépare la commande et on uploade l'image en staging ===
    let start = null;
    try {
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (!file) {
        uiWarn("Veuillez sélectionner une image (PNG, JPG, GIF, WebP).");
        btnBusy(false);
        resumeHB(); 
        return;
      }
      const contentType = await window.UploadManager.validateFile(file);
      const { base64Data } = await window.UploadManager.toBase64(file);

      // Server: aucune vente ; image en staging + order record
      start = await apiCall('/start-order', {
        method: 'POST',
        body: JSON.stringify({
          name, linkUrl, blocks,
          filename: file.name,
          contentType,
          contentBase64: base64Data
        })
      });
    } catch (e) {
      uiError(e, 'Start order');
      btnBusy(false);
      resumeHB();
      return;
    }
    if (!start || !start.ok) {
      const message = (start && (start.error || start.message)) || 'Start order failed';
      uiError(window.Errors ? window.Errors.create('START_ORDER_FAILED', message, { details: start }) : new Error(message), 'Start order');
      btnBusy(false);
      resumeHB();
      return;
    }

    // On a un orderId + regionId, l'image est en staging côté repo
    const { orderId, regionId } = start;
    if (fileInput && regionId) fileInput.dataset.regionId = regionId;

    // === Ici tu déclencheras PayPal ===
    uiInfo('Commande créée. Veuillez finaliser le paiement…');

    // === DEV SHORTCUT (pas de PayPal): finaliser tout de suite côté serveur
    const USE_FAKE_PAYMENTS = true; // désactive-le quand tu branches PayPal
    if (USE_FAKE_PAYMENTS) {
      try {
        const r = await apiCall('/dev-complete-order', {
          method: 'POST',
          body: JSON.stringify({ orderId })
        });
        if (!r || !r.ok) {
          uiError(window.Errors ? window.Errors.create('DEV_COMPLETE_FAILED', r?.error || r?.message || 'Dev complete failed', { details: r }) : new Error('Dev complete failed'), 'Dev complete');
          btnBusy(false);
          return;
        }
      } catch (e) {
        uiError(e, 'Dev complete');
        btnBusy(false);
        return;
      }

      // vente faite -> nettoyer UI
      try { await unlockSelection(); } catch {}
      await refreshStatus();
      try { if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden'); } catch {}
      btnBusy(false);
      return; // ⛔️ on ne lance PAS le polling
    }

    // Exemple minimaliste de polling en attendant la confirmation via webhook
    let tries = 0;
    while (tries < 60) { // ~60s; ajuste selon ton webhook
      await new Promise(r => setTimeout(r, 1000));
      tries++;

      try {
        const st = await apiCall('/order-status?orderId=' + encodeURIComponent(orderId));
        if (st && st.ok && st.status === 'completed') {
          break;
        }
        if (st && st.ok && st.status === 'failed') {
          uiWarn("Paiement échoué. Aucun bloc n'a été vendu.");
          btnBusy(false);
          resumeHB();
          return;
        }
        // status: pending -> continue polling
      } catch (pollErr) {
        // ignore 1-2 erreurs réseau
      }
    }

    // After finalize-by-webhook: refresh + unlock selection (verrouillage n'a plus d'intérêt)
    try { await unlockSelection(); } catch {}
    await refreshStatus();
    try { if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden'); } catch {}
    btnBusy(false);

  }

  // Wire up UI
  //if (confirmBtn) confirmBtn.addEventListener('click', (e)=>{ e.preventDefault(); doConfirm(); });
  //if (form) form.addEventListener('submit', (e)=>{ e.preventDefault(); doConfirm(); });

  // Finalize déclenché UNIQUEMENT par app.js (après re-lock)
document.addEventListener('finalize:submit', (e) => {
  try { e.preventDefault && e.preventDefault(); } catch {}
  doConfirm();
});


  // Expose for debugging if needed
  window.__iwPatch = { doConfirm, refreshStatus, unlockSelection, uid };
})();