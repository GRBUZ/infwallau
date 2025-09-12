// /js/paypal-integration.js
(function (w) {
  'use strict';

  let sdkPromise = null;

  function loadPayPalSdk(clientId, currency) {
    if (w.paypal) return Promise.resolve();
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        // intent=capture pour Checkout (Orders v2)
        s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('PAYPAL_SDK_LOAD_FAILED'));
        document.head.appendChild(s);
      });
    }
    return sdkPromise;
  }

  // Appelle une Netlify Function en s'adaptant à l'environnement :
  // - si w.apiCall ou w.CoreManager.apiCall existent, on les utilise (souvent ils gèrent l'auth)
  // - sinon, fallback fetch direct vers /.netlify/functions/<name>
  async function callFunction(name, { method = 'GET', body } = {}) {
    // payload pour les wrappers éventuels
    const payload = {
      method,
      // si le wrapper attend une string, laissons-le gérer;
      // sinon on passe un objet (on gère dans fetch fallback ci-dessous)
      body
    };

    try {
      if (typeof w.apiCall === 'function') {
        // Beaucoup de wrappers mappent "/xxx" -> "/.netlify/functions/xxx"
        return await w.apiCall(`/${name}`, payload);
      }
      if (w.CoreManager?.apiCall) {
        return await w.CoreManager.apiCall(`/${name}`, payload);
      }
    } catch (e) {
      // Si le wrapper existe mais échoue avec un network error, on essaie le fallback
      console.warn('[PayPalIntegration] wrapper apiCall failed, fallback to fetch', e);
    }

    // Fallback: fetch direct
    const headers = { 'Content-Type': 'application/json' };
    // On essaie de récupérer un token si dispo (optionnel)
    const token =
      (w.CoreManager?.getToken?.()) ||
      (w.auth && w.auth.token) ||
      (function () {
        try {
          return localStorage.getItem('jwt') || localStorage.getItem('token') || '';
        } catch (_) { return ''; }
      })();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const resp = await fetch(`/.netlify/functions/${name}`, {
      method,
      headers,
      body: body && (typeof body === 'string' ? body : JSON.stringify(body))
    });

    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(json?.error || json?.message || `FUNCTION_${name.toUpperCase()}_FAILED`);
      err.response = resp;
      err.body = json;
      throw err;
    }
    return json;
  }

  async function initAndRender({
    orderId,
    currency = 'USD',
    onApproved, // callback métier côté app
    onCancel,
    onError
  } = {}) {
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

      // Création d’ordre PayPal côté serveur (montant calculé côté serveur)
      const createOrder = async () => {
        try {
          const res = await callFunction('paypal-create-order', {
            method: 'POST',
            body: { orderId, currency }
          });
          if (!res?.id) throw new Error('PAYPAL_CREATE_FAILED');
          return res.id; // renvoyer l'orderID PayPal au SDK
        } catch (e) {
          onError?.(e);
          throw e;
        }
      };

      // IMPORTANT : ne pas capturer côté client.
      // On laisse le serveur faire la capture + finalisation atomique.
      const onApprove = async (data, actions) => {
        try {
          if (typeof onApproved === 'function') {
            // on passe le même "data" que PayPal (contient orderID)
            await onApproved(data, actions);
          } else {
            // Fallback : finaliser côté serveur si l'app n'a pas fourni de callback
            const r = await callFunction('paypal-capture-finalize', {
              method: 'POST',
              body: { orderId, paypalOrderId: data?.orderID }
            });
            if (!r?.ok) throw new Error(r?.error || 'FINALIZE_FAILED');
          }
        } catch (e) {
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

  // Expose global
  w.PayPalIntegration = { initAndRender };
})(window);
