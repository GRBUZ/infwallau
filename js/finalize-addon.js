// finalize-addon.js — Finalize flow using CoreManager + UploadManager (+ LockManager) with robust error handling
// Responsibilities:
// - Call /start-order (server = source of truth: validations + image upload + order JSON + server price)
// - Render PayPal button; onApprove => webhook -> finalize via RPC; front polls /order-status until completed
// - Keep UI state in sync (sold/locks/regions), unlock on escape/cancel/error
// - Renew locks at key steps (Confirm + PayPal)

(function(){
  'use strict';

  // --- Internal state
  let __watch = null; // PayPal expiration watcher (for header state)

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

  function haveMyValidLocks(blocks, graceMs = 2000){
    if (!Array.isArray(blocks) || !blocks.length) return false;
    const now = Date.now() + Math.max(0, graceMs|0);
    const myUid = uid;
    // front-side source of truth
    let map = {};
    try {
      map = window.LockManager?.getLocalLocks?.() || window.locks || {};
    } catch (_) {
      map = window.locks || {};
    }
    for (const i of blocks) {
      const l = map[String(i)];
      if (!l || l.uid !== myUid || !(Number(l.until) > now)) return false;
    }
    return true;
  }

  // DOM handles (be resilient to multiple possible IDs)
  const modal        = document.getElementById('modal');
  const confirmBtn   = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form         = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput    = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput    = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput    = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');
  if (fileInput && !fileInput.getAttribute('accept')) {
    fileInput.setAttribute('accept', 'image/*');
  }

  // Heartbeat pause/resume to avoid /reserve while processing
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
      const sel = (typeof getSelectedIndices === 'function') ? getSelectedIndices() : [];
      // do NOT restart if my locks are not valid yet
      if (modal && !modal.classList.contains('hidden') && sel && sel.length && haveMyValidLocks(sel, 0)) {
        window.LockManager?.heartbeat?.start?.(sel, 30000, 180000, {
          maxMs: 180000,        // 3 minutes
          autoUnlock: true,
          requireActivity: true
        });
      } else {
        window.LockManager?.heartbeat?.stop?.();
      }
    } catch {
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
    }
  }

  // UI helpers (only for pre-PayPal validation / developer feedback)
  function uiWarn(msg){
    if (window.Errors && window.Errors.showToast) {
      window.Errors.showToast(msg, window.Errors.LEVEL?.warn || 'warn', 4000);
    } else {
      alert(msg);
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

  // small helpers
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
    if (typeof window.getSelectedIndices === 'function') {
      try { const arr = window.getSelectedIndices(); if (Array.isArray(arr)) return arr; } catch {}
    }
    if (window.selected && window.selected instanceof Set) {
      return Array.from(window.selected);
    }
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

  // ---- PayPal helpers (front)
  async function waitForCompleted(orderId, tries=30) {
    for (let i=0;i<tries;i++){
      const st = await apiCall('/order-status?orderId=' + encodeURIComponent(orderId));
      if (st?.ok && String(st.status).toLowerCase() === 'completed') return true;
      if (st?.ok && String(st.status).toLowerCase() === 'failed') return false;
      await new Promise(rs=>setTimeout(rs, 2000));
    }
    return false;
  }

  // --- PayPal container helpers (single header system)
  function removePaypalContainer(){
    const c = document.getElementById('paypal-button-container');
    if (c && c.parentNode) c.parentNode.removeChild(c);
  }
  function setPayPalHeaderState(state){
    const el = document.getElementById('paypal-button-container');
    if (!el) return;
    // states we use in CSS: 'active' | 'expired' | 'processing' | 'cancelled' | 'error' | 'completed' | 'pending'
    el.className = String(state || '').trim();
  }

  // --- Reset / cleanup FINALIZE
  function resetFinalizeState(){
    // 1) timers/watchers
    if (__watch) { try { clearInterval(__watch); } catch {} __watch = null; }

    // 2) PayPal container + header classes
    const container = document.getElementById('paypal-button-container');
    if (container) {
      container.style.pointerEvents = '';
      container.style.opacity = '';
      container.setAttribute('aria-disabled', 'false');
      if (container.parentNode) container.parentNode.removeChild(container);
    }

    // 3) confirm button
    if (confirmBtn) {
      if (confirmBtn.dataset._origText) {
        confirmBtn.textContent = confirmBtn.dataset._origText;
        delete confirmBtn.dataset._origText;
      }
      confirmBtn.style.display = '';
      confirmBtn.disabled = false;
    }

    // 4) dataset.regionId (do not touch file.value here — app.js resets it already)
    const fi = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');
    if (fi && fi.dataset.regionId) delete fi.dataset.regionId;
  }

  // Events emitted by app.js in openModal()/closeModal()
  document.addEventListener('modal:opening', resetFinalizeState);
  document.addEventListener('modal:closing', resetFinalizeState);

  function showPaypalButton(orderId, currency){
    // hide confirm and mount PayPal container
    if (confirmBtn) confirmBtn.style.display = 'none';
    removePaypalContainer();

    if (!window.PayPalIntegration || !window.PAYPAL_CLIENT_ID) {
      uiWarn('Payment: missing PayPal configuration (PAYPAL_CLIENT_ID / PayPalIntegration).');
      return;
    }

    function haveMyValidLocksLocal(indices, graceMs = 5000) {
      if (!window.LockManager) return true;
      const locks = window.LockManager.getLocalLocks?.() || {};
      const t = Date.now() + graceMs;
      for (const i of indices || []) {
        const l = locks[String(i)];
        if (!l || l.uid !== uid || !(l.until > t)) return false;
      }
      return true;
    }

    function setupPayPalExpiryHeader() {
      const blocks = getSelectedIndices();
      if (__watch) { try { clearInterval(__watch); } catch {} __watch = null; }
      
      function tick() {
        if (modal && modal.classList.contains('hidden')) {
          if (__watch) { try { clearInterval(__watch); } catch {} }
          __watch = null;
          return;
        }
        
        const ok = haveMyValidLocksLocal(blocks);
        const container = document.getElementById('paypal-button-container');
        if (container) {
          container.style.pointerEvents = ok ? 'auto' : 'none';
          container.style.opacity = ok ? '' : '0.6';
          setPayPalHeaderState(ok ? 'active' : 'expired');
        }

        if (!ok && __watch) {
          clearInterval(__watch);
          __watch = null;
        }
      }
      
      __watch = setInterval(tick, 10000);
      tick();
    }

    setupPayPalExpiryHeader();

    window.PayPalIntegration.initAndRender({
      orderId,
      currency: currency || 'USD',

      onApproved: async (data, actions) => {
        // do NOT stop heartbeat here — needed to validate locks
        try { if (__watch) { clearInterval(__watch); } } catch {}
        __watch = null;

        try {
          btnBusy(true);
          setPayPalHeaderState('processing');

          // Final guard: verify locks BEFORE stopping heartbeat
          if (window.LockManager) {
            const me = window.CoreManager?.uid;
            const t = Date.now() + 1000;
            const loc = window.LockManager.getLocalLocks();
            const blocks = getSelectedIndices();
            const stillOk = blocks.length && blocks.every(i => {
              const l = loc[String(i)];
              return l && l.uid === me && l.until > t;
            });
            if (!stillOk) {
              setPayPalHeaderState('expired');
              try { await unlockSelection(); } catch {}
              btnBusy(false);
              return;
            }
          }
          console.log('UID before capture', window.CoreManager.uid);
          // 1) capture on server
          const res = await window.CoreManager.apiCall('/paypal-capture-finalize', {
            method: 'POST',
            body: JSON.stringify({ orderId, paypalOrderId: data.orderID })
          });

          // PayPal "INSTRUMENT_DECLINED" → restart flow without breaking locks
          if (!res?.ok) {
            const name   = res?.details?.name || '';
            const issues = Array.isArray(res?.details?.details) ? res.details.details.map(d => d.issue) : [];
            const isInstrDeclined = res?.error === 'INSTRUMENT_DECLINED'
                                 || (name === 'UNPROCESSABLE_ENTITY' && issues.includes('INSTRUMENT_DECLINED'));

            if (isInstrDeclined) {
              setPayPalHeaderState('error'); // bank declined
              if (actions && typeof actions.restart === 'function') {
                btnBusy(false);
                await actions.restart();
                return;
              }
              btnBusy(false);
              uiWarn('Payment was declined. Please try again.');
              return;
            }

            throw new Error(res?.error || res?.message || 'FINALIZE_INIT_FAILED');
          }

          // 2) wait for webhook finalize
          const ok = await waitForCompleted(orderId, 60);
          if (!ok) {
            setPayPalHeaderState('pending'); // recorded but waiting for finalize
            btnBusy(false);
            return;
          }

          // 3) success — NOW we can stop heartbeat and unlock
          setPayPalHeaderState('completed');
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
          await refreshStatus();
          try { if (modal && !modal.classList.contains('hidden')) modal.classList.add('hidden'); } catch {}

        } catch (e) {
          uiError(e, 'PayPal');
          setPayPalHeaderState('error');
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
        } finally {
          btnBusy(false);
        }
      },

      onCancel: async () => {
        try { if (__watch) { clearInterval(__watch); } } catch {}
        __watch = null;
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}

        setPayPalHeaderState('cancelled');
        try { await unlockKeepalive(); } catch {}

        btnBusy(false);
        // no resumeHB() — we intentionally release and stop HB here
      },

      onError: async (err) => {
        try { if (__watch) { clearInterval(__watch); } } catch {}
        __watch = null;
        uiError(err, 'PayPal');

        setPayPalHeaderState('error');
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        try { await unlockKeepalive(); } catch {}

        btnBusy(false);
        // no resumeHB()
      }
    });
  }

  //new optimisation upload
  // Optimisation de l'upload dans finalize-addon.js
// Ajoutez ces fonctions AVANT la fonction doConfirm()

// OPTIMISATION 1: Compression d'image côté client
async function compressImage(file, maxWidth = 800, maxHeight = 800, quality = 0.8) {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    
    img.onload = () => {
      // Calculer les nouvelles dimensions
      let { width, height } = img;
      
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width *= ratio;
        height *= ratio;
      }
      
      canvas.width = width;
      canvas.height = height;
      
      // Dessiner l'image redimensionnée
      ctx.drawImage(img, 0, 0, width, height);
      
      // Convertir en blob avec compression
      canvas.toBlob(resolve, file.type, quality);
    };
    
    img.src = URL.createObjectURL(file);
  });
}

