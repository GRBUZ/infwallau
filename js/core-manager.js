// core-manager.js — Optimisé avec cache intelligent et retry adaptatif
(function() {
  'use strict';

  // ===================
  // OPTIMISATION 1: Configuration adaptative
  // ===================
  const CORE_TIMEOUT_MS = 15000;   // Réduit de 20s à 15s
  const CORE_RETRIES = 2;
  
  // Cache intelligent pour les endpoints lents
  const CACHE_ENDPOINTS = ['/status', '/diag'];
  const CACHE_TTL = {
    '/status': 1500,    // 1.5s cache pour status
    '/diag': 30000      // 30s cache pour diagnostic
  };
  
  const requestCache = new Map();
  
  // Anti-spam optimisé
  const NOTIFY_COOLDOWN_MS = 6000;    // Réduit de 8s à 6s
  const __notifySeen = new Map();
  let __offlineFirstNotified = false;

  // ===================
  // OPTIMISATION 2: Détection réseau améliorée
  // ===================
  let connectionQuality = 'unknown'; // 'fast' | 'slow' | 'offline' | 'unknown'
  let adaptiveTimeout = CORE_TIMEOUT_MS;

  function detectConnectionQuality() {
    if (navigator.connection) {
      const conn = navigator.connection;
      const downlink = conn.downlink || 0;
      const effectiveType = conn.effectiveType || '';
      
      if (downlink > 2 || effectiveType.includes('4g')) {
        connectionQuality = 'fast';
        adaptiveTimeout = CORE_TIMEOUT_MS * 0.8; // 12s
      } else if (downlink > 0.5 || effectiveType.includes('3g')) {
        connectionQuality = 'slow';
        adaptiveTimeout = CORE_TIMEOUT_MS * 1.5; // 22.5s
      } else {
        connectionQuality = 'offline';
        adaptiveTimeout = CORE_TIMEOUT_MS;
      }
      
      console.log(`[CoreManager] Connection: ${connectionQuality} (${downlink}Mbps, ${effectiveType})`);
    }
  }

  // Détecter la qualité initiale et la surveiller
  detectConnectionQuality();
  if (navigator.connection) {
    navigator.connection.addEventListener('change', detectConnectionQuality);
  }

  window.addEventListener('offline', () => {
    window.__OFFLINE = true;
    connectionQuality = 'offline';
    __offlineFirstNotified = false;
  });
  
  window.addEventListener('online', () => {
    window.__OFFLINE = false;
    connectionQuality = 'unknown';
    detectConnectionQuality();
    __notifySeen.clear();
    __offlineFirstNotified = false;
  });

  // ===================
  // OPTIMISATION 3: Helpers d'erreur optimisés
  // ===================
  function cm_isRetriableStatus(status){
    return status === 0 || status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
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
      if (window.__OFFLINE) {
        if (__offlineFirstNotified) return;
        __offlineFirstNotified = true;
        if (window.Errors && typeof window.Errors.showToast === 'function') {
          window.Errors.showToast('Network offline. Changes will sync when you're back online.', 'warn', 3500);
          return;
        }
        return;
      }

      if (!window.Errors || typeof window.Errors.notifyError !== 'function') {
        console.error('[API] Error:', err);
        return;
      }

      const code = err?.code || cm_guessCode(err?.status || 0);
      const retriable = !!err?.retriable || cm_isRetriableStatus(err?.status || 0);

      // Endpoints bruyants avec connexion lente -> moins de notifications
      const noisyEndpoint = endpoint === '/status' || endpoint === '/reserve';
      if (noisyEndpoint && retriable && connectionQuality === 'slow') {
        return;
      }

      const key = `${endpoint}|${code}|${err?.status||''}`;
      const now = Date.now();
      const last = __notifySeen.get(key);
      if (last && (now - last) < NOTIFY_COOLDOWN_MS) return;
      __notifySeen.set(key, now);

      window.Errors.notifyError(err, `API ${endpoint}`);
    } catch {}
  }

  function cm_backoff(attempt, connectionQuality = 'unknown'){
    let base = 300 * Math.pow(2, Math.max(0, attempt));
    
    // Adapter le backoff selon la qualité de connexion
    if (connectionQuality === 'slow') base *= 2;
    else if (connectionQuality === 'fast') base *= 0.5;
    
    const jitter = Math.floor(Math.random() * 200);
    return new Promise(res => setTimeout(res, base + jitter));
  }

  // ===================
  // OPTIMISATION 4: Cache intelligent
  // ===================
  function getCacheKey(endpoint, options = {}) {
    const method = options.method || 'GET';
    const body = options.body || '';
    return `${method}:${endpoint}:${btoa(body).slice(0, 20)}`;
  }

  function getCachedResponse(endpoint, options = {}) {
    if (!CACHE_ENDPOINTS.includes(endpoint)) return null;
    
    const key = getCacheKey(endpoint, options);
    const cached = requestCache.get(key);
    
    if (!cached) return null;
    
    const ttl = CACHE_TTL[endpoint] || 5000;
    const age = Date.now() - cached.timestamp;
    
    if (age > ttl) {
      requestCache.delete(key);
      return null;
    }
    
    console.log(`[Cache] Hit for ${endpoint} (age: ${age}ms)`);
    return cached.response;
  }

  function setCachedResponse(endpoint, options = {}, response) {
    if (!CACHE_ENDPOINTS.includes(endpoint)) return;
    
    const key = getCacheKey(endpoint, options);
    requestCache.set(key, {
      response: JSON.parse(JSON.stringify(response)), // Deep clone
      timestamp: Date.now()
    });
    
    // Limiter la taille du cache
    if (requestCache.size > 50) {
      const oldestKey = requestCache.keys().next().value;
      requestCache.delete(oldestKey);
    }
  }

  function cm_normalizeNetworkError(e){
    if (e && (e.name === 'AbortError' || /aborted/i.test(e.message||''))) {
      if (window.Errors) return window.Errors.create('TIMEOUT', 'Request timeout', { status: 0, retriable: true });
      const err = new Error('Request timeout'); err.code='TIMEOUT'; err.status=0; return err;
    }
    
    const offline = typeof navigator !== 'undefined' && navigator && navigator.onLine === false;
    if (offline) {
      if (window.Errors) return window.Errors.create('OFFLINE', 'Network offline', { status: 0, retriable: true });
      const err = new Error('Network offline'); err.code='OFFLINE'; err.status=0; return err;
    }
    
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
  // OPTIMISATION 5: UID Manager optimisé
  // ===================
  class UIDManager {
    constructor() {
      this.KEY = 'iw_uid';
      this._uid = null;
    }

    get uid() {
      if (this._uid) return this._uid;

      let stored = null;
      try {
        stored = localStorage.getItem(this.KEY);
      } catch (e) {
        console.warn('[UID] localStorage inaccessible');
      }

      if (stored && stored.length > 0) {
        this._uid = stored;
        window.uid = this._uid;
        return this._uid;
      }

      this._uid = this._generateUID();
      try {
        localStorage.setItem(this.KEY, this._uid);
      } catch (e) {
        console.warn('[UID] Impossible de sauvegarder');
      }

      window.uid = this._uid;
      return this._uid;
    }

    _generateUID() {
      if (window.crypto && window.crypto.randomUUID) {
        return crypto.randomUUID();
      }

      if (window.crypto && window.crypto.getRandomValues) {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return Array.from(arr, byte => byte.toString(16).padStart(2, '0')).join('');
      }

      return Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
  }

  // ===================
  // OPTIMISATION 6: API Manager avec cache et retry adaptatif
  // ===================
  class APIManager {
    constructor(uidManager) {
      this.uidManager = uidManager;
      this.BASE_URL = '/.netlify/functions';
      this.MAX_RETRIES = 2;
      
      // Statistiques de performance
      this.stats = {
        requests: 0,
        cacheHits: 0,
        errors: 0,
        avgResponseTime: 0
      };
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

    async _buildHeaders(options = {}) {
      const authHeaders = await this.getAuthHeaders();
      const isForm = options.body && (options.body instanceof FormData);

      const headers = {
        ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders,
        ...(options.headers || {})
      };

      try {
        const uid = (this.uidManager && this.uidManager.uid) || (window.CoreManager && window.CoreManager.uid);
        if (uid && !headers['X-Client-UID']) headers['X-Client-UID'] = uid;
      } catch {}

      return headers;
    }

    async _fetchWithTimeout(url, config) {
      if (!adaptiveTimeout) {
        return fetch(url, config);
      }
      
      const ctl = new AbortController();
      const timeout = setTimeout(() => ctl.abort(), adaptiveTimeout);
      
      try {
        const res = await fetch(url, { ...config, signal: ctl.signal });
        clearTimeout(timeout);
        return res;
      } catch (e) {
        clearTimeout(timeout);
        throw e;
      }
    }

    async call(endpoint, options = {}) {
      const startTime = performance.now();
      this.stats.requests++;

      // Vérifier le cache en premier
      const cached = getCachedResponse(endpoint, options);
      if (cached) {
        this.stats.cacheHits++;
        return cached;
      }

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

          // 401 handling
          if (response.status === 401 && !refreshedOnce && window.AuthUtils) {
            console.warn('[API] Token expired, refreshing...');
            try {
              localStorage.removeItem('iw_jwt');
              const newAuthHeaders = await this.getAuthHeaders();
              baseConfig.headers = { ...baseConfig.headers, ...newAuthHeaders };
              refreshedOnce = true;
              continue;
            } catch (e) {
              console.error('[API] Auth refresh failed:', e);
            }
          }

          const contentType = response.headers.get && response.headers.get('content-type') || '';
          const isJson = contentType.includes('application/json');

          let payload = null;
          try { 
            payload = isJson ? await response.json() : await response.text(); 
          } catch {}

          if (!response.ok) {
            if (cm_isRetriableStatus(response.status) && attempt < CORE_RETRIES) {
              attempt++;
              await cm_backoff(attempt, connectionQuality);
              continue;
            }
            
            this.stats.errors++;
            const httpErr = cm_httpError(response.status, isJson ? (payload || {}) : { error: String(payload || `HTTP ${response.status}`) });
            cm_notifyOnce(httpErr, endpoint);
            return isJson ? (payload || null) : null;
          }

          // Succès - mettre en cache si applicable
          const result = payload !== undefined ? payload : null;
          if (result && isJson) {
            setCachedResponse(endpoint, options, result);
          }

          // Mise à jour des statistiques
          const duration = performance.now() - startTime;
          this.stats.avgResponseTime = (this.stats.avgResponseTime + duration) / 2;

          return result;

        } catch (e) {
          const ne = cm_normalizeNetworkError(e);
          if (cm_isRetriableStatus(ne.status || 0) && attempt < CORE_RETRIES) {
            attempt++;
            console.warn(`[API] Attempt ${attempt} failed (transient):`, ne);
            await cm_backoff(attempt, connectionQuality);
            continue;
          }
          
          this.stats.errors++;
          cm_notifyOnce(ne, endpoint);
          return null;
        }
      }

      return null;
    }

    async callMultipart(endpoint, formData, options = {}) {
      // Multipart ne peut pas être mis en cache facilement
      const startTime = performance.now();
      this.stats.requests++;

      const url = `${this.BASE_URL}${endpoint}`;
      const headers = await this._buildHeaders({ ...(options || {}), body: formData });
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
          try { 
            payload = isJson ? await response.json() : await response.text(); 
          } catch {}

          if (!response.ok) {
            if (cm_isRetriableStatus(response.status) && attempt < CORE_RETRIES) {
              attempt++;
              await cm_backoff(attempt, connectionQuality);
              continue;
            }
            
            this.stats.errors++;
            const httpErr = cm_httpError(response.status, isJson ? (payload || {}) : { error: String(payload || `HTTP ${response.status}`) });
            cm_notifyOnce(httpErr, endpoint);
            return isJson ? (payload || null) : null;
          }

          const duration = performance.now() - startTime;
          this.stats.avgResponseTime = (this.stats.avgResponseTime + duration) / 2;

          return payload !== undefined ? payload : null;

        } catch (e) {
          const ne = cm_normalizeNetworkError(e);
          if (cm_isRetriableStatus(ne.status || 0) && attempt < CORE_RETRIES) {
            attempt++;
            console.error(`[API] Multipart attempt ${attempt} failed (transient):`, ne);
            await cm_backoff(attempt, connectionQuality);
            continue;
          }
          
          this.stats.errors++;
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

      try {
        const uid = (this.uidManager && this.uidManager.uid) || (window.CoreManager && window.CoreManager.uid);
        if (uid && !headers['X-Client-UID']) headers['X-Client-UID'] = uid;
      } catch {}

      return await fetch(url, {
        ...options,
        headers,
        credentials: 'same-origin'
      });
    }

    // OPTIMISATION 7: Méthode pour vider le cache
    clearCache() {
      requestCache.clear();
      console.log('[CoreManager] Cache cleared');
    }

    // OPTIMISATION 8: Méthode pour obtenir les statistiques
    getStats() {
      return {
        ...this.stats,
        cacheSize: requestCache.size,
        cacheHitRate: this.stats.requests > 0 ? (this.stats.cacheHits / this.stats.requests * 100).toFixed(1) + '%' : '0%',
        connectionQuality,
        adaptiveTimeout
      };
    }
  }

  // ===================
  // OPTIMISATION 9: Initialisation
  // ===================
  const uidManager = new UIDManager();
  const apiManager = new APIManager(uidManager);

  // Exports globaux pour compatibilité
  window.CoreManager = {
    uid: uidManager.uid,
    apiCall: (endpoint, options) => apiManager.call(endpoint, options),
    apiCallMultipart: (endpoint, formData, options) => apiManager.callMultipart(endpoint, formData, options),
    apiCallRaw: (endpoint, options) => apiManager.callRaw(endpoint, options),
    clearCache: () => apiManager.clearCache(),
    getStats: () => apiManager.getStats()
  };

  // Compatibilité avec l'ancien système
  window.uid = uidManager.uid;
  window.apiCall = window.CoreManager.apiCall;
  window.apiCallMultipart = window.CoreManager.apiCallMultipart;
  window.apiCallRaw = window.CoreManager.apiCallRaw;

  // OPTIMISATION 10: Nettoyage périodique du cache
  setInterval(() => {
    if (requestCache.size > 30) {
      const now = Date.now();
      for (const [key, cached] of requestCache.entries()) {
        const endpoint = key.split(':')[1];
        const ttl = CACHE_TTL[endpoint] || 5000;
        if (now - cached.timestamp > ttl) {
          requestCache.delete(key);
        }
      }
    }
  }, 30000);

  // OPTIMISATION 11: Logging de performance
  if (typeof performance !== 'undefined') {
    setInterval(() => {
      const stats = apiManager.getStats();
      if (stats.requests > 0) {
        console.log(`[CoreManager] Stats - Requests: ${stats.requests}, Cache hits: ${stats.cacheHitRate}, Avg response: ${stats.avgResponseTime.toFixed(1)}ms`);
      }
    }, 60000);
  }

  // OPTIMISATION 12: Préchargement intelligent pour endpoints critiques
  function preloadCriticalEndpoints() {
    // Précharger /status en arrière-plan si on n'a pas de données récentes
    const statusCached = getCachedResponse('/status');
    if (!statusCached) {
      apiManager.call('/status').catch(() => {
        // Échec silencieux pour le préchargement
      });
    }
  }

  // OPTIMISATION 13: API de diagnostic pour développement
  if (typeof window !== 'undefined') {
    window.__debugCoreManager = {
      getCache: () => Array.from(requestCache.entries()),
      clearCache: () => apiManager.clearCache(),
      getStats: () => apiManager.getStats(),
      getConnectionQuality: () => ({
        quality: connectionQuality,
        adaptiveTimeout
      }),
      forceConnectionTest: () => detectConnectionQuality()
    };
  }

  console.log('[CoreManager] Optimized version initialized with UID:', uidManager.uid);
})();