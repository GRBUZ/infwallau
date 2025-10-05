(function(window){
  'use strict';
  const containerId = 'paypal-button-container';
  function ensureContainer(){
    let c = document.getElementById(containerId);
    if (!c){
      c = document.createElement('div');
      c.id = containerId;
      const footer = document.querySelector('.modal .footer') || document.querySelector('.modal .body') || document.getElementById('modal');
      (footer || document.body).appendChild(c);
    }
    return c;
  }

  async function ensureSDK(clientId, currency){
    if (window.PayPalIntegration && typeof window.PayPalIntegration.ensureSDK === 'function') {
      return window.PayPalIntegration.ensureSDK(clientId, currency);
    }
    // fallback: if script already present, resolve
    if (window.paypal && window.paypal.Buttons) return;
    throw new Error('PayPal SDK unavailable');
  }

  async function render(orderId, currency, handlers={}){
    const c = ensureContainer();
    c.innerHTML = '';
    c.className = 'loading';
    if (!window.PayPalIntegration || typeof window.PayPalIntegration.initAndRender !== 'function') {
      throw new Error('PayPalIntegration missing');
    }
    return window.PayPalIntegration.initAndRender({
      orderId,
      currency,
      onApproved: handlers.onApproved,
      onCancel: handlers.onCancel,
      onError: handlers.onError
    });
  }

  function destroy(){
    const c = document.getElementById(containerId);
    if (c && c.parentNode) c.parentNode.removeChild(c);
  }

  function setState(state){
    const c = document.getElementById(containerId);
    if (!c) return;
    c.className = 'paypal-state-' + state;
    // also set aria disabled on wrapper
    if (state === 'error' || state === 'expired') {
      c.style.pointerEvents = 'none'; c.style.opacity = '0.6';
    } else {
      c.style.pointerEvents = ''; c.style.opacity = '';
    }
  }

  window.App = window.App || {};
  window.App.ui = window.App.ui || {};
  window.App.ui.paypalWidget = { ensureContainer, ensureSDK, render, destroy, setState };
})(window);