// OPTIMISATION 2: Preview avec thumbnail
function showImagePreview(file) {
  const existingPreview = document.querySelector('.image-preview');
  if (existingPreview) {
    existingPreview.remove();
  }
  
  const preview = document.createElement('div');
  preview.className = 'image-preview';
  preview.style.cssText = `
    margin: 10px 0;
    padding: 10px;
    border: 2px dashed #e5e7eb;
    border-radius: 8px;
    background: #f9fafb;
    text-align: center;
  `;
  
  const img = document.createElement('img');
  img.style.cssText = `
    max-width: 150px;
    max-height: 150px;
    border-radius: 4px;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
  `;
  
  const fileInfo = document.createElement('div');
  fileInfo.style.cssText = `
    margin-top: 8px;
    font-size: 12px;
    color: #6b7280;
  `;
  
  img.src = URL.createObjectURL(file);
  fileInfo.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
  
  preview.appendChild(img);
  preview.appendChild(fileInfo);
  
  // Insérer après le file input
  const fileInput = document.getElementById('image') || document.getElementById('avatar');
  if (fileInput && fileInput.parentNode) {
    fileInput.parentNode.insertBefore(preview, fileInput.nextSibling);
  }
  
  // Nettoyer l'URL après un délai
  setTimeout(() => URL.revokeObjectURL(img.src), 5000);
}

