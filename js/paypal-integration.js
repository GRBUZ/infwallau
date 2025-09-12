// paypal-integration.js - Intégration PayPal frontend (alignée serveur)
(function(window) {
  'use strict';

  let paypalOrderId = null;

  function initPayPal(clientId, currency = 'USD') {
    if (window.paypal) { setupPayPalButtons(currency); return; }
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${clientId}&currency=${currency}`;
    script.onload = () => setupPayPalButtons(currency);
    document.head.appendChild(script);
  }

  function setupPayPalButtons(currency) {
    if (!window.paypal) { console.error('PayPal SDK non chargé'); return; }

    window.paypal.Buttons({
      // Création de la commande côté serveur (montant fiable lu depuis l'orderId)
      createOrder: async () => {
        // ⚠️ On attend que /start-order ait produit window.currentOrderId
        const orderId = window.currentOrderId;
        if (!orderId) { throw new Error('Aucune commande préparée.'); }

        const r = await window.fetchWithJWT('/.netlify/functions/paypal-create-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId })
        });
        if (!r.ok) {
          const j = await r.json().catch(()=>({}));
          throw new Error(j.error || 'Erreur création commande PayPal');
        }
        const j = await r.json();
        paypalOrderId = j.id;
        return paypalOrderId;
      },

      onApprove: async (data) => {
        console.log('📋 [PAYPAL] Commande approuvée:', data.orderID);
        showPaymentProcessing();

        // Ici on attend que le webhook finalise la commande
        const ord = window.currentOrderId;
        const res = await waitForOrderCompleted(ord);
        if (res.success) {
          showPaymentSuccess();
          try { window.selected?.clear?.(); } catch(_){}
          try { window.closeModal?.(); } catch(_){}
          setTimeout(async () => {
            await window.loadStatus?.();
            window.paintAll?.();
          }, 600);
        } else {
          showPaymentError(res.error || 'Paiement non confirmé');
        }
      },

      onCancel: () => {
        console.log('⚠️ [PAYPAL] Paiement annulé');
        releasePendingBlocks();
        alert('Paiement annulé. Les blocs ont été libérés.');
      },

      onError: (err) => {
        console.error('❌ [PAYPAL] Erreur:', err);
        releasePendingBlocks();
        showPaymentError(err?.message || 'Erreur inconnue');
      }
    }).render('#paypal-button-container');
  }

  async function waitForOrderCompleted(orderId, maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const r = await window.fetchWithJWT(`/.netlify/functions/order-status?orderId=${encodeURIComponent(orderId)}`);
        const j = await r.json();
        if (j?.ok && String(j.status).toLowerCase() === 'completed') return { success: true };
        if (j?.ok && String(j.status).toLowerCase() === 'failed')    return { success: false, error: j.failReason || 'FAILED' };
        await new Promise(rs => setTimeout(rs, 2000));
      } catch {}
    }
    return { success: false, error: 'Timeout confirmation paiement' };
  }

  async function releasePendingBlocks() {
    try {
      if (window.currentLock && window.currentLock.length) {
        await window.unlock(window.currentLock);
        window.currentLock = [];
      }
    } catch (e) { console.warn('Erreur libération blocs:', e); }
  }

  function showPaymentProcessing() {
    const btn = document.getElementById('confirm');
    if (btn) { btn.disabled = true; btn.textContent = 'Traitement PayPal...'; }
  }
  function showPaymentSuccess() {
    alert('✅ Paiement réussi ! Vos blocs sont actifs.');
  }
  function showPaymentError(message) {
    const btn = document.getElementById('confirm');
    if (btn) { btn.disabled = false; btn.textContent = 'Confirmer'; }
    alert('❌ Erreur de paiement: ' + message);
  }

  function replaceConfirmButton() {
    const confirmBtn = document.getElementById('confirm');
    const paypalContainer = document.createElement('div');
    paypalContainer.id = 'paypal-button-container';
    paypalContainer.style.marginTop = '20px';
    confirmBtn.parentNode.insertBefore(paypalContainer, confirmBtn.nextSibling);
    confirmBtn.style.display = 'none';
  }

  function initPayPalIntegration(clientId, currency = 'USD') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { replaceConfirmButton(); initPayPal(clientId, currency); });
    } else {
      replaceConfirmButton(); initPayPal(clientId, currency);
    }
  }

  window.PayPalIntegration = { init: initPayPalIntegration };
})(window);
