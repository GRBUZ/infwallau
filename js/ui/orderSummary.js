(function(window){
  'use strict';
  function renderSummary({ name, linkUrl, pixels, total }){
    const modal = document.getElementById('modal');
    const body = modal?.querySelector('.body') || document.querySelector('.modal .body');
    if (!body) return null;
    const old = document.getElementById('order-summary'); if (old) old.remove();
    const div = document.createElement('div'); div.id='order-summary';
    div.innerHTML = `
      <div style="padding:12px 16px;border-radius:10px;border:1px solid #eee;background:#fff;margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong>Order summary</strong>
          <button id="editOrder" type="button" style="background:none;border:0;color:#3b82f6;cursor:pointer">Edit</button>
        </div>
        <div style="font-size:13px;color:#555">
          <div><small>Name</small><div>${name}</div></div>
          <div><small>Profile</small><div title="${linkUrl}">${linkUrl}</div></div>
          <div><small>Pixels</small><div>${pixels} px</div></div>
          ${typeof total !== 'undefined' ? `<div><small>Total</small><div>$${total}</div></div>` : ''}
        </div>
      </div>
    `;
    body.insertBefore(div, body.firstChild);
    const btn = div.querySelector('#editOrder');
    btn.addEventListener('click', ()=>{ document.dispatchEvent(new CustomEvent('order:edit')); });
    return div;
  }

  function removeSummary(){
    const s = document.getElementById('order-summary'); if (s) s.remove();
  }

  window.App = window.App || {};
  window.App.ui = window.App.ui || {};
  window.App.ui.orderSummary = { renderSummary, removeSummary };
})(window);