// OPTIMISATION 3: Progress bar
function createProgressBar() {
  const existing = document.querySelector('.upload-progress');
  if (existing) existing.remove();
  
  const progressContainer = document.createElement('div');
  progressContainer.className = 'upload-progress';
  progressContainer.style.cssText = `
    margin: 15px 0;
    padding: 10px;
    background: #f3f4f6;
    border-radius: 6px;
    display: none;
  `;
  
  const progressLabel = document.createElement('div');
  progressLabel.className = 'progress-label';
  progressLabel.style.cssText = `
    font-size: 13px;
    font-weight: 500;
    color: #374151;
    margin-bottom: 8px;
  `;
  progressLabel.textContent = 'Preparing upload...';
  
  const progressBarBg = document.createElement('div');
  progressBarBg.style.cssText = `
    width: 100%;
    height: 6px;
    background: #e5e7eb;
    border-radius: 3px;
    overflow: hidden;
  `;
  
  const progressBarFill = document.createElement('div');
  progressBarFill.className = 'progress-fill';
  progressBarFill.style.cssText = `
    height: 100%;
    background: linear-gradient(90deg, #3b82f6, #1d4ed8);
    border-radius: 3px;
    width: 0%;
    transition: width 0.3s ease;
  `;
  
  progressBarBg.appendChild(progressBarFill);
  progressContainer.appendChild(progressLabel);
  progressContainer.appendChild(progressBarBg);
  
  // Insérer avant les boutons du modal
  const modalFooter = document.querySelector('.modal .footer') || document.querySelector('.modal .body');
  if (modalFooter) {
    modalFooter.parentNode.insertBefore(progressContainer, modalFooter);
  }
  
  return {
    container: progressContainer,
    label: progressLabel,
    fill: progressBarFill,
    show: () => progressContainer.style.display = 'block',
    hide: () => progressContainer.style.display = 'none',
    update: (percent, text) => {
      progressBarFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      if (text) progressLabel.textContent = text;
    }
  };
}

