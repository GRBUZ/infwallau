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

  // Récupère un éventuel JWT pour le fallback fetch
  function getAuthToken() {
    try {
      if (typeof w.CoreManager?.getToken === 'function') return w.CoreManager.getToken() || '';
      if (w.auth && w.auth.token) return w.auth.token;
      return localStorage.getItem('jwt') || localStorage.getItem('token') || '';
    } catch (_) { return ''; }
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

      // --- Création d’ordre côté serveur (montant calculé serveur) ---
      const createOrder = async () => {
        try {
          // 1) Si ton wrapper existe, on l’utilise (et on STRINGIFIE le body)
          if (w.CoreManager?.apiCall) {
            const res = await w.CoreManager.apiCall('/paypal-create-order', {
              method: 'POST',
              body: JSON.stringify({ orderId, currency })
            });
            // Certains wrappers renvoient un Response, on gère les deux cas :
            const data = (res && typeof res.json === 'function') ? await res.json() : res;
            if (!data?.id) throw new Error(data?.error || 'PAYPAL_CREATE_FAILED');
            return data.id;
          }

          // 2) Fallback: fetch direct Netlify
          const headers = { 'Content-Type': 'application/json' };
          const token = getAuthToken();
          if (token) headers['Authorization'] = `Bearer ${token}`;

          const resp = await fetch('/.netlify/functions/paypal-create-order', {
            method: 'POST',
            headers,
            body: JSON.stringify({ orderId, currency })
          });
          const j = await resp.json().catch(() => ({}));
          if (!resp.ok || !j?.id) throw new Error(j?.error || 'PAYPAL_CREATE_FAILED');
          return j.id;
        } catch (e) {
          console.error('[PayPalIntegration] createOrder failed:', e);
          onError?.(e);
          throw e;
        }
      };

      // --- Ne PAS capturer côté client : la capture + finalisation est côté serveur ---
      const onApprove = async (data, actions) => {
        try {
          if (typeof onApproved === 'function') {
            // On te refile le data PayPal complet (tu lis data.orderID)
            await onApproved(data, actions);
          } else {
            // Fallback : finaliser côté serveur si aucun callback fourni
            const headers = { 'Content-Type': 'application/json' };
            const token = getAuthToken();
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const resp = await fetch('/.netlify/functions/paypal-capture-finalize', {
              method: 'POST',
              headers,
              body: JSON.stringify({ orderId, paypalOrderId: data?.orderID })
            });
            const j = await resp.json().catch(() => ({}));
            if (!resp.ok || !j?.ok) throw new Error(j?.error || j?.message || 'FINALIZE_FAILED');
          }
        } catch (e) {
          console.error('[PayPalIntegration] onApprove failed:', e);
          onError?.(e);
          throw e;
        }
      };

      const onCancelCb = () => onCancel?.();
      const onErrorCb  = (err) => onError?.(err);

      w.paypal.Buttons({
        style: { layout: 'vertical' },
        createOrder,
        onApprove,
        onCancel: onCancelCb,
        onError: onErrorCb
      }).render('#' + containerId);
    } catch (err) {
      onError?.(err);
      throw err;
    }
  }

  w.PayPalIntegration = { initAndRender };
})(window);
