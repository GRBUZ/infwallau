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

  // Convertit une éventuelle réponse HTML (ex: 414) en JSON lisible
  async function readJsonSafe(resp) {
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { return { ok: false, error: 'SERVER_HTML_ERROR', message: text.slice(0, 4000) }; }
  }

  // --- injecte une micro feuille de style (une seule fois) ---
  function ensureStyles() {
    if (document.getElementById('pp-inline-style')) return;
    const css = `
      .pp-wrap{border:1px solid #e9ecef;border-radius:12px;padding:12px 14px;background:#fafafa}
      .pp-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
      .pp-title{font-weight:600;font-size:14px}
      .pp-cancel{all:unset;cursor:pointer;padding:6px 10px;border:1px solid #d0d7de;border-radius:8px;font-size:12px;line-height:1;background:#fff}
      .pp-cancel:hover{background:#f6f8fa}
      #paypal-button-container{max-width:360px}
    `;
    const style = document.createElement('style');
    style.id = 'pp-inline-style';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  async function initAndRender({ orderId, currency = 'USD', onApproved, onCancel, onError } = {}) {
    try {
      const clientId = w.PAYPAL_CLIENT_ID;
      if (!clientId) throw new Error('MISSING_PAYPAL_CLIENT_ID');
      if (!orderId) throw new Error('MISSING_ORDER_ID');

      await loadPayPalSdk(clientId, currency);
      ensureStyles();

      // === Container PayPal (réutilisé) ===
      const containerId = 'paypal-button-container';
      let container = document.getElementById(containerId);
      if (!container) {
        container = document.createElement('div');
        container.id = containerId;
        const confirmBtn = document.getElementById('confirm');
        confirmBtn?.insertAdjacentElement('afterend', container);
      }

      // === Wrapper « joli » avec titre + petit Cancel ===
      const wrapId = 'paypal-wrap';
      let wrap = document.getElementById(wrapId);
      if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = wrapId;
        wrap.className = 'pp-wrap';
        wrap.innerHTML = `
          <div class="pp-header">
            <div class="pp-title">Choose your payment method</div>
            <button type="button" class="pp-cancel" id="pp-cancel-btn">Cancel</button>
          </div>
          <div class="pp-body"></div>
        `;
        // insérer le wrapper juste avant le container actuel puis y déplacer le container
        container.parentNode.insertBefore(wrap, container);
        wrap.querySelector('.pp-body').appendChild(container);

        // petit bouton Cancel
        wrap.querySelector('#pp-cancel-btn')?.addEventListener('click', () => {
          try { onCancel?.(); } catch (_) {}
        });
      } else {
        // si le wrapper existe déjà, s'assurer que le container est bien dedans
        const body = wrap.querySelector('.pp-body');
        if (body && container.parentElement !== body) {
          body.appendChild(container);
        }
      }

      // éviter un double-render PayPal
      container.innerHTML = '';

      // --- Création d’ordre côté serveur (montant calculé serveur) ---
      const createOrder = async () => {
        const body = JSON.stringify({ orderId, currency });
        try {
          if (w.CoreManager?.apiCall) {
            const res = await w.CoreManager.apiCall('/paypal-create-order', {
              method: 'POST',
              body
            });
            const data = (res && typeof res.json === 'function') ? await res.json() : res;
            const paypalId = data?.id || data?.paypalOrderId;
            if (!paypalId) throw new Error(data?.error || 'PAYPAL_CREATE_FAILED');
            return paypalId;
          }

          const headers = { 'Content-Type': 'application/json' };
          const token = getAuthToken();
          if (token) headers['Authorization'] = `Bearer ${token}`;

          const resp = await fetch('/.netlify/functions/paypal-create-order', {
            method: 'POST',
            headers,
            body,
            credentials: 'same-origin'
          });

          const j = await readJsonSafe(resp);
          if (j?.message && typeof j.message === 'string' && j.message.includes('414')) {
            const e = new Error('REQUEST_URI_TOO_LARGE');
            e.code = '414'; e.details = j.message;
            throw e;
          }
          if (!resp.ok) {
            const e = new Error(j?.error || j?.message || 'PAYPAL_CREATE_FAILED');
            e.details = j; throw e;
          }

          const paypalId = j?.id || j?.paypalOrderId;
          if (!paypalId) throw new Error('PAYPAL_CREATE_FAILED');
          return paypalId;

        } catch (e) {
          console.error('[PayPalIntegration] createOrder failed:', e);
          onError?.(e);
          throw e;
        }
      };

      // --- Ne PAS capturer côté client : capture + finalisation côté serveur ---
      const onApprove = async (data, actions) => {
        try {
          if (typeof onApproved === 'function') {
            await onApproved(data, actions);
          } else {
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
              e.details = j; throw e;
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

      // --- Rendu des boutons PayPal dans le MÊME container (maintenant dans le wrapper) ---
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
