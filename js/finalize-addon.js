// finalize-addon.js — OPTIMISATION: Upload en parallèle pendant que l'utilisateur remplit le formulaire
(function(){
  'use strict';

  if (!window.CoreManager) {
    console.error('[finalize] CoreManager required');
    return;
  }
  if (!window.UploadManager) {
    console.error('[finalize] UploadManager required');
    return;
  }

  const { uid, apiCall } = window.CoreManager;

  const modal = document.getElementById('modal');
  const confirmBtn = document.getElementById('confirm') || document.querySelector('[data-confirm]');
  const form = document.getElementById('form') || document.querySelector('form[data-finalize]');
  const nameInput = document.getElementById('name') || document.querySelector('input[name="name"]');
  const linkInput = document.getElementById('link') || document.querySelector('input[name="link"]');
  const fileInput = document.getElementById('avatar') || document.getElementById('file') || document.querySelector('input[type="file"]');

  let __processing = false;
  
  // OPTIMISATION 1: Cache de l'upload terminé
  let uploadedImageCache = null; // { imageUrl, regionId, uploadedAt }

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
      if (modal && !modal.classList.contains('hidden') && sel && sel.length) {
        window.LockManager?.heartbeat?.start?.(sel, 30000, 180000, {
          maxMs: 180000,
          autoUnlock: true,
          requireActivity: true
        });
      }
    } catch {}
  }

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

  function normalizeUrl(u){
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
      const url = new URL(u);
      url.hash = '';
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
      console.warn('[finalize] refreshStatus failed', e);
    }
  }

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

  // --- Compression & Upload (ONE robust implementation) ---
  if (fileInput) {
    const supportsWebP = (() => {
      try {
        const c = document.createElement('canvas');
        return !!(c.getContext && c.getContext('2d') && c.toDataURL('image/webp').indexOf('data:image/webp') === 0);
      } catch { return false; }
    })();

    // Legacy compress fallback (Image + canvas + toBlob) used only if createImageBitmap path fails
    async function compressImageLegacy(file, maxWidth = 1200, maxHeight = 1200, quality = 0.82) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = new Image();
          img.onload = () => {
            let { width, height } = img;
            if (width > maxWidth || height > maxHeight) {
              const ratio = Math.min(maxWidth / width, maxHeight / height);
              width = Math.round(width * ratio);
              height = Math.round(height * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, width, height);

            let outType = 'image/jpeg';
            // attempt to preserve alpha if present (but legacy path can't easily detect alpha without getImageData)
            if (supportsWebP) outType = 'image/webp';

            canvas.toBlob((blob) => {
              if (!blob) {
                reject(new Error('Compression failed'));
                return;
              }
              const ext = blob.type.includes('webp') ? '.webp' : blob.type.includes('jpeg') ? '.jpg' : '.png';
              const newName = file.name.replace(/\.[^/.]+$/, '') + ext;
              const compressedFile = new File([blob], newName, { type: blob.type, lastModified: Date.now() });
              resolve(compressedFile);
            }, outType, quality);
          };
          img.onerror = () => reject(new Error('Invalid image'));
          img.src = e.target.result;
        };
        reader.onerror = () => reject(new Error('Failed to read file'));
        reader.readAsDataURL(file);
      });
    }

    // Modern compress using createImageBitmap + OffscreenCanvas when available
    async function compressImageClient(file, { maxWidth = 1200, maxHeight = 1200, quality = 0.80 } = {}) {
      try {
        if (file.size < 50 * 1024) return file;

        let imgBitmap;
        try {
          imgBitmap = await createImageBitmap(file);
        } catch (e) {
          // fallback to legacy if createImageBitmap is unavailable or fails
          return compressImageLegacy(file, maxWidth, maxHeight, quality);
        }

        let { width, height } = imgBitmap;
        const ratio = Math.min(1, maxWidth / width, maxHeight / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);

        let canvas;
        if (typeof OffscreenCanvas !== 'undefined') {
          canvas = new OffscreenCanvas(width, height);
        } else {
          canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
        }
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(imgBitmap, 0, 0, width, height);

        // detect alpha quickly (sample)
        let hasAlpha = false;
        try {
          const id = ctx.getImageData(0, 0, 1, 1).data;
          hasAlpha = id[3] !== 255;
        } catch (e) { hasAlpha = false; }

        let outType = 'image/jpeg';
        if (supportsWebP) outType = 'image/webp';
        else if (hasAlpha) outType = 'image/png';
        if (hasAlpha && supportsWebP) outType = 'image/webp';

        let outBlob;
        if (canvas.convertToBlob) {
          outBlob = await canvas.convertToBlob({ type: outType, quality });
        } else {
          outBlob = await new Promise(res => canvas.toBlob(res, outType, quality));
        }
        if (!outBlob) return file;

        const ext = outBlob.type.includes('webp') ? '.webp' : outBlob.type.includes('jpeg') ? '.jpg' : '.png';
        const newName = file.name.replace(/\.[^/.]+$/, '') + ext;
        const newFile = new File([outBlob], newName, { type: outBlob.type, lastModified: Date.now() });

        console.log(`[Compression] ${file.name}: ${(file.size/1024).toFixed(0)}KB → ${(newFile.size/1024).toFixed(0)}KB (${Math.round(100*(1 - newFile.size/file.size))}% change)`);
        return newFile;
      } catch (err) {
        console.warn('[Compression] error, falling back to original file', err);
        return file;
      }
    }

    // Single handler for file input (keeps UX)
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) { uploadedImageCache = null; return; }

      const selectionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sel-' + Date.now() + '-' + Math.random().toString(36).slice(2,8));
      fileInput.dataset.selectionId = selectionId;
      const regionId = selectionId;

      const modalBody = document.querySelector('.modal .body') || document.querySelector('.modal .panel');
      const progressIndicator = document.createElement('div');
      progressIndicator.className = 'upload-progress-mini';
      progressIndicator.style.cssText = 'position:absolute;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#2563eb;color:#fff;font-size:12px;z-index:9999';
      progressIndicator.innerHTML = 'Validating…';
      if (modalBody) { modalBody.style.position = 'relative'; modalBody.appendChild(progressIndicator); }

      let removedIndicator = false;
      const removeIndicator = () => {
        if (removedIndicator) return;
        removedIndicator = true;
        try { progressIndicator.remove(); } catch {}
      };

      try {
        await window.UploadManager.validateFile(file);
        progressIndicator.innerHTML = 'Compressing…';

        let fileToUpload;
        try {
          fileToUpload = await compressImageClient(file, { maxWidth: 1600, maxHeight: 1600, quality: 0.82 });
        } catch (err) {
          console.warn('Compression failed, continuing with original file', err);
          fileToUpload = file;
        }

        progressIndicator.innerHTML = 'Uploading…';

        const uploadResult = await window.UploadManager.uploadForRegion(fileToUpload, regionId);

        // If user reselected meanwhile, drop stale result (and clean indicator)
        if (fileInput.dataset.selectionId !== selectionId) {
          console.log('[Upload] Stale upload result, ignoring (new selection arrived)');
          removeIndicator();
          return;
        }

        console.log('[Upload] uploadResult:', uploadResult);

        if (!uploadResult || !uploadResult.ok) throw new Error(uploadResult && (uploadResult.error || uploadResult.message) || 'Upload failed');

        uploadedImageCache = {
          imageUrl: uploadResult.imageUrl,
          regionId: uploadResult.regionId || regionId,
          uploadedAt: Date.now()
        };

        progressIndicator.style.background = '#10b981';
        progressIndicator.innerHTML = '✓ Image ready';
        setTimeout(()=> { try { progressIndicator.style.opacity = '0'; setTimeout(()=>{ try{ progressIndicator.remove(); }catch{} }, 300); } catch{} }, 1200);

        console.log('[Upload] Completed:', uploadedImageCache);
      } catch (err) {
        uploadedImageCache = null;
        try { progressIndicator.style.background = '#ef4444'; progressIndicator.innerHTML = '✗ Upload failed'; } catch {}
        console.error('[Upload] Failed:', err);
        setTimeout(()=>removeIndicator(), 2200);
        uiError(err, 'Upload');
      }
    });
  }

  console.log('[Upload] Client-side compression enabled - ready');

  // OPTIMISATION 3: doConfirm allégé - l'image est déjà uploadée
  async function doConfirm(){
    const name = (nameInput && nameInput.value || '').trim();
    const linkUrl = normalizeUrl(linkInput && linkInput.value);
    const blocks = getSelectedIndices();

    if (!blocks.length){ uiWarn('Please select at least one block.'); return; }
    if (!name || !linkUrl){ uiWarn('Name and Profile URL are required.'); return; }

    // Vérifier que l'upload est terminé
    if (!uploadedImageCache) {
      uiWarn('Please wait for image upload to complete or select an image.');
      return;
    }

    // Vérifier que l'upload n'est pas trop vieux (5 minutes max)
    const uploadAge = Date.now() - uploadedImageCache.uploadedAt;
    if (uploadAge > 300000) {
      uiWarn('Image upload expired, please reselect your image.');
      uploadedImageCache = null;
      return;
    }

    pauseHB();
    btnBusy(true);

    try {
      // Vérifier les locks
      if (!haveMyValidLocks(blocks, 1000)) {
        await refreshStatus().catch(()=>{});
        uiWarn('Your reservation expired. Please reselect your pixels.');
        btnBusy(false);
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        return;
      }

      // Renouveler les locks
      try {
        if (window.LockManager) {
          console.log('[Finalize] Renewing locks');
          await window.LockManager.lock(blocks, 180000, { optimistic: false });
        }
      } catch (e) {
        console.warn('[Finalize] Lock renewal failed:', e);
      }

      console.log('[Finalize] Creating order with pre-uploaded image');
      
      // OPTIMISATION: start-order avec imageUrl déjà disponible
      const start = await apiCall('/start-order', {
        method: 'POST',
        body: JSON.stringify({
          name, 
          linkUrl, 
          blocks,
          imageUrl: uploadedImageCache.imageUrl,  // Image déjà uploadée
          regionId: uploadedImageCache.regionId
        })
      });

      if (!start || !start.ok) {
        const message = (start && (start.error || start.message)) || 'Start order failed';
        uiError(window.Errors ? window.Errors.create('START_ORDER_FAILED', message, { details: start }) : new Error(message), 'Start order');
        btnBusy(false);
        try { await unlockSelection(); } catch {}
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        resumeHB();
        return;
      }

      const { orderId, regionId, currency } = start;

      // Étendre les locks avant PayPal
      if (window.LockManager) {
        try {
          await window.LockManager.lock(blocks, 180000, { optimistic: false });
          console.log('[Finalize] Extended locks before PayPal');
        } catch (e) {
          console.warn('[Finalize] Lock extension failed:', e);
        }
      }

      // Afficher PayPal
      showPaypalButton(orderId, currency);

    } catch (e) {
      console.error('[doConfirm] Error:', e);
      uiError(e, 'Confirm');
      btnBusy(false);
      try { await unlockSelection(); } catch {}
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      resumeHB();
    }
  }

  function haveMyValidLocks(blocks, graceMs = 5000) {
    if (!window.LockManager) return true;
    const locks = window.LockManager.getLocalLocks?.() || {};
    const t = Date.now() + graceMs;
    for (const i of blocks || []) {
      const l = locks[String(i)];
      if (!l || l.uid !== uid || !(l.until > t)) return false;
    }
    return true;
  }

  function setPayPalHeaderState(state){
    const el = document.getElementById('paypal-button-container');
    if (!el) return;
    el.className = String(state || '').trim();
  }

  function showPaypalButton(orderId, currency) {
    if (confirmBtn) confirmBtn.style.display = 'none';
    
    const existing = document.getElementById('paypal-button-container');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    if (!window.PayPalIntegration || !window.PAYPAL_CLIENT_ID) {
      uiWarn('Payment: missing PayPal configuration');
      return;
    }

    window.PayPalIntegration.initAndRender({
      orderId,
      currency: currency || 'USD',

      onApproved: async (data, actions) => {
        try {
          btnBusy(true);
          setPayPalHeaderState('processing');

          console.log('[PayPal] Capturing payment');
          const res = await window.CoreManager.apiCall('/paypal-capture-finalize', {
            method: 'POST',
            body: JSON.stringify({ orderId, paypalOrderId: data.orderID })
          });

          if (!res?.ok) {
            const name = res?.details?.name || '';
            const issues = Array.isArray(res?.details?.details) ? res.details.details.map(d => d.issue) : [];
            const isInstrDeclined = res?.error === 'INSTRUMENT_DECLINED' || (name === 'UNPROCESSABLE_ENTITY' && issues.includes('INSTRUMENT_DECLINED'));

            if (isInstrDeclined) {
              setPayPalHeaderState('error');
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

          console.log('[PayPal] Waiting for finalization');
          const ok = await waitForCompleted(orderId, 60);
          
          if (!ok) {
            setPayPalHeaderState('pending');
            btnBusy(false);
            return;
          }

          setPayPalHeaderState('completed');
          try { window.LockManager?.heartbeat?.stop?.(); } catch {}
          try { await unlockSelection(); } catch {}
          
          // Nettoyer le cache d'upload
          uploadedImageCache = null;
          
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
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        setPayPalHeaderState('cancelled');
        try { await unlockSelection(); } catch {}
        btnBusy(false);
      },

      onError: async (err) => {
        uiError(err, 'PayPal');
        setPayPalHeaderState('error');
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        try { await unlockSelection(); } catch {}
        btnBusy(false);
      }
    });
  }

  async function waitForCompleted(orderId, maxSeconds = 120) {
    const maxAttempts = 12;
    let delay = 1000;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const st = await apiCall('/order-status?orderId=' + encodeURIComponent(orderId));
        if (st?.ok) {
          const s = String(st.status || '').toLowerCase();
          if (s === 'completed') return true;
          if (['failed', 'failed_refund', 'cancelled', 'expired'].includes(s)) return false;
          // if processing/pending, continue and backoff
          console.log('[Finalize] order status', s);
        }
      } catch (e) {
        console.warn('[Finalize] order-status check failed', e);
      }
      await new Promise(r => setTimeout(r, delay));
      // increase delay up to 10s
      delay = Math.min(10000, Math.round(delay * 1.7));
    }
    return false;
  }


  // Écouter l'événement de soumission
  document.addEventListener('finalize:submit', (e) => {
    try { e.preventDefault && e.preventDefault(); } catch {}
    doConfirm();
  });

  // CORRECTION: Reset complet incluant le cache d'upload
  function resetModalState() {
    // Reset du cache d'upload
    uploadedImageCache = null;
    
    // Reset du file input
    if (fileInput) {
      fileInput.value = '';
      delete fileInput._cachedFile;
    }
    
    // Supprimer l'indicateur de progress s'il existe
    const progressIndicator = document.querySelector('.upload-progress-mini');
    if (progressIndicator) progressIndicator.remove();
  }

  // Écouter les événements d'ouverture/fermeture du modal
  document.addEventListener('modal:opening', () => {
    resetModalState();
  });

  document.addEventListener('modal:closing', () => {
    resetModalState();
  });

  console.log('[Finalize] Upload optimization loaded - images upload in background');
})();
