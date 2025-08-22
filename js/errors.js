// errors.js — Normalisation des erreurs + toasts UI + hooks globaux
(function(){
  'use strict';

  const LEVEL = { info:'info', success:'success', warn:'warn', error:'error' };

  function create(code, message, options = {}) {
    const e = new Error(message || code || 'Error');
    e.code = code || 'UNKNOWN';
    if (options.status) e.status = options.status;
    if (options.cause) e.cause = options.cause;
    if (options.retriable !== undefined) e.retriable = !!options.retriable;
    if (options.details) e.details = options.details;
    return e;
  }

  function normalize(err) {
    if (!err) return { code:'UNKNOWN', message:'Unknown error', retriable:false };
    if (typeof err === 'string') return { code:'UNKNOWN', message: err, retriable:false };
    if (err instanceof Error) {
      return {
        code: err.code || guessCodeFromStatus(err.status) || 'UNKNOWN',
        message: err.message || 'Unexpected error',
        status: err.status,
        retriable: typeof err.retriable === 'boolean' ? err.retriable : isRetriableStatus(err.status),
        details: err.details
      };
    }
    if (typeof err === 'object') {
      const code = err.code || guessCodeFromStatus(err.status) || 'UNKNOWN';
      const msg = err.message || err.error || 'Unexpected error';
      return { code, message: msg, status: err.status, retriable: isRetriableStatus(err.status), details: err.details };
    }
    return { code:'UNKNOWN', message:String(err), retriable:false };
  }

  function guessCodeFromStatus(status){
    if (!status) return '';
    if (status === 401) return 'AUTH_REQUIRED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 409) return 'CONFLICT';
    if (status >= 500) return 'SERVER_ERROR';
    return '';
  }
  function isRetriableStatus(status){
    return status === 0 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
  }

  // Toasts minimalistes
  let toastHost = null;
  function ensureHost(){
    if (toastHost) return toastHost;
    const host = document.createElement('div');
    host.id = 'toast-host';
    Object.assign(host.style, {
      position:'fixed', zIndex: 9999, right:'16px', bottom:'16px',
      display:'flex', flexDirection:'column', gap:'8px', maxWidth:'360px',
      pointerEvents:'none'
    });
    document.body.appendChild(host);
    toastHost = host;
    return host;
  }
  function showToast(message, level = LEVEL.error, ttlMs = 5000){
    if (!message) return;
    const host = ensureHost();
    const el = document.createElement('div');
    Object.assign(el.style, {
      background: level === LEVEL.success ? '#16a34a' : level === LEVEL.info ? '#2563eb' : level === LEVEL.warn ? '#d97706' : '#dc2626',
      color:'#fff', padding:'10px 12px', borderRadius:'8px', boxShadow:'0 4px 16px rgba(0,0,0,0.2)',
      font:'14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      pointerEvents:'auto'
    });
    el.textContent = message;
    host.appendChild(el);
    setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .25s'; setTimeout(()=>el.remove(), 300); }, Math.max(1000, ttlMs));
  }

  function notifyError(err, context){
    const n = normalize(err);
    const prefix = context ? `[${context}] ` : '';
    console.error(prefix + n.message, { code:n.code, status:n.status, retriable:n.retriable, details:n.details, raw:err });
    const userMsg = humanMessage(n, context);
    showToast(userMsg, LEVEL.error);
    return n;
  }

  function humanMessage(n, context){
    switch (n.code) {
      case 'AUTH_REQUIRED': return 'Authentication required. Please sign in and try again.';
      case 'FORBIDDEN': return 'You don’t have permission to do this.';
      case 'NOT_FOUND': return 'Resource not found.';
      case 'CONFLICT': return 'Conflict detected. Please refresh and try again.';
      case 'UPLOAD_FAILED': return 'Image upload failed. Please try a smaller file or a different format.';
      case 'INVALID_FILE_TYPE': return 'Invalid file type. Allowed: JPG, PNG, GIF.';
      case 'FILE_TOO_LARGE': return 'File too large. Max 1.5 MB.';
      case 'NO_FILE': return 'No file selected.';
      case 'FINALIZE_FAILED': return 'Could not finalize your purchase. Please try again.';
      case 'NETWORK_ERROR': return 'Network error. Check your internet connection.';
      case 'TIMEOUT': return 'Request timed out. Please try again.';
      case 'SERVER_ERROR': return 'Server error. Please try again later.';
      default:
        return context ? `${context} failed. Please try again.` : 'Something went wrong. Please try again.';
    }
  }

  // Hooks globaux
  function installGlobalHandlers(){
    if (window.__errorsHandlersInstalled) return;
    window.__errorsHandlersInstalled = true;

    window.addEventListener('error', (e)=>{
      console.warn('[global error]', e.message || e);
    });

    window.addEventListener('unhandledrejection', (e)=>{
      notifyError(e.reason || e, 'Unhandled');
    });

    window.addEventListener('offline', ()=>{
      showToast('You are offline. Some actions may not work.', LEVEL.warn, 4000);
    });
    window.addEventListener('online', ()=>{
      showToast('Back online.', LEVEL.info, 2500);
    });
  }

  const api = { create, normalize, showToast, notifyError, installGlobalHandlers, LEVEL };
  window.Errors = api;
  installGlobalHandlers();
})();