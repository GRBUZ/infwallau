// finalize-addon.js – version simplifiée pour option 2 (formulaire + PayPal visibles directement)
(function(){
  'use strict';

  if (!window.CoreManager || !window.UploadManager) {
    console.error('[finalize] Missing dependencies');
    return;
  }

  const { apiCall, uid } = window.CoreManager;
  const modal = document.getElementById('modal');
  const form = document.getElementById('form');
  const nameInput = document.getElementById('name');
  const linkInput = document.getElementById('link');
  const fileInput = document.getElementById('image');
  const paypalContainer = document.getElementById('paypal-button-container');

  let uploadedImageCache = null;
  let paypalReady = false;
  let orderInProgress = false;

  // ======================================================
  // UTILITAIRES UI
  // ======================================================
  const uiWarn = msg => window.Errors?.showToast ? window.Errors.showToast(msg, 'warn', 3000) : alert(msg);
  const uiError = (err, ctx) => {
    console.error(`[${ctx || 'Error'}]`, err);
    if (window.Errors?.notifyError) window.Errors.notifyError(err, ctx);
  };

  const normalizeUrl = u => {
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { const url = new URL(u); url.hash = ''; return url.toString(); }
    catch { return ''; }
  };

  function getSelectedIndices(){
    if (typeof window.getSelectedIndices === 'function') return window.getSelectedIndices() || [];
    const out = [];
    document.querySelectorAll('.cell.sel').forEach(el=>{
      const idx = parseInt(el.dataset.idx, 10);
      if (Number.isInteger(idx)) out.push(idx);
    });
    return out;
  }

  // ======================================================
  // IMAGE UPLOAD (inchangée sauf intégration simplifiée)
  // ======================================================
  if (fileInput) {
    fileInput.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) { uploadedImageCache = null; return; }

      const progress = document.createElement('div');
      progress.textContent = 'Uploading…';
      progress.style = 'color:#0070ba;font-size:13px;margin-top:6px;';
      fileInput.insertAdjacentElement('afterend', progress);

      try {
        await window.UploadManager.validateFile(file);
        const res = await window.UploadManager.uploadForRegion(file, 'direct-' + Date.now());
        if (!res?.ok) throw new Error(res.error || 'Upload failed');
        uploadedImageCache = { imageUrl: res.imageUrl, regionId: res.regionId, uploadedAt: Date.now() };
        progress.textContent = '✓ Image ready';
        progress.style.color = '#10b981';
      } catch (err) {
        uploadedImageCache = null;
        progress.textContent = '✗ Upload failed';
        progress.style.color = '#ef4444';
        uiError(err, 'Upload');
      }
      checkFormReady();
    });
  }

  // ======================================================
  // VALIDATION DU FORMULAIRE
  // ======================================================
  function isFormValid() {
    const name = (nameInput?.value || '').trim();
    const link = normalizeUrl(linkInput?.value);
    const blocks = getSelectedIndices();
    return !!(name && link && uploadedImageCache && blocks.length);
  }

  /*function checkFormReady() {
  const ready = isFormValid();
  if (!paypalContainer) return;

  const btns = paypalContainer.querySelectorAll('button');
  if (!btns || !btns.length) {
    // Retry un peu plus tard car PayPal peut injecter ses boutons avec un léger délai
    setTimeout(checkFormReady, 500);
    return;
  }

  btns.forEach(b => {
    try {
      b.disabled = !ready;
      b.style.opacity = ready ? '' : '0.5';
      b.style.pointerEvents = ready ? '' : 'none';
    } catch {}
  });
}*/
function checkFormReady() {
  const ready = isFormValid();
  const container = document.getElementById('paypal-button-container');
  if (!container) return; // ✅ éviter l’erreur si le container n’est pas encore rendu
  const btns = container.querySelectorAll('button');
  btns.forEach(b => b.disabled = !ready);
}


  form?.addEventListener('input', checkFormReady);

  // ======================================================
  // PAYPAL INITIALISATION
  // ======================================================
  async function ensurePayPalLoaded() {
    if (window.paypal?.Buttons) return true;
    if (window.PayPalIntegration?.ensureSDK) {
      await window.PayPalIntegration.ensureSDK();
      return true;
    }
    throw new Error('PayPal SDK not loaded');
  }

  async function renderPayPal() {
    if (paypalReady || !paypalContainer) return;
    await ensurePayPalLoaded();
    paypalReady = true;

    window.PayPalIntegration.initAndRender({
      container: paypalContainer,
      orderBuilder: async () => {
        if (!isFormValid()) throw new Error('Please complete the form first.');
        if (orderInProgress) throw new Error('Order already in progress.');
        orderInProgress = true;

        const name = nameInput.value.trim();
        const linkUrl = normalizeUrl(linkInput.value);
        const blocks = getSelectedIndices();
        const img = uploadedImageCache;

        const res = await apiCall('/start-order', {
          method: 'POST',
          body: JSON.stringify({
            name, linkUrl, blocks,
            imageUrl: img.imageUrl,
            regionId: img.regionId
          })
        });

        if (!res?.ok) throw new Error(res.error || 'Failed to start order');
        return res.orderId;
      },
      onApproved: async (data) => {
        try {
          await apiCall('/paypal-capture-finalize', {
            method: 'POST',
            body: JSON.stringify({ orderId: data.orderId, paypalOrderId: data.orderID })
          });
          uiWarn('✅ Payment completed!');
          modal.classList.add('hidden');
          await window.CoreManager.apiCall('/status?refresh=1');
        } catch (e) {
          uiError(e, 'Finalize');
        } finally {
          orderInProgress = false;
        }
      },
      onError: (err) => {
        orderInProgress = false;
        uiError(err, 'PayPal');
      },
      onCancel: () => {
        orderInProgress = false;
        uiWarn('Payment cancelled.');
      }
    });
    setTimeout(checkFormReady, 1000);
  }

  // ======================================================
  // MODAL EVENTS
  // ======================================================
  document.addEventListener('modal:opening', async () => {
    uploadedImageCache = null;
    orderInProgress = false;
    paypalReady = false;
    await renderPayPal();
    checkFormReady();
  });

  console.log('[Finalize] Option 2: inline PayPal active');
})();
