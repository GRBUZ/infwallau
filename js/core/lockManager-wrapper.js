(function(window){
  'use strict';
  const lm = {
    async lock(blocks, ms, opts){
      if (window.LockManager && typeof window.LockManager.lock === 'function') {
        return window.LockManager.lock(blocks, ms, opts);
      }
      // fallback: call API
      return window.App.api.call('/lock', { method:'POST', body: JSON.stringify({ blocks, ms }) });
    },
    async unlock(blocks){
      if (window.LockManager && typeof window.LockManager.unlock === 'function') {
        return window.LockManager.unlock(blocks);
      }
      return window.App.api.call('/unlock', { method:'POST', body: JSON.stringify({ blocks }) });
    },
    getLocalLocks(){
      try { return window.LockManager?.getLocalLocks?.() || {}; } catch(e){ return {}; }
    },
    heartbeat: {
      start(blocks, interval=30000, maxMs=180000, opts={}){
        try { return window.LockManager?.heartbeat?.start?.(blocks, interval, maxMs, opts); } catch(e){}
      },
      stop(){ try { return window.LockManager?.heartbeat?.stop?.(); } catch(e){} }
    }
  };
  window.App = window.App || {};
  window.App.locks = lm;
})(window);
