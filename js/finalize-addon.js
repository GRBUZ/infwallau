// finalize-addon.js – OPTIMISATION: Parallélisation PayPal SDK + start-order
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
  let uploadedImageCache = null;

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

  // ========================================
  // COMPRESSION IMAGE (inchangée)
  // ========================================
  if (fileInput) {
    const supportsWebP = (() => {
      try {
        const c = document.createElement('canvas');
        return !!(c.getContext && c.getContext('2d') && c.toDataURL('image/webp').indexOf('data:image/webp') === 0);
      } catch { return false; }
    })();

    async function compressImageClient(file, { maxWidth = 1200, maxHeight = 1200, quality = 0.80 } = {}) {
      if (file.size < 50 * 1024) return file;

      let imgBitmap;
      try { imgBitmap = await createImageBitmap(file); } catch (e) { console.warn('createImageBitmap failed, fallback', e); return file; }

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

      let hasAlpha = false;
      try {
        const id = ctx.getImageData(0, 0, 1, 1).data;
        hasAlpha = id[3] !== 255;
      } catch (e) {
        hasAlpha = false;
      }

      let outType = 'image/jpeg';
      if (supportsWebP) outType = 'image/webp';
      else if (hasAlpha) outType = 'image/png';
      if (hasAlpha && supportsWebP) outType = 'image/webp';

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

      console.log(`[Compression] ${file.name}: ${(file.size/1024).toFixed(0)}KB → ${(newFile.size/1024).toFixed(0)}KB`);
      return newFile;
    }

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
        if (fileInput.dataset.selectionId !== selectionId) {
          console.log('[Upload] Stale upload result, ignoring');
          return;
        }

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
        setTimeout(()=>progressIndicator.remove(), 2200);
        uiError(err, 'Upload');
      }
    });
  }

  // ========================================
  // 🚀 OPTIMISATION CRITIQUE : doConfirm parallélisé
  // ========================================
  async function doConfirm(){
    const name = (nameInput && nameInput.value || '').trim();
    const linkUrl = normalizeUrl(linkInput && linkInput.value);
    const blocks = getSelectedIndices();

    if (!blocks.length){ uiWarn('Please select at least one block.'); return; }
    if (!name || !linkUrl){ uiWarn('Name and Profile URL are required.'); return; }

    if (!uploadedImageCache) {
      uiWarn('Please wait for image upload to complete or select an image.');
      return;
    }

    const uploadAge = Date.now() - uploadedImageCache.uploadedAt;
    if (uploadAge > 300000) {
      uiWarn('Image upload expired, please reselect your image.');
      uploadedImageCache = null;
      return;
    }

    pauseHB();
    btnBusy(true);

    try {
      // Vérifier les locks rapidement
      if (!haveMyValidLocks(blocks, 1000)) {
        await refreshStatus().catch(()=>{});
        uiWarn('Your reservation expired. Please reselect your pixels.');
        btnBusy(false);
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        return;
      }

      // 🎯 CHANGEMENT CRITIQUE 1: Afficher conteneur PayPal IMMÉDIATEMENT
      console.log('[Finalize] Showing PayPal placeholder immediately');
      const paypalContainer = showPaypalPlaceholder();

      // 🎯 CHANGEMENT CRITIQUE 2: Lancer SDK + start-order EN PARALLÈLE
      console.log('[Finalize] Starting parallel: PayPal SDK + start-order');
      const startTime = performance.now();

      const [sdkReady, orderResult] = await Promise.all([
        ensurePayPalSDKLoaded(),
        finalizeOrder(name, linkUrl, blocks, uploadedImageCache)
      ]);

      const parallelTime = ((performance.now() - startTime) / 1000).toFixed(2);
      console.log(`[Finalize] Parallel execution completed in ${parallelTime}s`);

      if (!orderResult || !orderResult.success) {
        // Erreur: nettoyer et réafficher confirm
        removePaypalContainer();
        btnBusy(false);
        if (orderResult && orderResult.error) {
          uiError(new Error(orderResult.error), 'Start order');
        }
        try { await unlockSelection(); } catch {}
        try { window.LockManager?.heartbeat?.stop?.(); } catch {}
        resumeHB();
        return;
      }

      // ✅ Succès: Rendre les boutons PayPal (quasi-instantané)
      const { orderId, currency } = orderResult;
      console.log('[Finalize] Rendering PayPal buttons (SDK + order ready)');
      // 🆕 TRANSFORMER LE MODAL EN MODE PAIEMENT
      
      
      switchToPaymentView();
      renderPaypalButtons(paypalContainer, orderId, currency);

    } catch (e) {
      console.error('[doConfirm] Error:', e);
      uiError(e, 'Confirm');
      removePaypalContainer();
      btnBusy(false);
      try { await unlockSelection(); } catch {}
      try { window.LockManager?.heartbeat?.stop?.(); } catch {}
      resumeHB();
    }
  }

  // ========================================
  // 🆕 Fonction de finalization (extraction de la logique)
  // ========================================
  async function finalizeOrder(name, linkUrl, blocks, imageCache) {
    try {
      // Renouveler les locks
      if (window.LockManager) {
        try {
          console.log('[Finalize] Renewing locks');
          await window.LockManager.lock(blocks, 180000, { optimistic: false });
        } catch (e) {
          console.warn('[Finalize] Lock renewal failed:', e);
        }
      }

      console.log('[Finalize] Calling /start-order with pre-uploaded image');
      
      const start = await apiCall('/start-order', {
        method: 'POST',
        body: JSON.stringify({
          name, 
          linkUrl, 
          blocks,
          imageUrl: imageCache.imageUrl,
          regionId: imageCache.regionId
        })
      });

      if (!start || !start.ok) {
        const message = (start && (start.error || start.message)) || 'Start order failed';
        return { success: false, error: message };
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

      return { success: true, orderId, regionId, currency };

    } catch (e) {
      console.error('[finalizeOrder] Error:', e);
      return { success: false, error: e.message || 'Unknown error' };
    }
  }

  // ========================================
  // 🆕 Assurer que le SDK PayPal est chargé
  // ========================================
  async function ensurePayPalSDKLoaded() {
    // Si déjà chargé, retourner immédiatement
    if (window.paypal && window.paypal.Buttons) {
      console.log('[PayPal SDK] Already loaded');
      return true;
    }

    // Si PayPalIntegration gère le chargement, attendre
    if (window.PayPalIntegration && typeof window.PayPalIntegration.ensureSDK === 'function') {
      console.log('[PayPal SDK] Loading via PayPalIntegration');
      try {
        await window.PayPalIntegration.ensureSDK();
        return true;
      } catch (e) {
        console.error('[PayPal SDK] Load failed:', e);
        throw e;
      }
    }

    // Fallback: attendre que window.paypal soit disponible (max 5s)
    console.log('[PayPal SDK] Waiting for window.paypal');
    const timeout = 5000;
    const start = Date.now();
    while (!window.paypal || !window.paypal.Buttons) {
      if (Date.now() - start > timeout) {
        throw new Error('PayPal SDK load timeout');
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return true;
  }

  // ========================================
  // 🆕 Afficher placeholder PayPal (spinner)
  // ========================================
function showPaypalPlaceholder() {
  if (confirmBtn) confirmBtn.style.display = 'none';
  
  const existing = document.getElementById('paypal-button-container');
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

  const container = document.createElement('div');
  container.id = 'paypal-button-container';
  container.className = 'loading';
  container.style.width = '100%';
container.style.marginTop = '16px';

  
  // Spinner réduit
  container.style.minHeight = '120px';
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.justifyContent = 'center';
  
  container.innerHTML = `
    <div style="text-align:center;">
      <div style="width:32px;height:32px;border:3px solid #f3f3f3;border-top:3px solid #0070ba;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 10px;"></div>
      <p style="color:#666;font-size:13px;margin:0;">Preparing payment...</p>
    </div>
  `;

  if (!document.getElementById('paypal-spinner-style')) {
    const style = document.createElement('style');
    style.id = 'paypal-spinner-style';
    style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
    document.head.appendChild(style);
  }

  // CORRECTION : Insérer dans le footer au lieu du form/modal
  /*const footer = modal?.querySelector('.footer') || document.querySelector('.modal .footer');
  if (footer) {
    footer.appendChild(container);
  } else {
    const target = form || modal;
    if (target) target.appendChild(container);
  }*/

  const body = modal?.querySelector('.body') || document.querySelector('.modal .body');
if (body) {
  body.appendChild(container);
} else {
  modal.appendChild(container);
}

  
  return container;
}

//new fonction resume
// Transformer le modal en mode "paiement" avec résumé
/*function switchToPaymentView() {
  const modalBody = modal?.querySelector('.body') || document.querySelector('.modal .body');
  if (!modalBody) return;

  // Récupérer les valeurs du formulaire
  const name = (nameInput?.value || '').trim();
  const linkUrl = (linkInput?.value || '').trim();
  const blocks = getSelectedIndices();
  const selectedPixels = blocks.length * 100;

  const paypalContainer = document.getElementById('paypal-button-container');

  // ⚙️ Si le container est encore dans le form, on le déplace avant de cacher le form
  if (paypalContainer && form && form.contains(paypalContainer)) {
    form.parentNode.appendChild(paypalContainer);
  }

  // Cacher le formulaire
  if (form) form.style.display = 'none';

  // Créer un résumé compact
  const summary = document.createElement('div');
  summary.id = 'order-summary';
  summary.style.cssText = 'padding:16px 20px;background:#f9fafb;border-radius:12px;margin-bottom:20px;';
  summary.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-weight:600;color:#374151;font-size:14px;">Your order</span>
      <button id="editOrder" style="background:none;border:none;color:#8b5cf6;font-size:13px;font-weight:600;cursor:pointer;padding:4px 8px;border-radius:6px;transition:all 0.2s;">Edit</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:#6b7280;">
      <div style="display:flex;justify-content:space-between;">
        <span>Pseudo:</span>
        <span style="font-weight:600;color:#111827;">${name}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span>Profile:</span>
        <span style="font-weight:600;color:#111827;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${linkUrl}">${linkUrl}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span>Pixels:</span>
        <span style="font-weight:600;color:#8b5cf6;">${selectedPixels} px</span>
      </div>
    </div>
  `;

  modalBody.insertBefore(summary, modalBody.firstChild);

  // Bouton "Edit" pour revenir au formulaire
  const editBtn = summary.querySelector('#editOrder');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      if (form) form.style.display = '';
      summary.remove();
      removePaypalContainer();
      btnBusy(false);
      if (confirmBtn) confirmBtn.style.display = '';
    });

    // Hover effect
    editBtn.addEventListener('mouseenter', () => {
      editBtn.style.background = '#f3f4f6';
    });
    editBtn.addEventListener('mouseleave', () => {
      editBtn.style.background = 'none';
    });
  }
  console.log('[switchToPaymentView] Payment view active');
}*/

function switchToPaymentView() {
  const panel = modal?.querySelector('.panel');
  const paypalContainer = document.getElementById('paypal-button-container');

  // Déplacer le container PayPal avant de cacher le form
  if (paypalContainer && form && form.contains(paypalContainer)) {
    form.parentNode.appendChild(paypalContainer);
  }

  // Cacher le formulaire
  if (form) form.style.display = 'none';

  // Créer le résumé
  const name = (nameInput?.value || '').trim();
  const linkUrl = (linkInput?.value || '').trim();
  const blocks = getSelectedIndices();
  const selectedPixels = blocks.length * 100;

  // Supprimer un ancien résumé s’il existe
  const oldSummary = document.getElementById('order-summary');
  if (oldSummary) oldSummary.remove();

  const summary = document.createElement('div');
  summary.id = 'order-summary';
  summary.style.cssText = `
    padding:16px 20px;
    background:#f9fafb;
    border-radius:12px;
    margin:16px auto;
    max-width:90%;
    font-size:13px;
  `;
  summary.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <span style="font-weight:600;color:#374151;font-size:14px;">Your order</span>
      <button id="editOrder" style="background:none;border:none;color:#8b5cf6;font-size:13px;font-weight:600;cursor:pointer;">Edit</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:6px;color:#6b7280;">
      <div style="display:flex;justify-content:space-between;">
        <span>Pseudo:</span>
        <span style="font-weight:600;color:#111827;">${name}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span>Profile:</span>
        <span style="font-weight:600;color:#111827;max-width:180px;overflow:hidden;text-overflow:ellipsis;" title="${linkUrl}">${linkUrl}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span>Pixels:</span>
        <span style="font-weight:600;color:#8b5cf6;">${selectedPixels} px</span>
      </div>
    </div>
  `;

  // ⚙️ → Insertion visible : juste au-dessus du container PayPal
  const target = paypalContainer?.parentNode || panel;
  target.insertBefore(summary, paypalContainer);

  // Bouton "Edit"
  const editBtn = summary.querySelector('#editOrder');
  if (editBtn) {
    editBtn.addEventListener('click', () => {
      summary.remove();
      if (form) form.style.display = '';
      removePaypalContainer();
      btnBusy(false);
      if (confirmBtn) confirmBtn.style.display = '';
    });
  }

  console.log('[switchToPaymentView] Summary added above PayPal container');
}


//new fonction resume
  // ========================================
  // 🆕 Rendre les boutons PayPal
  // ========================================
  function renderPaypalButtons(container, orderId, currency) {
    if (!container) {
      console.error('[PayPal] Container not found');
      return;
    }

    // Vider le spinner
    //container.innerHTML = '';
    //container.className = '';

    // Vider le spinner MAIS garder la structure pour le ::before
  container.innerHTML = '';
  // NE PAS supprimer toutes les classes, juste 'loading'
  container.classList.remove('loading');
  // CORRECTION : Ajouter la classe 'active' par défaut
  container.className = 'active';

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

      /*onCancel: async () => {
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
      }*/
     //new oncancel et onerror
    onCancel: async () => {
  if (window.stopModalMonitor) {
    window.stopModalMonitor();
  }
  
  // NE PAS désactiver les boutons
  // NE PAS arrêter le heartbeat (les locks sont encore valides)
  
  setPayPalHeaderState('cancelled'); // Message "Payment cancelled"
  btnBusy(false);
  
  // Redémarrer le monitoring pour vérifier l'expiration naturelle des locks
  if (window.startModalMonitor) {
    window.startModalMonitor(0);
  }
},

onError: async (err) => {
  // Arrêter le monitoring des locks
  if (window.stopModalMonitor) {
    window.stopModalMonitor();
  }
  uiError(err, 'PayPal');
  
  // Désactiver TOUT le container PayPal
  const container = document.getElementById('paypal-button-container');
  if (container) {
    container.style.pointerEvents = 'none';
    container.style.opacity = '0.5';
  }
  
  setPayPalHeaderState('error');
  try { window.LockManager?.heartbeat?.stop?.(); } catch {}
  try { await unlockSelection(); } catch {}
  btnBusy(false);
}
     //new oncancel et onerror

    });
    //new
    // 🔧 CORRECTION: Redémarrer le monitoring des locks après render PayPal
  if (typeof window.startModalMonitor === 'function') {
    window.startModalMonitor(0); // Démarrer immédiatement (pas de warmup)
  }
    //new
  }

  // ========================================
  // Fonctions utilitaires
  // ========================================
  function removePaypalContainer() {
    const container = document.getElementById('paypal-button-container');
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    if (confirmBtn) confirmBtn.style.display = '';
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
          console.log('[Finalize] order status', s);
        }
      } catch (e) {
        console.warn('[Finalize] order-status check failed', e);
      }
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(10000, Math.round(delay * 1.7));
    }
    return false;
  }

  // Écouteur d'événement de soumission
  document.addEventListener('finalize:submit', (e) => {
    try { e.preventDefault && e.preventDefault(); } catch {}
    doConfirm();
  });

  // Reset complet
  function resetModalState() {
    uploadedImageCache = null;
    
    if (fileInput) {
      fileInput.value = '';
      delete fileInput._cachedFile;
    }
    
    const progressIndicator = document.querySelector('.upload-progress-mini');
    if (progressIndicator) progressIndicator.remove();

    removePaypalContainer();
  }

  // Événements d'ouverture/fermeture du modal
  document.addEventListener('modal:opening', () => {
    resetModalState();
  });

  document.addEventListener('modal:closing', () => {
    resetModalState();
  });

  //new

  //new
  console.log('[Finalize] Parallel optimization loaded - PayPal SDK + start-order in parallel');
})();