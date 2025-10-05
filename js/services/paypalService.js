(function(window){
  'use strict';
  async function startOrder(payload){
    // payload: { name, linkUrl, blocks, imageUrl, regionId }
    try {
      if (window.CoreManager && typeof window.CoreManager.apiCall === 'function') {
        return await window.CoreManager.apiCall('/start-order', { method:'POST', body: JSON.stringify(payload) });
      }
      // fallback
      return await window.App.api.call('/start-order', { method:'POST', body: JSON.stringify(payload) });
    } catch (e) { throw e; }
  }

  async function finalize(orderId, paypalOrderId){
    return window.App.api.call('/paypal-capture-finalize', { method:'POST', body: JSON.stringify({ orderId, paypalOrderId }) });
  }

  window.App = window.App || {};
  window.App.paypalService = { startOrder, finalize };
})(window);
