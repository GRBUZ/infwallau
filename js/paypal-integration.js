// /js/paypal-integration.js - Optimized with parallel SDK loading
(function (w) {
  'use strict';

  let sdkPromise = null;
  let sdkLoadedClientId = null;

  // 🚀 NOUVEAU: Fonction exposée pour pre-loading du SDK
  function ensureSDK(clientId = null, currency = 'USD') {
    // Si le SDK est déjà chargé avec le bon clientId, retourner immédiatement
    if (w.paypal && w.paypal.Buttons) {
      const cid = clientId || w.PAYPAL_CLIENT_ID;
      if (!sdkLoadedClientId || sdkLoadedClientId === cid) {
        return Promise.resolve();
      }
    }

    // Utiliser le clientId global si non fourni
    const finalClientId = clientId || w.PAYPAL_CLIENT_ID;
    if (!finalClientId) {
      return Promise.reject(new Error('MISSING_PAYPAL_CLIENT_ID'));
    }

    return loadPayPalSdk(finalClientId, currency);
  }

  function loadPayPalSdk(clientId, currency = 'USD') {
    // Si déjà chargé avec le même clientId, résoudre immédiatement
    if (w.paypal && sdkLoadedClientId === clientId) {
      return Promise.resolve();
    }

    // Si un chargement est en cours, attendre
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
        sdkPromise = null; // Réinitialiser pour permettre un retry
        const err = new Error('PAYPAL_SDK_LOAD_FAILED');
        console.error('[PayPal SDK] Load failed');
        reject(err);
      };
      
      document.head.appendChild(s);
    });

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

      console.log('[PayPal] Initializing buttons for order:', orderId);

      // 🚀 OPTIMISATION: Si le SDK n'est pas chargé, le charger maintenant
      // (mais normalement il est déjà chargé par ensureSDK en parallèle)
      await loadPayPalSdk(clientId, currency);

      const containerId = 'paypal-button-container';
      let container = document.getElementById(containerId);
      
      if (!container) {
        console.warn('[PayPal] Container not found, creating one');
        container = document.createElement('div');
        container.id = containerId;
        const confirmBtn = document.getElementById('confirm');
        if (confirmBtn) {
          confirmBtn.insertAdjacentElement('afterend', container);
        } else {
          // Fallback: ajouter au modal ou form
          const formSection = document.getElementById('formSection');
          const form = document.getElementById('form') || document.querySelector('form');
          const target = form || formSection || document.body;
          target.appendChild(container);

        }
      } else {
        // Évite les double-renders si on relance initAndRender
        container.innerHTML = '';
      }

      // --- Création d'ordre côté serveur (montant calculé serveur) ---
      const createOrder = async () => {
        console.log('[PayPal] Creating PayPal order for orderId:', orderId);
        
        // On n'envoie QUE { orderId, currency } dans le body → anti-414
        const body = JSON.stringify({ orderId, currency });

        try {
          // 1) Si ton wrapper existe, on l'utilise (et on STRINGIFIE le body)
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
              console.error('[PayPal] Create order failed:', data);
              throw new Error(errCode);
            }
            
            console.log('[PayPal] PayPal order created:', paypalId);
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
            credentials: 'same-origin'
          });

          const j = await readJsonSafe(resp);

          // Si Cloudflare renvoie une page HTML 414, on remonte une erreur claire
          if (j?.message && typeof j.message === 'string' && j.message.includes('414')) {
            const e = new Error('REQUEST_URI_TOO_LARGE');
            e.code = '414';
            e.details = j.message;
            console.error('[PayPal] 414 error:', e);
            throw e;
          }

          if (!resp.ok) {
            const e = new Error(j?.error || j?.message || 'PAYPAL_CREATE_FAILED');
            e.details = j;
            console.error('[PayPal] Create order failed:', e);
            throw e;
          }

          const paypalId = j?.id || j?.paypalOrderId;
          if (!paypalId) {
            console.error('[PayPal] No PayPal ID returned:', j);
            throw new Error('PAYPAL_CREATE_FAILED');
          }
          
          console.log('[PayPal] PayPal order created:', paypalId);
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
          console.log('[PayPal] Payment approved, paypalOrderId:', data.orderID);
          
          if (typeof onApproved === 'function') {
            // On te refile le data PayPal complet (tu lis data.orderID)
            await onApproved(data, actions);
          } else {
            // Fallback : finaliser côté serveur si aucun callback fourni
            console.log('[PayPal] No custom onApproved handler, using default finalization');
            
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
              console.error('[PayPal] Finalization failed:', e);
              throw e;
            }
            
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

      // 🚀 OPTIMISATION: Vérifier que window.paypal est disponible avant le render
      if (!w.paypal || !w.paypal.Buttons) {
        throw new Error('PAYPAL_SDK_NOT_LOADED');
      }

      console.log('[PayPal] Rendering buttons');

      // Rendu des boutons
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

  // 🚀 NOUVEAU: Exposer ensureSDK pour le pre-loading
  w.PayPalIntegration = { 
    initAndRender,
    ensureSDK,
    // Utilitaire pour vérifier si le SDK est chargé
    isSDKLoaded: () => !!(w.paypal && w.paypal.Buttons)
  };

  console.log('[PayPalIntegration] Module loaded with parallel SDK support');

})(window);