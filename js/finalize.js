(function(window){
  'use strict';
  // Orchestrator that uses the new modular pieces.
  const api = window.App && window.App.api ? window.App.api : null;
  const locks = window.App && window.App.locks ? window.App.locks : null;
  const upload = window.App && window.App.upload ? window.App.upload : null;
  const paypalService = window.App && window.App.paypalService ? window.App.paypalService : null;
  const modalApi = window.App && window.App.ui && window.App.ui.modal ? window.App.ui.modal : null;
  const orderSummary = window.App && window.App.ui && window.App.ui.orderSummary ? window.App.ui.orderSummary : null;
  const paypalWidget = window.App && window.App.ui && window.App.ui.paypalWidget ? window.App.ui.paypalWidget : null;

  async function doConfirm(){
    // Validate selection & form
    const name = (document.getElementById('name')?.value || '').trim();
    const linkUrl = (document.getElementById('link')?.value || '').trim();
    const blocks = (typeof window.getSelectedIndices === 'function')? window.getSelectedIndices() : document.querySelectorAll('.cell.sel').length;
    const uploaded = window._uploadedImageCache || null;
    if (!blocks || blocks.length === 0) return alert('Select blocks before confirming');
    if (!name || !linkUrl) return alert('Complete name and profile');
    if (!uploaded) return alert('Upload image first');

    // show summary, pause heartbeat
    try { window.LockManager?.heartbeat?.stop?.(); } catch(e){}
    modalApi.switchToPaymentMode(true);

    const summary = orderSummary.renderSummary({
      name, linkUrl, pixels: (Array.isArray(blocks)?blocks.length:blocks) * 100,
      total: window.reservedTotal || Math.round(((window.globalPrice||1) * ((Array.isArray(blocks)?blocks.length:blocks) * 100)) * 100)/100
    });

    // create order on server then render paypal buttons
    try {
      const start = await paypalService.startOrder({ name, linkUrl, blocks: Array.isArray(blocks)?blocks:[], imageUrl: uploaded.imageUrl, regionId: uploaded.regionId });
      if (!start || !start.ok) throw new Error(start && (start.error || start.message) || 'start-order failed');
      const orderId = start.orderId || start.id;
      // render PayPal
      await paypalWidget.ensureSDK();
      await paypalWidget.render(orderId, start.currency || 'USD', {
        onApproved: async (data, actions) => {
          try {
            paypalWidget.setState('processing');
            const res = await paypalService.finalize(orderId, data.orderID);
            if (!res || !res.ok) throw new Error('finalize failed');
            paypalWidget.setState('completed');
            modalApi.switchToPaymentMode(false);
            orderSummary.removeSummary();
            modalApi.resetModalContent();
            try { window.LockManager?.heartbeat?.stop?.(); } catch(e){}
            await api.call('/status?refresh=1');
          } catch (e) {
            paypalWidget.setState('error');
            console.error('[finalize] finalize error', e);
            alert('Payment finalize failed');
          }
        },
        onCancel: () => {
          paypalWidget.setState('cancelled');
          // allow retry while locks valid
          if (typeof window.startModalMonitor === 'function') window.startModalMonitor(0);
        },
        onError: (err) => {
          paypalWidget.setState('error');
          console.error('[finalize] paypal error', err);
        }
      });
    } catch (e){
      console.error('[finalize] doConfirm failed', e);
      modalApi.switchToPaymentMode(false);
      orderSummary.removeSummary();
      modalApi.resetModalContent();
      try { await locks.heartbeat?.stop?.(); } catch(e){}
      throw e;
    }
  }

  // expose
  window.App = window.App || {};
  window.App.finalize = { doConfirm };

  // hook submit event (compat with existing code)
  document.addEventListener('finalize:submit', (e)=>{ e && e.preventDefault && e.preventDefault(); doConfirm().catch(()=>{}); });

})(window);
