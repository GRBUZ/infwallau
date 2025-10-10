// paypal-integration-refactored.js - Version adaptée pour l'architecture sans modal
(function (w) {
  'use strict';

  let sdkPromise = null;
  let sdkLoadedClientId = null;

  // Fonction pour charger le SDK PayPal
  function ensureSDK(clientId = null, currency = 'USD') {
    // Si le SDK est déjà chargé avec le bon clientId
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
    // Si déjà chargé avec le même clientId
    if (w.paypal && sdkLoadedClientId === clientId) {
      return Promise.resolve();
    }

    // Si un chargement est en cours
    if (sdkPromise) {
      return sdkPromise;
    }

    console.log('[PayPal SDK] Loading...');

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

  // Récupère le token JWT pour l'authentification
  function getAuthToken() {
    try {
      if (typeof w.CoreManager?.getToken === 'function') {
        return w.CoreManager.getToken() || '';
      }
      if (w.auth && w.auth.token) return w.auth.token;
      return localStorage.getItem('jwt') || localStorage.getItem('token') || '';
    } catch (_) { 
      return ''; 
    }
  }

  // Fonction principale pour initialiser et rendre les boutons PayPal
  async function initAndRender({ orderId, currency = 'USD', onApproved, onCancel, onError } = {}) {
    try {
      const clientId = w.PAYPAL_CLIENT_ID;
      if (!clientId) throw new Error('MISSING_PAYPAL_CLIENT_ID');
      if (!orderId) throw new Error('MISSING_ORDER_ID');

      console.log('[PayPal] Initializing buttons for order:', orderId);

      // Charger le SDK si nécessaire
      await loadPayPalSdk(clientId, currency);

      const containerId = 'paypal-button-container';
      let container = document.getElementById(containerId);
      
      if (!container) {
        console.error('[PayPal] Container not found');
        throw new Error('PAYPAL_CONTAINER_NOT_FOUND');
      }

      // Clear any existing content
      container.innerHTML = '';

      // Fonction pour créer l'ordre PayPal
      const createOrder = async () => {
        console.log('[PayPal] Creating PayPal order for orderId:', orderId);
        
        const body = JSON.stringify({ orderId, currency });
        
        try {
          let response;
          
          // Utiliser CoreManager si disponible
          if (w.CoreManager?.apiCall) {
            response = await w.CoreManager.apiCall('/paypal-create-order', {
              method: 'POST',
              body
            });
          } else {
            // Fallback: fetch direct
            const headers = { 'Content-Type': 'application/json' };
            const token = getAuthToken();
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const resp = await fetch('/.netlify/functions/paypal-create-order', {
              method: 'POST',
              headers,
              body,
              credentials: 'same-origin'
            });

            response = await resp.json();
          }

          const paypalId = response?.id || response?.paypalOrderId;
          if (!paypalId) {
            throw new Error(response?.error || 'PAYPAL_CREATE_FAILED');
          }
          
          console.log('[PayPal] PayPal order created:', paypalId);
          return paypalId;

        } catch (e) {
          console.error('[PayPal] createOrder failed:', e);
          onError?.(e);
          throw e;
        }
      };

      // Fonction appelée après approbation du paiement
      const onApprove = async (data, actions) => {
        try {
          console.log('[PayPal] Payment approved, paypalOrderId:', data.orderID);
          
          if (typeof onApproved === 'function') {
            await onApproved(data, actions);
          } else {
            console.log('[PayPal] No custom onApproved handler provided');
          }
        } catch (e) {
          console.error('[PayPal] onApprove failed:', e);
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

      // Vérifier que PayPal SDK est disponible
      if (!w.paypal || !w.paypal.Buttons) {
        throw new Error('PAYPAL_SDK_NOT_LOADED');
      }

      console.log('[PayPal] Rendering buttons');

      // Rendu des boutons PayPal
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
      console.error('[PayPal] initAndRender failed:', err);
      onError?.(err);
      throw err;
    }
  }

  // Exposer les fonctions publiques
  w.PayPalIntegration = { 
    initAndRender,
    ensureSDK,
    isSDKLoaded: () => !!(w.paypal && w.paypal.Buttons)
  };

  console.log('[PayPalIntegration] Module loaded');

})(window);