// OPTIMISATION 4: Upload en arrière-plan avec XMLHttpRequest pour le progress
async function uploadWithProgress(file, progressBar) {
  const compressedFile = await compressImage(file);
  
  progressBar.update(20, 'Compressing image...');
  await new Promise(resolve => setTimeout(resolve, 500)); // Animation smooth
  
  const formData = new FormData();
  formData.append('file', compressedFile);
  formData.append('regionId', 'temp-' + Date.now()); // Temporaire
  
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percentComplete = 20 + (e.loaded / e.total) * 60; // 20-80%
        progressBar.update(percentComplete, `Uploading... ${Math.round(percentComplete)}%`);
      }
    });
    
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        progressBar.update(90, 'Processing...');
        try {
          const response = JSON.parse(xhr.responseText);
          resolve(response);
        } catch (e) {
          reject(new Error('Invalid response format'));
        }
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`));
      }
    });
    
    xhr.addEventListener('error', () => {
      reject(new Error('Network error during upload'));
    });
    
    // Utiliser votre endpoint d'upload existant
    xhr.open('POST', '/.netlify/functions/upload');
    
    // Ajouter les headers d'authentification
    if (window.CoreManager) {
      window.CoreManager.getAuthHeaders?.().then(headers => {
        Object.entries(headers).forEach(([key, value]) => {
          xhr.setRequestHeader(key, value);
        });
      });
    }
    
    xhr.send(formData);
  });
}

// OPTIMISATION 5: File input listener optimisé
const fileInput = document.getElementById('image') || document.getElementById('avatar');
if (fileInput) {
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    try {
      // Validation immédiate
      await window.UploadManager.validateFile(file);
      
      // Preview
      showImagePreview(file);
      
      // Stocker le fichier pour l'upload plus tard
      fileInput._selectedFile = file;
      
      console.log(`[Upload] File selected and validated: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
      
    } catch (error) {
      console.error('[Upload] File validation failed:', error);
      
      // Effacer le preview si erreur
      const preview = document.querySelector('.image-preview');
      if (preview) preview.remove();
      
      // Afficher l'erreur
      if (window.Errors) {
        window.Errors.showToast(error.message, 'error');
      } else {
        alert(error.message);
      }
    }
  });
}

