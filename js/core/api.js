(function(window){
  'use strict';
  // Simple wrapper for CoreManager.apiCall with safe JSON helper
  function readJsonSafe(resp){
    return resp && typeof resp.json === 'function' ? resp.json() : Promise.resolve(resp);
  }

  async function apiCall(path, opts){
    if (window.CoreManager && typeof window.CoreManager.apiCall === 'function') {
      try {
        const r = await window.CoreManager.apiCall(path, opts || {});
        return r;
      } catch (e) {
        console.warn('[api] CoreManager.apiCall failed, rethrowing', e);
        throw e;
      }
    }
    // Fallback to fetch if CoreManager not available
    const o = Object.assign({ credentials:'same-origin' }, opts || {});
    if (o.body && typeof o.body !== 'string') {
      try { o.body = JSON.stringify(o.body); } catch (e) {}
      o.headers = Object.assign({'Content-Type':'application/json'}, o.headers || {});
    }
    const resp = await fetch(path, o);
    if (!resp.ok) {
      const j = await resp.text();
      const err = new Error('API_CALL_FAILED');
      err.details = j.slice ? j.slice(0,4000) : j;
      throw err;
    }
    return readJsonSafe(resp);
  }

  window.App = window.App || {};
  window.App.api = { call: apiCall, readJsonSafe };
})(window);
