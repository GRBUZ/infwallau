// core-manager.js — Gestionnaire centralisé pour UID, Auth et API calls (avec gestion d'erreurs via errors.js)
(function() {
  'use strict';

  // ===================
  // Helpers robustes d'erreurs (non-breaking)
  // ===================
  const CORE_TIMEOUT_MS = 20000;   // Mettre 0 pour désactiver le timeout
  const CORE_RETRIES    = 2;       // Retries sur erreurs transitoires (en plus du refresh 401)

  function cm_isRetriableStatus(status){
    //return status === 0 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
    return status === 0 || status === 408 || status === 409 || status === 429 || status === 502 || status === 503 || status === 504;
  }
  function cm_guessCode(status){
    if (status === 401) return 'AUTH_REQUIRED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 404) return 'NOT_FOUND';
    if (status === 409) return 'CONFLICT';
    if (status >= 500) return 'SERVER_ERROR';
    return 'HTTP_ERROR';
  }
  function cm_notifyOnce(err, endpoint){
    try {
      if (window.Errors && typeof window.Errors.notifyError === 'function') {
        window.Errors.notifyError(err, `API ${endpoint}`);
      } else {
        console.error('[API] Error:', err);
      }
    } catch {}
  }
  function cm_backoff(attempt){
    const base = 300 * Math.pow(2, Math.max(0, attempt)); // 300, 600, 1200ms...
    const jitter = Math.floor(Math.random()*200);
    return new Promise(res=>setTimeout(res, base + jitter));
  }
  function cm_normalizeNetworkError(e){
    // Timeout/Abort
    if (e && (e.name === 'AbortError' || /aborted/i.test(e.message||''))) {
      if (window.Errors) return window.Errors.create('TIMEOUT', 'Request timeout', { status: 0, retriable: true });
      const err = new Error('Request timeout'); err.code='TIMEOUT'; err.status=0; return err;
    }
    // Network (TypeError/Fetched failed)
    if (e instanceof TypeError || /Failed to fetch|NetworkError|load failed/i.test(e?.message||'')) {
      if (window.Errors) return window.Errors.create('NETWORK_ERROR', 'Network error', { status: 0, retriable: true });
      const err = new Error('Network error'); err.code='NETWORK_ERROR'; err.status=0; return err;
    }
    return e;
  }
  function cm_httpError(status, payload){
    const code = cm_guessCode(status);
    const msg = (payload && (payload.message || payload.error)) || `HTTP ${status}`;
    if (window.Errors && typeof window.Errors.create === 'function') {
      return window.Errors.create(code, msg, { status, retriable: cm_isRetriableStatus(status), details: payload });
    }
    const e = new Error(msg); e.code = code; e.status = status; return e;
  }

  // ===================
  // UID UNIFIÉ
  // ===================
  class UIDManager {
    constructor() {
      this.KEY = 'iw_uid';
      this._uid = null;
    }

    get uid() {
      if (this._uid) return this._uid;

      // Essayer localStorage d'abord
      let stored = null;
      try {
        stored = localStorage.getItem(this.KEY);
      } catch (e) {
        console.warn('[UID] localStorage inaccessible');
      }

      if (stored && stored.length > 0) {
        this._uid = stored;
        window.uid = this._uid; // Compatibilité
        return this._uid;
      }

      // Générer nouveau UID
      this._uid = this._generateUID();
      try {
        localStorage.setItem(this.KEY, this._uid);
      } catch (e) {
        console.warn('[UID] Impossible de sauvegarder');
      }

      window.uid = this._uid; // Compatibilité
      return this._uid;
    }

    _generateUID() {
      // Méthode robuste avec fallbacks
      if (window.crypto && window.crypto.randomUUID) {
        return crypto.randomUUID();
      }

      if (window.crypto && window.crypto.getRandomValues) {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return Array.from(arr, byte => byte.toString(16).padStart(2, '0')).join('');
      }

      // Fallback final
      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
  }

  // ===================
  // API MANAGER UNIFIÉ
  // ===================
  class APIManager {
    constructor(uidManager) {
      this.uidManager = uidManager;
      this.BASE_URL = '/.netlify/functions';
      this.MAX_RETRIES = 2; // héritage; CORE_RETRIES gère les erreurs transitoires de transport/serveur
    }

    async getAuthHeaders() {
      if (!window.AuthUtils) return {};
      try {
        return await window.AuthUtils.getAuthHeaders();
      } catch (e) {
        console.warn('[API] Auth headers failed:', e);
        return {};
      }
    }

    // Construit les headers en conservant le comportement existant
    async _buildHeaders(options = {}) {
      const authHeaders = await this.getAuthHeaders();
      const isForm = options.body && (options.body instanceof FormData);

      const headers = {
        ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders,
        ...(options.headers || {})
      };

      // Ajout non-bloquant de X-Client-UID
      try {
        const uid = (this.uidManager && this.uidManager.uid) || (window.CoreManager && window.CoreManager.uid);
        if (uid && !headers['X-Client-UID']) headers['X-Client-UID'] = uid;
      } catch {}

      return headers;
    }

    // fetch avec timeout optionnel
    async _fetchWithTimeout(url, config) {
      if (!CORE_TIMEOUT_MS) {
        return fetch(url, config);
      }
      const ctl = new AbortController();
      const t = setTimeout(()=>ctl.abort(), CORE_TIMEOUT_MS);
      try {
        const res = await fetch(url, { ...config, signal: ctl.signal });
        clearTimeout(t);
        return res;
      } catch (e) {
        clearTimeout(t);
        throw e;
      }
    }

    async call(endpoint, options = {}) {
      const url = `${this.BASE_URL}${endpoint}`;
      const headers = await this._buildHeaders(options);
      const baseConfig = {
        ...options,
        headers,
        credentials: 'same-origin'
      };

      let attempt = 0;
      let refreshedOnce = false;

      while (attempt <= Math.max(this.MAX_RETRIES, CORE_RETRIES)) {
        try {
          const response = await this._fetchWithTimeout(url, baseConfig);

          // 401 → tenter un refresh une seule fois avant de continuer les retries transitoires
          if (response.status === 401 && !refreshedOnce && window.AuthUtils) {
            console.warn('[API] Token expired, refreshing...');
            try {
              localStorage.removeItem('iw_jwt');
              const newAuthHeaders = await this.getAuthHeaders();
              baseConfig.headers = { ...baseConfig.headers, ...newAuthHeaders };
              refreshedOnce = true;
              // on ne compte pas ce cas comme un "attempt" de transport; on re-tente immédiatement
              continue;
            } catch (e) {
              console.error('[API] Auth refresh failed:', e);
              // On laisse passer vers la gestion générique ci-dessous
            }
          }

          const contentType = response.headers.get && response.headers.get('content-type') || '';
          const isJson = contentType.includes('application/json');

          // Tenter de parser quoi qu'il arrive (même si !ok, on renvoie payload pour rester compatible)
          let payload = null;
          try { payload = isJson ? await response.json() : await response.text(); } catch {}

          if (!response.ok) {
            // Erreur HTTP: si transitoire, retry avec backoff
            if (cm_isRetriableStatus(response.status) && attempt < CORE_RETRIES) {
              attempt++;
              await cm_backoff(attempt);
              continue;
            }
            // Notifier (dernier échec), puis conserver l'ancien comportement: renvoyer payload si dispo, sinon null
            const httpErr = cm_httpError(response.status, isJson ? (payload || {}) : { error: String(payload || `HTTP ${response.status}`) });
            cm_notifyOnce(httpErr, endpoint);
            return isJson ? (payload || null) : null;
          }

          // OK: renvoyer le JSON (ou texte) comme avant
          return payload !== undefined ? payload : null;
        } catch (e) {
          const ne = cm_normalizeNetworkError(e);
          if (cm_isRetriableStatus(ne.status || 0) && attempt < CORE_RETRIES) {
            attempt++;
            console.error(`[API] Attempt ${attempt} failed (transient):`, ne);
            await cm_backoff(attempt);
            continue;
          }
          // Dernier échec ou non-retriable → notifier et retourner null (comportement historique)
          cm_notifyOnce(ne, endpoint);
          return null;
        }
      }

      // Exhausted (ne devrait pas arriver)
      return null;
    }

    async callMultipart(endpoint, formData, options = {}) {
      const url = `${this.BASE_URL}${endpoint}`;
      const headers = await this._buildHeaders({ ...(options || {}), body: formData }); // ne pas définir Content-Type
      const baseConfig = {
        method: 'POST',
        body: formData,
        headers,
        credentials: 'same-origin',
        ...options
      };

      let attempt = 0;
      let refreshedOnce = false;

      while (attempt <= Math.max(this.MAX_RETRIES, CORE_RETRIES)) {
        try {
          const response = await this._fetchWithTimeout(url, baseConfig);

          if (response.status === 401 && !refreshedOnce && window.AuthUtils) {
            console.warn('[API] Token expired during upload, refreshing...');
            try {
              localStorage.removeItem('iw_jwt');
              const newAuthHeaders = await this.getAuthHeaders();
              baseConfig.headers = { ...baseConfig.headers, ...newAuthHeaders };
              refreshedOnce = true;
              continue;
            } catch (e) {
              console.error('[API] Auth refresh failed (multipart):', e);
            }
          }

          const contentType = response.headers.get && response.headers.get('content-type') || '';
          const isJson = contentType.includes('application/json');
          let payload = null;
          try { payload = isJson ? await response.json() : await response.text(); } catch {}

          if (!response.ok) {
            if (cm_isRetriableStatus(response.status) && attempt < CORE_RETRIES) {
              attempt++;
              await cm_backoff(attempt);
              continue;
            }
            const httpErr = cm_httpError(response.status, isJson ? (payload || {}) : { error: String(payload || `HTTP ${response.status}`) });
            cm_notifyOnce(httpErr, endpoint);
            return isJson ? (payload || null) : null;
          }

          return payload !== undefined ? payload : null;
        } catch (e) {
          const ne = cm_normalizeNetworkError(e);
          if (cm_isRetriableStatus(ne.status || 0) && attempt < CORE_RETRIES) {
            attempt++;
            console.error(`[API] Multipart attempt ${attempt} failed (transient):`, ne);
            await cm_backoff(attempt);
            continue;
          }
          cm_notifyOnce(ne, endpoint);
          return null;
        }
      }

      return null;
    }

    async callRaw(endpoint, options = {}) {
      const url = `${this.BASE_URL}${endpoint}`;
      const authHeaders = await this.getAuthHeaders();

      const isForm = options.body && (options.body instanceof FormData);
      const headers = {
        ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders,
        ...(options.headers || {})
      };

      // X-Client-UID facultatif
      try {
        const uid = (this.uidManager && this.uidManager.uid) || (window.CoreManager && window.CoreManager.uid);
        if (uid && !headers['X-Client-UID']) headers['X-Client-UID'] = uid;
      } catch {}

      // Pour callRaw on ne force pas de timeout pour éviter les régressions
      return await fetch(url, {
        ...options,
        headers,
        credentials: 'same-origin'
      });
    }
  }

  // ===================
  // INITIALISATION
  // ===================
  const uidManager = new UIDManager();
  const apiManager = new APIManager(uidManager);

  // Exports globaux pour compatibilité
  window.CoreManager = {
    uid: uidManager.uid,
    apiCall: (endpoint, options) => apiManager.call(endpoint, options),
    apiCallMultipart: (endpoint, formData, options) => apiManager.callMultipart(endpoint, formData, options),
    apiCallRaw: (endpoint, options) => apiManager.callRaw(endpoint, options)
  };

  // Compatibilité avec l'ancien système
  window.uid = uidManager.uid;
  window.apiCall = window.CoreManager.apiCall;
  window.apiCallMultipart = window.CoreManager.apiCallMultipart;
  window.apiCallRaw = window.CoreManager.apiCallRaw;

  console.log('[CoreManager] Initialized with UID:', uidManager.uid);
})();