// /js/paypal-integration.js
(function (w) {
  'use strict';

  let sdkPromise = null;

  function loadPayPalSdk(clientId, currency) {
    if (w.paypal) return Promise.resolve();
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('PAYPAL_SDK_LOAD_FAILED'));
        document.head.appendChild(s);
      });
    }
    return sdkPromise;
  }

  async function initAndRender({ orderId, currency = 'USD', onApproved, onCancel, onError } = {}) {
    try {
      const clientId = w.PAYPAL_CLIENT_ID;
      if (!clientId) throw new Error('MISSING_PAYPAL_CLIENT_ID');
      if (!orderId) throw new Error('MISSING_ORDER_ID');

      await loadPayPalSdk(clientId, currency);

      const containerId = 'paypal-button-container';
      let container = document.getElementById(containerId);
      if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        const confirmBtn = document.getElementById('confirm');
        confirmBtn?.insertAdjacentElement('afterend', container);
      }

      const createOrder = async () => {
        // Appel serveur => /paypal-create-order (montant calculé côté serveur)
        try {
          if (w.CoreManager?.apiCall) {
            const r = await w.CoreManager.apiCall('/paypal-create-order', {
              method: 'POST',
              body: JSON.stringify({ orderId })
            });
            if (!r?.id) throw new Error('PAYPAL_CREATE_FAILED');
            return r.id;
          }
          // Fallback si CoreManager.apiCall indisponible
          const resp = await fetch('/.netlify/functions/paypal-create-order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId })
          });
          const j = await resp.json().catch(() => ({}));
          if (!resp.ok || !j?.id) throw new Error(j?.error || 'PAYPAL_CREATE_FAILED');
          return j.id;
        } catch (e) {
          onError?.(e);
          throw e;
        }
      };

      const onApprove = async (data, actions) => {
        try {
          await actions.order.capture(); // webhook PAYMENT.CAPTURE.COMPLETED sera envoyé au backend
          onApproved?.(data?.orderID);
        } catch (e) {
          onError?.(e);
        }
      };

      const onCancelCb = () => onCancel?.();
      const onErrorCb  = (err) => onError?.(err);

      w.paypal.Buttons({ createOrder, onApprove, onCancel: onCancelCb, onError: onErrorCb })
        .render('#' + containerId);
    } catch (err) {
      onError?.(err);
      throw err;
    }
  }

  // Expose global
  w.PayPalIntegration = { initAndRender };
})(window);
