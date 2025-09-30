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

  //new
  // OPTIMISATION MAJEURE: Compression côté client AVANT upload
// À ajouter dans finalize-addon.js AVANT le file input listener

// Fonction de compression d'image côté client
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

// REMPLACER le file input listener existant par cette version optimisée :
if (fileInput) {
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) {
      uploadedImageCache = null;
      return;
    }

    console.log('[Upload] File selected, starting compression + upload...');
    console.log('[Upload] Original size:', (file.size / 1024 / 1024).toFixed(2), 'MB');

    try {
      // ÉTAPE 1: Validation immédiate
      await window.UploadManager.validateFile(file);
      
      // ÉTAPE 2: Créer l'indicateur de progress
      const progressIndicator = document.createElement('div');
      progressIndicator.className = 'upload-progress-mini';
      progressIndicator.style.cssText = `
        position: absolute;
        bottom: 10px;
        right: 10px;
        padding: 8px 12px;
        background: #3b82f6;
        color: white;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        z-index: 10;
        transition: all 0.3s;
        display: flex;
        align-items: center;
        gap: 8px;
      `;
      
      // Mini spinner SVG
      const spinner = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="10" opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" opacity="0.75"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite"/></path></svg>`;
      progressIndicator.innerHTML = `${spinner}<span>Compressing...</span>`;
      
      const modalBody = document.querySelector('.modal .body') || document.querySelector('.modal .panel');
      if (modalBody) {
        modalBody.style.position = 'relative';
        modalBody.appendChild(progressIndicator);
      }

      // ÉTAPE 3: Compression côté client (GAIN MAJEUR ici)
      const compressedFile = await compressImageClient(file);
      
      progressIndicator.querySelector('span').textContent = 'Uploading...';
      
      // Générer un vrai UUID
      let regionId;
      if (window.crypto && window.crypto.randomUUID) {
        regionId = crypto.randomUUID();
      } else {
        regionId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }

      // ÉTAPE 4: Upload du fichier compressé (beaucoup plus rapide)
      const uploadResult = await window.UploadManager.uploadForRegion(compressedFile, regionId);
      
      if (uploadResult && uploadResult.ok) {
        uploadedImageCache = {
          imageUrl: uploadResult.imageUrl,
          regionId: uploadResult.regionId || regionId,
          uploadedAt: Date.now()
        };
        
        progressIndicator.style.background = '#10b981';
        progressIndicator.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg><span>Image ready!</span>`;
        
        setTimeout(() => {
          progressIndicator.style.opacity = '0';
          setTimeout(() => progressIndicator.remove(), 300);
        }, 2000);
        
        console.log('[Upload] Compression + upload completed:', uploadedImageCache);
        console.log('[Upload] Final size:', (compressedFile.size / 1024 / 1024).toFixed(2), 'MB');
        console.log('[Upload] Total time saved: ~', Math.round((file.size - compressedFile.size) / 100000), 'seconds');
      } else {
        throw new Error('Upload failed');
      }
      
    } catch (error) {
      console.error('[Upload] Failed:', error);
      uploadedImageCache = null;
      
      const progressIndicator = document.querySelector('.upload-progress-mini');
      if (progressIndicator) {
        progressIndicator.style.background = '#ef4444';
        progressIndicator.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>Upload failed</span>`;
        setTimeout(() => progressIndicator.remove(), 3000);
      }
      
      if (window.Errors) {
        window.Errors.showToast(error.message || 'Upload failed', 'error');
      }
    }
  });
}

console.log('[Upload] Client-side compression enabled - expect 70-90% file size reduction');
  //new

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

  async function waitForCompleted(orderId, tries=30) {
    for (let i=0;i<tries;i++){
      const st = await apiCall('/order-status?orderId=' + encodeURIComponent(orderId));
      if (st?.ok && String(st.status).toLowerCase() === 'completed') return true;
      if (st?.ok && String(st.status).toLowerCase() === 'failed') return false;
      await new Promise(rs=>setTimeout(rs, 2000));
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