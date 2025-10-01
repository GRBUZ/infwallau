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

  // ---------- UTILITAIRES (PATCH) ----------
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // backgroundFinalize: lance /finalize en arrière-plan, retourne la réponse ou { ok:false, error }
  async function backgroundFinalize(regionId, payload = {}) {
    try {
      // payload attendu: { name, linkUrl, blocks }
      const body = {
        regionId,
        name: payload.name || '',
        linkUrl: payload.linkUrl || '',
        blocks: payload.blocks || []
      };
      const resp = await apiCall('/finalize', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (!resp || !resp.ok) {
        return { ok: false, error: resp?.error || resp?.message || 'finalize failed', details: resp };
      }
      return { ok: true, res: resp };
    } catch (e) {
      console.warn('[Finalize] backgroundFinalize exception', e);
      return { ok: false, error: String(e?.message || e) };
    }
  }

  // linkImageWithRetry: idempotent, retry exponentiel
  async function linkImageWithRetry(regionId, imageUrl, maxRetries = 5) {
    let attempt = 0;
    let lastErr = null;
    while (attempt < maxRetries) {
      try {
        const resp = await apiCall('/link-image', {
          method: 'POST',
          body: JSON.stringify({ regionId, imageUrl })
        });
        if (resp && resp.ok) return resp;
        lastErr = new Error(resp?.error || resp?.message || 'link-image returned error');
      } catch (e) {
        lastErr = e;
      }
      attempt++;
      const backoff = Math.min(2000 * Math.pow(1.7, attempt), 10000) + Math.floor(Math.random() * 300);
      await sleep(backoff);
    }
    const e = new Error('link-image failed after retries: ' + (lastErr?.message || 'unknown'));
    e.cause = lastErr;
    throw e;
  }
  // ---------- FIN UTILITAIRES ----------


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

  // Fonction de compression d'image côté client (ton code original)
  async function compressImageClient(file, maxWidth = 1200, maxHeight = 1200, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = (e) => {
        const img = new Image();
        
        img.onload = () => {
          // Calculer les nouvelles dimensions en conservant le ratio
          let { width, height } = img;
          
          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          
          // Créer un canvas pour redimensionner
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          
          const ctx = canvas.getContext('2d');
          
          // Améliorer la qualité du redimensionnement
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          
          // Dessiner l'image redimensionnée
          ctx.drawImage(img, 0, 0, width, height);
          
          // Convertir en blob avec compression
          canvas.toBlob((blob) => {
            if (!blob) {
              reject(new Error('Compression failed'));
              return;
            }
            
            // Créer un nouveau File avec le nom original
            const compressedFile = new File([blob], file.name, {
              type: blob.type,
              lastModified: Date.now()
            });
            
            console.log(`[Compression] ${file.name}: ${(file.size / 1024 / 1024).toFixed(2)}MB → ${(compressedFile.size / 1024 / 1024).toFixed(2)}MB (${Math.round((1 - compressedFile.size / file.size) * 100)}% reduction)`);
            
            resolve(compressedFile);
          }, file.type, quality);
        };
        
        img.onerror = () => reject(new Error('Invalid image'));
        img.src = e.target.result;
      };
      
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  // helper : detecte support webp
  const supportsWebP = (() => {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext && c.getContext('2d') && c.toDataURL('image/webp').indexOf('data:image/webp') === 0);
    } catch { return false; }
  })();

  // optimized compress (uses createImageBitmap when available) — keeps behaviour similar to original
  async function compressImageClientFast(file, { maxWidth = 1200, maxHeight = 1200, quality = 0.80 } = {}) {
    // Skip tiny files
    if (file.size < 50 * 1024) return file;

    // createImageBitmap is faster and uses less memory than Image + dataURL
    const blob = file;
    let imgBitmap;
    try { imgBitmap = await createImageBitmap(blob); } catch (e) { console.warn('createImageBitmap failed, fallback', e); return file; }

    let { width, height } = imgBitmap;
    const ratio = Math.min(1, maxWidth / width, maxHeight / height);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);

    // canvas (OffscreenCanvas if dispo)
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

    // detect alpha quickly (sample 1px)
    let hasAlpha = false;
    try {
      const id = ctx.getImageData(0, 0, 1, 1).data;
      hasAlpha = id[3] !== 255;
    } catch (e) {
      hasAlpha = false;
    }

    // Choose output type: prefer webp, else jpeg (webp supports alpha too)
    let outType = 'image/jpeg';
    if (supportsWebP) outType = 'image/webp';
    else if (hasAlpha) outType = 'image/png'; // last resort to preserve alpha

    if (hasAlpha && supportsWebP) outType = 'image/webp';

    // Convert to blob
    let outBlob;
    if (canvas.convertToBlob) {
      outBlob = await canvas.convertToBlob({ type: outType, quality });
    } else {
      outBlob = await new Promise((res) => canvas.toBlob(res, outType, quality));
    }
    if (!outBlob) return file;

    const ext = outBlob.type.includes('webp') ? '.webp' : outBlob.type.includes('jpeg') ? '.jpg' : '.png';
    const newName = file.name.replace(/\.[^/.]+$/, '') + ext;
    const newFile = new File([outBlob], newName, { type: outBlob.type, lastModified: Date.now() });

    console.log(`[Compression] ${file.name}: ${(file.size/1024).toFixed(0)}KB → ${(newFile.size/1024).toFixed(0)}KB (${Math.round(100*(1 - newFile.size/file.size))}% change)`);
    return newFile;
  }

  // Single handler for file input (keeps same UX as your original)
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) { uploadedImageCache = null; return; }

      // ensure single active selection - use selectionId to ignore stale uploads
      const selectionId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('sel-' + Date.now() + '-' + Math.random().toString(36).slice(2,8));
      fileInput.dataset.selectionId = selectionId;
      // reuse selectionId as regionId (idempotence côté serveur possible)
      const regionId = selectionId;

      // small UI progress
      const modalBody = document.querySelector('.modal .body') || document.querySelector('.modal .panel');
      const progressIndicator = document.createElement('div');
      progressIndicator.className = 'upload-progress-mini';
      progressIndicator.style.cssText = 'position:absolute;right:12px;bottom:12px;padding:8px 12px;border-radius:8px;background:#2563eb;color:#fff;font-size:12px;z-index:9999';
      progressIndicator.innerHTML = 'Validating…';
      if (modalBody) { modalBody.style.position = 'relative'; modalBody.appendChild(progressIndicator); }

      try {
        await window.UploadManager.validateFile(file);

        progressIndicator.innerHTML = 'Compressing…';
        let fileToUpload;
        try {
          // try faster compress first; fallback to slower if it fails
          fileToUpload = await compressImageClientFast(file, { maxWidth: 1600, maxHeight: 1600, quality: 0.82 });
        } catch (errFast) {
          console.warn('Fast compression failed, falling back to slower compress', errFast);
          try {
            fileToUpload = await compressImageClient(file, 1200, 1200, 0.82);
          } catch (errSlow) {
            console.warn('Slow compression failed, using original', errSlow);
            fileToUpload = file;
          }
        }

        progressIndicator.innerHTML = 'Uploading…';

        // Upload: pass regionId so server can treat it idempotently
        const uploadResult = await window.UploadManager.uploadForRegion(fileToUpload, regionId);

        // If user reselected meanwhile, drop stale result
        if (fileInput.dataset.selectionId !== selectionId) {
          console.log('[Upload] Stale upload result, ignoring (new selection arrived)');
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
        setTimeout(()=> { progressIndicator.style.opacity = '0'; setTimeout(()=>progressIndicator.remove(), 300); }, 1200);

        console.log('[Upload] Completed:', uploadedImageCache);
      } catch (err) {
        uploadedImageCache = null;
        progressIndicator.style.background = '#ef4444';
        progressIndicator.innerHTML = '✗ Upload failed';
        console.error('[Upload] Failed:', err);
        setTimeout(()=>progressIndicator.remove(), 2200);
        uiError(err, 'Upload');
      }
    });
  }

  console.log('[Upload] Client-side compression enabled - expect 70-90% file size reduction');

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

      // [PATCH] lancer finalize en arrière-plan pour accélérer l'UX
      const finalizePromise = backgroundFinalize(regionId, { name, linkUrl, blocks });

      // Étendre les locks avant PayPal
      if (window.LockManager) {
        try {
          await window.LockManager.lock(blocks, 180000, { optimistic: false });
          console.log('[Finalize] Extended locks before PayPal');
        } catch (e) {
          console.warn('[Finalize] Lock extension failed:', e);
        }
      }

      // Afficher PayPal — on passe finalizePromise pour que showPaypalButton puisse attendre si nécessaire
      showPaypalButton(orderId, currency, regionId, finalizePromise);

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

  // showPaypalButton now accepts finalizePromise and regionId to allow background finalize + link-image
  function showPaypalButton(orderId, currency, regionId, finalizePromise) {
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

          console.log('[PayPal] Waiting for finalization (background)');
          // Wait for background finalize to complete (but don't crash if it errors)
          try {
            const fin = await finalizePromise;
            if (!fin || !fin.ok) {
              console.warn('[PayPal] finalize result not ok', fin);
              // We do not block payment success, but warn user if finalize failed
              uiWarn('Payment succeeded but reservation finalization had an issue. We will retry automatically.');
            } else {
              console.log('[PayPal] finalize succeeded', fin.res);
            }
          } catch (e) {
            console.warn('[PayPal] finalizePromise threw', e);
            uiWarn('Payment succeeded but finalization encountered an error; we will recover in background.');
          }

          // After capture, ensure image is linked to region (idempotent)
          try {
            if (uploadedImageCache && uploadedImageCache.imageUrl && regionId) {
              await linkImageWithRetry(regionId, uploadedImageCache.imageUrl);
            } else {
              console.warn('[PayPal] No uploadedImageCache or regionId to link');
            }
          } catch (linkErr) {
            console.error('[PayPal] link-image failed after payment', linkErr);
            // Try to inform server to retry later (optional endpoint)
            try {
              await apiCall('/record-pending-link', {
                method: 'POST',
                body: JSON.stringify({ regionId, imageUrl: uploadedImageCache?.imageUrl, orderId })
              });
            } catch (recErr) {
              console.warn('[PayPal] record-pending-link failed', recErr);
            }
            uiWarn('Your payment succeeded but we had trouble associating your image. We will retry automatically.');
          }

          // final UI updates
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
