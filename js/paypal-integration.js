// /js/paypal-integration.js
(function (w) {
  'use strict';

  let sdkPromise = null;

  function loadPayPalSdk(clientId, currency) {
    if (w.paypal) return Promise.resolve();
    if (!sdkPromise) {
      sdkPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        // Pas de query volumineuse ici non plus
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

  // Petit util pour convertir une éventuelle réponse HTML (ex: 414) en erreur lisible
  async function readJsonSafe(resp) {
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { return { ok: false, error: 'SERVER_HTML_ERROR', message: text.slice(0, 4000) }; }
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
      } else {
        // évite les double-renders si on relance initAndRender
        container.innerHTML = '';
      }

      // --- Création d’ordre côté serveur (montant calculé serveur) ---
      const createOrder = async () => {
        // On n’envoie QUE { orderId, currency } dans le body → anti-414
        const body = JSON.stringify({ orderId, currency });

        try {
          // 1) Si ton wrapper existe, on l’utilise (et on STRINGIFIE le body)
          if (w.CoreManager?.apiCall) {
            const res = await w.CoreManager.apiCall('/paypal-create-order', {
              method: 'POST',
              body
            });

            // Certains wrappers renvoient un Response, on gère les deux cas :
            const data = (res && typeof res.json === 'function') ? await res.json() : res;

            // Accepte { id } ou { ok:true, id }
            const paypalId = data?.id || data?.paypalOrderId;
            if (!paypalId) {
              const errCode = data?.error || 'PAYPAL_CREATE_FAILED';
              throw new Error(errCode);
            }
            return paypalId;
          }

          // 2) Fallback: fetch direct Netlify
          const headers = { 'Content-Type': 'application/json' };
          const token = getAuthToken();
          if (token) headers['Authorization'] = `Bearer ${token}`;

          const resp = await fetch('/.netlify/functions/paypal-create-order', {
            method: 'POST',
            headers,
            body,
            // pas de cache, pas de querystring
            credentials: 'same-origin'
          });

          const j = await readJsonSafe(resp);

          // Si Cloudflare renvoie une page HTML 414, on remonte une erreur claire
          if (j?.message && typeof j.message === 'string' && j.message.includes('414')) {
            const e = new Error('REQUEST_URI_TOO_LARGE');
            e.code = '414';
            e.details = j.message;
            throw e;
          }

          if (!resp.ok) {
            const e = new Error(j?.error || j?.message || 'PAYPAL_CREATE_FAILED');
            e.details = j;
            throw e;
          }

          const paypalId = j?.id || j?.paypalOrderId;
          if (!paypalId) throw new Error('PAYPAL_CREATE_FAILED');
          return paypalId;

        } catch (e) {
          console.error('[PayPalIntegration] createOrder failed:', e);
          onError?.(e);
          // Rejeter pour que le SDK arrête le flow proprement
          throw e;
        }
      };

      // --- Ne PAS capturer côté client : capture + finalisation côté serveur ---
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
              body: JSON.stringify({ orderId, paypalOrderId: data?.orderID }),
              credentials: 'same-origin'
            });
            const j = await readJsonSafe(resp);
            if (!resp.ok || !j?.ok) {
              const e = new Error(j?.error || j?.message || 'FINALIZE_FAILED');
              e.details = j;
              throw e;
            }
          }
        } catch (e) {
          console.error('[PayPalIntegration] onApprove failed:', e);
          onError?.(e);
          throw e;
        }
      };

      const onCancelCb = () => onCancel?.();
      const onErrorCb  = (err) => onError?.(err);
      
      // Rendu des boutons
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
