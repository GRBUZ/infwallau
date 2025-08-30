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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') unlockSelection(); }, { passive:true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') unlockKeepalive();
  });

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
        // Vérifie type MIME réel + taille (UploadManager.validateFile lève "Invalid file type" / "Too large")
        await window.UploadManager.validateFile(file);
        // (Optionnel) tu peux aussi faire une vérif taille côté UI ici via file.size si tu veux un message encore plus rapide.
      }
    } catch (preErr) {
      // Empêche la vente si l'image n'est pas valable
      uiError(preErr, 'Upload');
      uiWarn('Veuillez sélectionner une image valide (PNG, JPG, GIF, WebP).');
      return; // ⛔️ on sort: PAS de /finalize
    }

    btnBusy(true);

    // Re-reserve just before finalize (defensive)
    try {
      if (window.LockManager) {
        const jr = await window.LockManager.lock(blocks, 180000);
        if (!jr || !jr.ok) {
          await refreshStatus();
          uiWarn((jr && jr.error) || 'Some blocks are already locked/sold. Please reselect.');
          btnBusy(false);
          return;
        }
      } else {
        const jr = await apiCall('/reserve', { method:'POST', body: JSON.stringify({ blocks, ttl: 180000 }) });
        if (!jr || !jr.ok) {
          await refreshStatus();
          uiWarn((jr && jr.error) || 'Some blocks are already locked/sold. Please reselect.');
          btnBusy(false);
          return;
        }
      }
    } catch (e) {
      // Non fatal; server will re-check on finalize
      console.warn('[IW patch] pre-finalize reserve warning:', e);
    }

    // Finalize
    let out = null;
    try {
      out = await apiCall('/finalize', {
        method:'POST',
        body: JSON.stringify({ name, linkUrl, blocks })
      });
    } catch (e) {
      // CoreManager.apiCall notifie déjà, on ajoute un contexte si besoin
      uiError(e, 'Finalize');
      btnBusy(false);
      return;
    }

    if (!out || !out.ok) {
      const message = (out && (out.error || out.message)) || 'Finalize failed';
      const err = window.Errors ? window.Errors.create('FINALIZE_FAILED', message, { status: out?.status || 0, retriable: false, details: out }) : new Error(message);
      uiError(err, 'Finalize');
      btnBusy(false);
      return;
    }

    // Save regionId for other modules and emit event
    try {
      const regionId = out.regionId || '';
      if (fileInput && regionId) {
        fileInput.dataset.regionId = regionId;
      }
      // Emit event for listeners (e.g., upload-addon auto-upload)
      document.dispatchEvent(new CustomEvent('finalize:success', {
        detail: { regionId, blocks, name, linkUrl }
      }));
    } catch (e) {
      console.warn('[IW patch] finalize:success dispatch failed', e);
    }

    // Optional inline upload with UploadManager (kept for backward-compat; upload-addon may also handle it via event)
    // --- finalize-addon.js (patch, dans le bloc "Optional inline upload ...") ---
      try {
        const file = fileInput && fileInput.files && fileInput.files[0];
        if (file) {
          if (!out.regionId) {
            console.warn('[IW patch] finalize returned no regionId, skipping upload');
          } else {
            const uploadResult = await window.UploadManager.uploadForRegion(file, out.regionId);
            const url = uploadResult?.imageUrl || uploadResult?.url || '';
            if (url) {
              // NEW: lier l'image à la région pour mettre à jour state.json côté backend
              try {
                await window.UploadManager.linkImageToRegion(out.regionId, url);
              } catch (linkErr) {
                console.warn('[IW patch] link-image failed after upload', linkErr);
              }
              uiInfo('Image uploaded and linked.');
            } else {
              uiWarn('Image uploaded, but no URL returned.');
            }
          }
        }
      } catch (e) {
        uiError(e, 'Upload');
      }


    // After finalize: refresh + unlock selection
    try {
      await unlockSelection();
    } catch {}

    await refreshStatus();

    // Close modal if exists
    try {
      if (modal && !modal.classList.contains('hidden')) {
        modal.classList.add('hidden');
      }
    } catch {}

    btnBusy(false);
  }

  // Wire up UI
  if (confirmBtn) confirmBtn.addEventListener('click', (e)=>{ e.preventDefault(); doConfirm(); });
  if (form) form.addEventListener('submit', (e)=>{ e.preventDefault(); doConfirm(); });

  // Expose for debugging if needed
  window.__iwPatch = { doConfirm, refreshStatus, unlockSelection, uid };
})();