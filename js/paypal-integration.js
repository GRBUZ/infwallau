// /js/paypal-integration.js — Optimized for Option 2 (inline PayPal in modal)
(function (w) {
  'use strict';

  let sdkPromise = null;
  let sdkLoadedClientId = null;

  // 🚀 NOUVEAU : préchargement parallèle du SDK PayPal
  function ensureSDK(clientId = null, currency = 'USD') {
    // Si déjà chargé avec le bon clientId → retour immédiat
    if (w.paypal && w.paypal.Buttons) {
      const cid = clientId || w.PAYPAL_CLIENT_ID;
      if (!sdkLoadedClientId || sdkLoadedClientId === cid) {
        return Promise.resolve();
      }
    }

    const finalClientId = clientId || w.PAYPAL_CLIENT_ID;
    if (!finalClientId) {
      return Promise.reject(new Error('MISSING_PAYPAL_CLIENT_ID'));
    }

    return loadPayPalSdk(finalClientId, currency);
  }

  function loadPayPalSdk(clientId, currency = 'USD') {
    // Si déjà chargé → pas besoin de recharger
    if (w.paypal && sdkLoadedClientId === clientId) {
      return Promise.resolve();
    }

    // Si un chargement est déjà en cours → réutiliser la promesse
    if (sdkPromise) {
      return sdkPromise;
    }

    console.log('[PayPal SDK] Loading with clientId:', clientId.slice(0, 10) + '...');

    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture`;

      s.onload = () => {
        sdkLoadedClientId = clientId;
        console.log('[PayPal SDK] Loaded successfully');
        resolve();
      };

      s.onerror = () => {
        sdkPromise = null;
        const err = new Error('PAYPAL_SDK_LOAD_FAILED');
        console.error('[PayPal SDK] Load failed');
        reject(err);
      };

      document.head.appendChild(s);
    });

    return sdkPromise;
  }

  // --- Récupération du token pour les appels directs
  function getAuthToken() {
    try {
      if (typeof w.CoreManager?.getToken === 'function') return w.CoreManager.getToken() || '';
      if (w.auth && w.auth.token) return w.auth.token;
      return localStorage.getItem('jwt') || localStorage.getItem('token') || '';
    } catch (_) {
      return '';
    }
  }

  async function readJsonSafe(resp) {
    const text = await resp.text();
    try { return JSON.parse(text); }
    catch { return { ok: false, error: 'SERVER_HTML_ERROR', message: text.slice(0, 4000) }; }
  }

  // --- Initialisation et rendu des boutons PayPal ---
  async function initAndRender({ orderId, currency = 'USD', onApproved, onCancel, onError } = {}) {
    try {
      const clientId = w.PAYPAL_CLIENT_ID;
      if (!clientId) throw new Error('MISSING_PAYPAL_CLIENT_ID');
      if (!orderId) throw new Error('MISSING_ORDER_ID');

      console.log('[PayPal] Initializing buttons for order:', orderId);
      await loadPayPalSdk(clientId, currency);

      const containerId = 'paypal-button-container';
      const container = document.getElementById(containerId);

      // ⚠️ OPTION 2 : le conteneur existe déjà dans le modal
      if (!container) {
        console.warn('[PayPal] Expected existing #paypal-button-container');
        return;
      }
      container.innerHTML = '';

      // --- Création d’ordre côté serveur ---
      const createOrder = async () => {
        console.log('[PayPal] Creating PayPal order for orderId:', orderId);
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
            console.log('[PayPal] PayPal order created:', paypalId);
            return paypalId;
          }

          // Fallback : requête directe
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
          if (!resp.ok) throw new Error(j?.error || j?.message || 'PAYPAL_CREATE_FAILED');
          const paypalId = j?.id || j?.paypalOrderId;
          if (!paypalId) throw new Error('PAYPAL_CREATE_FAILED');

          console.log('[PayPal] PayPal order created:', paypalId);
          return paypalId;

        } catch (e) {
          console.error('[PayPalIntegration] createOrder failed:', e);
          onError?.(e);
          throw e;
        }
      };

      // --- Capture après validation ---
      const onApprove = async (data, actions) => {
        try {
          console.log('[PayPal] Payment approved, paypalOrderId:', data.orderID);

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
            if (!resp.ok || !j?.ok) throw new Error(j?.error || 'FINALIZE_FAILED');

            console.log('[PayPal] Finalization completed successfully');
          }
        } catch (e) {
          console.error('[PayPalIntegration] onApprove failed:', e);
          onError?.(e);
          throw e;
        }
      };

      const onCancelCb = () => {
        console.log('[PayPal] Payment cancelled by user');
        onCancel?.();
      };

      const onErrorCb = (err) => {
        console.error('[PayPal] Payment error:', err);
        onError?.(err);
      };

      if (!w.paypal || !w.paypal.Buttons) {
        throw new Error('PAYPAL_SDK_NOT_LOADED');
      }

      console.log('[PayPal] Rendering buttons');

      w.paypal.Buttons({
        style: {
          layout: 'vertical',
          color: 'gold',
          shape: 'rect',
          label: 'paypal'
        },
        createOrder,
        onApprove,
        onCancel: onCancelCb,
        onError: onErrorCb
      }).render('#' + containerId);

      console.log('[PayPal] Buttons rendered successfully');

    } catch (err) {
      console.error('[PayPalIntegration] initAndRender failed:', err);
      onError?.(err);
      throw err;
    }
  }

  // --- Helper global : activer / désactiver le conteneur PayPal ---
  w.PayPalIntegration = {
    initAndRender,
    ensureSDK,
    isSDKLoaded: () => !!(w.paypal && w.paypal.Buttons),
    setEnabled(enabled) {
      const c = document.getElementById('paypal-button-container');
      if (!c) return;
      c.style.pointerEvents = enabled ? '' : 'none';
      c.style.opacity = enabled ? '' : '0.5';
      c.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    }
  };

  console.log('[PayPalIntegration] Module ready (Option 2 optimized)');

})(window);