async function doConfirm(){
  const name = (nameInput && nameInput.value || '').trim();
  const linkUrl = normalizeUrl(linkInput && linkInput.value);
  const blocks = getSelectedIndices();

  if (!blocks.length){ uiWarn('Please select at least one block.'); return; }
  if (!name || !linkUrl){ uiWarn('Name and Profile URL are required.'); return; }

  // Récupérer le fichier pré-validé
  const fileInput = document.getElementById('image') || document.getElementById('avatar');
  const file = fileInput && fileInput._selectedFile;
  
  if (!file) {
    uiWarn('Please select an image.');
    return;
  }

  pauseHB();
  btnBusy(true);

  // Créer la progress bar
  const progressBar = createProgressBar();
  progressBar.show();
  progressBar.update(5, 'Validating reservation...');

  try {
    // Key step 1: renew locks on Confirm (+3 minutes)
    if (!haveMyValidLocks(blocks, 1000)) {
      await refreshStatus().catch(()=>{});
      progressBar.hide();
      uiWarn('Your reservation expired. Please reselect your pixels.');
      btnBusy(false);
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      return;
    }

    progressBar.update(10, 'Extending reservation...');

    // Explicit renewal for +3 minutes
    try {
      if (window.LockManager) {
        console.log('[Finalize] Renewing locks for confirm step');
        await window.LockManager.lock(blocks, 180000, { optimistic: false });
      }
    } catch (e) {
      console.warn('[Finalize] Lock renewal failed:', e);
    }

    progressBar.update(15, 'Uploading image...');

    // === UPLOAD OPTIMISÉ ===
    let uploadResult;
    try {
      uploadResult = await uploadWithProgress(file, progressBar);
    } catch (uploadError) {
      console.error('[Upload] Failed:', uploadError);
      progressBar.hide();
      uiError(uploadError, 'Upload');
      btnBusy(false);
      try { await unlockKeepalive(); } catch {}
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      resumeHB();
      return;
    }

    progressBar.update(85, 'Creating order...');

    // === START-ORDER avec image déjà uploadée ===
    console.log('UID before start-order', window.CoreManager.uid);
    const start = await apiCall('/start-order', {
      method: 'POST',
      body: JSON.stringify({
        name, 
        linkUrl, 
        blocks,
        imageUrl: uploadResult.imageUrl || uploadResult.url // Image déjà uploadée
      })
    });

    if (!start || !start.ok) {
      const message = (start && (start.error || start.message)) || 'Start order failed';
      progressBar.hide();
      uiError(window.Errors ? window.Errors.create('START_ORDER_FAILED', message, { details: start }) : new Error(message), 'Start order');
      btnBusy(false);
      try { await unlockKeepalive(); } catch {}
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      resumeHB();
      return;
    }

    progressBar.update(95, 'Preparing payment...');

    // orderId + regionId
    const { orderId, regionId, currency } = start;
    if (fileInput && regionId) fileInput.dataset.regionId = regionId;

    // Extend +3min BEFORE PayPal
    if (window.LockManager) {
      try {
        await window.LockManager.lock(blocks, 180000, { optimistic: false });
        console.log('[Finalize] Extended locks before PayPal phase');
      } catch (e) {
        console.warn('[Finalize] Lock extension before PayPal failed:', e);
      }
    }

    progressBar.update(100, 'Ready for payment');
    
    // Masquer la progress bar après succès
    setTimeout(() => progressBar.hide(), 1000);

    // Render PayPal
    showPaypalButton(orderId, currency);

  } catch (e) {
    console.error('[doConfirm] Error:', e);
    progressBar.hide();
    uiError(e, 'Confirm');
    btnBusy(false);
    try { await unlockKeepalive(); } catch {}
    try { window.LockManager?.heartbeat?.stop?.(); } catch {}
    resumeHB();
  }
}

