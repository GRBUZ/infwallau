(function(window){
  'use strict';
  const modal = document.getElementById('modal');
  function openModal(){ if (!modal) return; modal.classList.remove('hidden'); document.dispatchEvent(new CustomEvent('modal:opening')); }
  function closeModal(){ if (!modal) return; modal.classList.add('hidden'); document.dispatchEvent(new CustomEvent('modal:closing')); }
  function switchToPaymentMode(enable){
    if (!modal) return;
    if (enable) modal.classList.add('payment-active');
    else modal.classList.remove('payment-active');
  }
  function resetModalContent(){
    // remove order summary & paypal container if present
    const s = document.getElementById('order-summary'); if (s) s.remove();
    const p = document.getElementById('paypal-button-container'); if (p && p.parentNode) p.parentNode.removeChild(p);
    // ensure form visible
    const f = document.getElementById('form'); if (f) f.style.display = '';
  }
  window.App = window.App || {};
  window.App.ui = window.App.ui || {};
  window.App.ui.modal = { openModal, closeModal, switchToPaymentMode, resetModalContent };
})(window);
