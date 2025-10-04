// /js/paypal-integration.js — Option 2 compatible avec orderBuilder (inline PayPal)
(function (w) {
  'use strict';

  let sdkPromise = null;
  let sdkLoadedClientId = null;

  // ======================================================
  // SDK LOADING
  // ======================================================
  function ensureSDK(clientId = null, currency = 'USD') {
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
    if (w.paypal && sdkLoadedClientId === clientId) return Promise.resolve();
    if (sdkPromise) return sdkPromise;

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

  // ======================================================
  // UTILS
  // ======================================================
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

  // ======================================================
  // MAIN ENTRYPOINT
  // ======================================================
  async function initAndRender({
    container,
    orderId,
    orderBuilder,
    currency = 'USD',
    onApproved,
    onCancel,
    onError
  } = {}) {
    try {
      const clientId = w.PAYPAL_CLIENT_ID;
      if (!clientId) throw new Error('MISSING_PAYPAL_CLIENT_ID');
      await loadPayPalSdk(clientId, currency);

      // --- Dynamic order creation (Option 2)
      const createOrder = async () => {
        try {
          if (typeof orderBuilder === 'function') {
            const id = await orderBuilder();
            if (!id) throw new Error('ORDER_BUILDER_RETURNED_NULL');
            console.log('[PayPalIntegration] Dynamic order created:', id);
            return id;
          }
          if (!orderId) throw new Error('MISSING_ORDER_ID');
          return orderId;
        } catch (e) {
          console.error('[PayPalIntegration] createOrder failed:', e);
          onError?.(e);
          throw e;
        }
      };

      // --- Find or create container ---
      const containerId = container?.id || 'paypal-button-container';
      let containerEl = container || document.getElementById(containerId);
      if (!containerEl) {
        console.warn('[PayPal] Expected #paypal-button-container, creating one');
        containerEl = document.createElement('div');
        containerEl.id = containerId;
        document.body.appendChild(containerEl);
      } else {
        containerEl.innerHTML = '';
      }

      if (!w.paypal || !w.paypal.Buttons) {
        throw new Error('PAYPAL_SDK_NOT_LOADED');
      }

      console.log('[PayPal] Rendering buttons...');

      w.paypal.Buttons({
        style: {
          layout: 'vertical',
          color: 'gold',
          shape: 'rect',
          label: 'paypal'
        },
        createOrder,
        onApprove: async (data, actions) => {
          try {
            console.log('[PayPal] Payment approved:', data);
            if (typeof onApproved === 'function') await onApproved(data, actions);
          } catch (e) {
            onError?.(e);
          }
        },
        onCancel: () => {
          console.log('[PayPal] Payment cancelled');
          onCancel?.();
        },
        onError: (err) => {
          console.error('[PayPal] Payment error:', err);
          onError?.(err);
        }
      }).render('#' + containerId);

      console.log('[PayPalIntegration] Buttons rendered successfully');
    } catch (err) {
      console.error('[PayPalIntegration] initAndRender failed:', err);
      onError?.(err);
      throw err;
    }
  }

  // ======================================================
  // EXPORTS
  // ======================================================
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

  console.log('[PayPalIntegration] Module ready (Option 2 patched)');
})(window);