console.log('[Upload Optimization] Loaded - compression, preview, and progress tracking enabled');
  //new optimisation upload

  // Finalize flow
  /*async function doConfirm(){
    const name = (nameInput && nameInput.value || '').trim();
    const linkUrl = normalizeUrl(linkInput && linkInput.value);
    const blocks = getSelectedIndices();

    if (!blocks.length){ uiWarn('Please select at least one block.'); return; }
    if (!name || !linkUrl){ uiWarn('Name and Profile URL are required.'); return; }

    // File pre-validation BEFORE finalize
    try {
      const file = fileInput && fileInput.files && fileInput.files[0];
      if (file) {
        await window.UploadManager.validateFile(file);
      } else {
        uiWarn('Please select an image (PNG, JPG, GIF, WebP).');
        return;
      }
    } catch (preErr) {
      uiError(preErr, 'Upload');
      uiWarn('Please select a valid image (PNG, JPG, GIF, WebP).');
      return;
    }

    pauseHB();
    btnBusy(true);

    // Key step 1: renew locks on Confirm (+3 minutes)
    if (!haveMyValidLocks(blocks, 1000)) {
      await refreshStatus().catch(()=>{});
      uiWarn('Your reservation expired. Please reselect your pixels.');
      btnBusy(false);
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      return;
    }

    // Explicit renewal for +3 minutes
    try {
      if (window.LockManager) {
        console.log('[Finalize] Renewing locks for confirm step');
        await window.LockManager.lock(blocks, 180000, { optimistic: false });
      }
    } catch (e) {
      console.warn('[Finalize] Lock renewal failed:', e);
    }

    // === START-ORDER: server prepares order and uploads the image ===
    let start = null;
    try {
      const file = fileInput.files[0];
      const contentType = await window.UploadManager.validateFile(file);
      const { base64Data } = await window.UploadManager.toBase64(file);

      console.log('UID before start-order', window.CoreManager.uid);
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
      try { await unlockKeepalive(); } catch {}
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      resumeHB();
      return;
    }
    if (!start || !start.ok) {
      const message = (start && (start.error || start.message)) || 'Start order failed';
      uiError(window.Errors ? window.Errors.create('START_ORDER_FAILED', message, { details: start }) : new Error(message), 'Start order');
      btnBusy(false);
      try { await unlockKeepalive(); } catch {}
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      resumeHB();
      return;
    }

    // orderId + regionId
    const { orderId, regionId, currency } = start;
    if (fileInput && regionId) fileInput.dataset.regionId = regionId;

    // Extend +3min BEFORE PayPal
    if (window.LockManager) {
      try {
        await window.LockManager.lock(blocks, 180000, { optimistic: false });
        console.log('[Finalize] Extended locks before PayPal phase');
      } catch (e) {
        console.warn('[Finalize] Lock extension before PayPal failed:', e);
      }
    }

    // Render PayPal (header-only messaging via classes)
    showPaypalButton(orderId, currency);
    // PayPal handlers will take over (onApproved / onCancel / onError)
  }*/

  // Triggered ONLY by app.js (after re-lock)
  document.addEventListener('finalize:submit', (e) => {
    try { e.preventDefault && e.preventDefault(); } catch {}
    doConfirm();
  });

  //new upload progress
  // AJOUT SIMPLE pour améliorer l'upload - à ajouter à la fin de finalize-addon.js

// Progress bar simple
function showProgress(text, percent = 0) {
  let progressEl = document.querySelector('.simple-progress');
  if (!progressEl) {
    progressEl = document.createElement('div');
    progressEl.className = 'simple-progress';
    progressEl.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: white; padding: 20px; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: 10000; min-width: 250px; text-align: center;
    `;
    document.body.appendChild(progressEl);
  }
  progressEl.innerHTML = `
    <div style="margin-bottom: 15px; font-weight: 600;">${text}</div>
    <div style="background: #e5e7eb; height: 4px; border-radius: 2px; overflow: hidden;">
      <div style="background: #3b82f6; height: 100%; width: ${percent}%; transition: width 0.3s;"></div>
    </div>
  `;
}

function hideProgress() {
  const progressEl = document.querySelector('.simple-progress');
  if (progressEl) progressEl.remove();
}

// Modifier doConfirm pour ajouter feedback visuel
const originalConfirm = window.doConfirm;
if (originalConfirm) {
  window.doConfirm = async function() {
    showProgress('Processing...', 10);
    try {
      await originalConfirm.call(this);
    } finally {
      hideProgress();
    }
  };
}
  //new upload progress

  // Expose helpers if needed
  window.__finalizeHelpers = { resetFinalizeState, showPaypalButton };
  // Debug exports
  window.__iwPatch = { doConfirm, refreshStatus, unlockSelection, uid };
})();
