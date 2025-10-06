// core-manager.js — Optimisé avec cache intelligent, retry adaptatif et gestion offline robuste
(function() {
  'use strict';

  const CORE_TIMEOUT_MS = 15000;
  const CORE_RETRIES = 2;
  
  const CACHE_ENDPOINTS = ['/status', '/diag'];
  const CACHE_TTL = {
    '/status': 1500,
    '/diag': 30000
  };
  
  const requestCache = new Map();
  
  const NOTIFY_COOLDOWN_MS = 6000;
  const __notifySeen = new Map();
  let __offlineFirstNotified = false;

  let connectionQuality = 'unknown';
  let adaptiveTimeout = CORE_TIMEOUT_MS;
  let avgResponseTime = 1000; // [PATCH] mesure moyenne mobile du RTT

  function detectConnectionQuality() {
    if (navigator.connection) {
      const conn = navigator.connection;
      const downlink = conn.downlink || 0;
      const effectiveType = conn.effectiveType || '';
      
      if (downlink > 2 || effectiveType.includes('4g')) {
        connectionQuality = 'fast';
        adaptiveTimeout = 12000;
      } else if (downlink > 0.5 || effectiveType.includes('3g')) {
        connectionQuality = 'slow';
        adaptiveTimeout = 25000;
      } else {
        connectionQuality = 'very-slow';
        adaptiveTimeout = 40000;
      }
      
      console.log(`[CoreManager] Connection: ${connectionQuality} (${downlink}Mbps, ${effectiveType})`);
    }
  }

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
    if (window.CoreManager?._apiManager) {
      window.CoreManager._apiManager.isOffline = false;
    }
    console.log('[CoreManager] Back online – resuming API calls');
  });

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
          window.Errors.showToast('Network offline. Changes will sync when you are back online.', 'warn', 3500);
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
    if (connectionQuality === 'slow') base *= 2;
    else if (connectionQuality === 'very-slow') base *= 3;
    else if (connectionQuality === 'fast') base *= 0.5;
    const jitter = Math.floor(Math.random() * 200);
    return new Promise(res => setTimeout(res, base + jitter));
  }

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
      response: JSON.parse(JSON.stringify(response)),
      timestamp: Date.now()
    });
    if (requestCache.size > 50) {
      const oldestKey = requestCache.keys().next().value;
      requestCache.delete(oldestKey);
    }
  }

  function cm_normalizeNetworkError(e){
    if (e && (e.name === 'AbortError' || /aborted/i.test(e.message||''))) {
      const err = new Error('Request timeout'); err.code='TIMEOUT'; err.status=0; err.retriable=true; return err;
    }
    if (navigator.onLine === false) {
      const err = new Error('Network offline'); err.code='OFFLINE'; err.status=0; err.retriable=true; return err;
    }
    if (e instanceof TypeError || /Failed to fetch|NetworkError|load failed/i.test(e?.message||'')) {
      const err = new Error('Network error'); err.code='NETWORK_ERROR'; err.status=0; err.retriable=true; return err;
    }
    return e;
  }

  function cm_httpError(status, payload){
    const code = cm_guessCode(status);
    const msg = (payload && (payload.message || payload.error)) || `HTTP ${status}`;
    const e = new Error(msg); e.code = code; e.status = status; e.retriable = cm_isRetriableStatus(status);
    return e;
  }

  class UIDManager {
    constructor() {
      this.KEY = 'iw_uid';
      this._uid = null;
    }
    get uid() {
      if (this._uid) return this._uid;
      let stored = null;
      try { stored = localStorage.getItem(this.KEY); } catch {}
      if (stored && stored.length > 0) {
        this._uid = stored;
        window.uid = this._uid;
        return this._uid;
      }
      this._uid = this._generateUID();
      try { localStorage.setItem(this.KEY, this._uid); } catch {}
      window.uid = this._uid;
      return this._uid;
    }
    _generateUID() {
      if (crypto.randomUUID) return crypto.randomUUID();
      if (crypto.getRandomValues) {
        const arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
        return Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
      }
      return Date.now().toString(36)+Math.random().toString(36).slice(2);
    }
  }

  class APIManager {
    constructor(uidManager) {
      this.uidManager = uidManager;
      this.BASE_URL = '/.netlify/functions';
      this.MAX_RETRIES = 2;
      this.isOffline = false;
      this.stats = { requests:0, cacheHits:0, errors:0, avgResponseTime:0 };
    }

    async getAuthHeaders() {
      if (!window.AuthUtils) return {};
      try { return await window.AuthUtils.getAuthHeaders(); }
      catch { return {}; }
    }

    async _buildHeaders(options = {}) {
      const authHeaders = await this.getAuthHeaders();
      const isForm = options.body && (options.body instanceof FormData);
      const headers = { ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...authHeaders, ...(options.headers||{}) };
      try {
        const uid = this.uidManager?.uid || window.CoreManager?.uid;
        if (uid && !headers['X-Client-UID']) headers['X-Client-UID']=uid;
      } catch {}
      return headers;
    }

    // [PATCH] timeout adaptatif selon latence
    async _fetchWithTimeout(url, config) {
      const dynamicTimeout = Math.min(Math.max(adaptiveTimeout, avgResponseTime * 5), 45000);
      const ctl = new AbortController();
      const timeout = setTimeout(()=>ctl.abort(), dynamicTimeout);
      const start = performance.now();
      try {
        const res = await fetch(url, {...config, signal:ctl.signal});
        const duration = performance.now() - start;
        avgResponseTime = (avgResponseTime * 0.8) + (duration * 0.2);
        clearTimeout(timeout);
        return res;
      } catch(e){
        clearTimeout(timeout);
        throw e;
      }
    }

    async call(endpoint, options={}) {
      if (window.__OFFLINE || this.isOffline) {
        this.isOffline=true;
        console.warn(`[API] Offline → skip ${endpoint}`);
        await cm_backoff(1,'slow');
        return null;
      }
      const start=performance.now(); this.stats.requests++;
      const cached=getCachedResponse(endpoint,options); if(cached){this.stats.cacheHits++; return cached;}
      const url=`${this.BASE_URL}${endpoint}`;
      const headers=await this._buildHeaders(options);
      const baseConfig={...options,headers,credentials:'same-origin'};
      let attempt=0;
      while(attempt<=Math.max(this.MAX_RETRIES,CORE_RETRIES)){
        try{
          const response=await this._fetchWithTimeout(url,baseConfig);
          this.isOffline=false;
          const contentType=response.headers.get?.('content-type')||'';
          const isJson=contentType.includes('application/json');
          let payload=null; try{payload=isJson?await response.json():await response.text();}catch{}
          if(!response.ok){
            if(cm_isRetriableStatus(response.status)&&attempt<CORE_RETRIES){attempt++;await cm_backoff(attempt,connectionQuality);continue;}
            this.stats.errors++; const httpErr=cm_httpError(response.status,isJson?(payload||{}):{error:String(payload)}); cm_notifyOnce(httpErr,endpoint); return isJson?(payload||null):null;
          }
          const result=payload??null; if(result&&isJson) setCachedResponse(endpoint,options,result);
          const duration=performance.now()-start; this.stats.avgResponseTime=(this.stats.avgResponseTime+duration)/2;
          return result;
        }catch(e){
          const ne=cm_normalizeNetworkError(e);
          if(ne.code==='OFFLINE'||navigator.onLine===false){this.isOffline=true; cm_notifyOnce(ne,endpoint); return null;}
          if(cm_isRetriableStatus(ne.status||0)&&attempt<CORE_RETRIES){attempt++;await cm_backoff(attempt,connectionQuality);continue;}
          this.stats.errors++; cm_notifyOnce(ne,endpoint); return null;
        }
      } return null;
    }

    // (reste inchangé)
    async callMultipart(endpoint, formData, options={}) {
      if (window.__OFFLINE || this.isOffline) {
        this.isOffline=true;
        console.warn(`[API] Offline → skip upload ${endpoint}`);
        await cm_backoff(1,'slow');
        return null;
      }
      this.stats.requests++;
      const url=`${this.BASE_URL}${endpoint}`;
      const headers=await this._buildHeaders({...(options||{}),body:formData});
      const baseConfig={method:'POST',body:formData,headers,credentials:'same-origin',...options};
      let attempt=0;
      while(attempt<=Math.max(this.MAX_RETRIES,CORE_RETRIES)){
        try{
          const response=await this._fetchWithTimeout(url,baseConfig);
          this.isOffline=false;
          const contentType=response.headers.get?.('content-type')||''; const isJson=contentType.includes('application/json');
          let payload=null; try{payload=isJson?await response.json():await response.text();}catch{}
          if(!response.ok){
            if(cm_isRetriableStatus(response.status)&&attempt<CORE_RETRIES){attempt++;await cm_backoff(attempt,connectionQuality);continue;}
            this.stats.errors++; const httpErr=cm_httpError(response.status,isJson?(payload||{}):{error:String(payload)}); cm_notifyOnce(httpErr,endpoint); return isJson?(payload||null):null;
          }
          return payload??null;
        }catch(e){
          const ne=cm_normalizeNetworkError(e);
          if(ne.code==='OFFLINE'||navigator.onLine===false){this.isOffline=true; cm_notifyOnce(ne,endpoint); return null;}
          if(cm_isRetriableStatus(ne.status||0)&&attempt<CORE_RETRIES){attempt++;await cm_backoff(attempt,connectionQuality);continue;}
          this.stats.errors++; cm_notifyOnce(ne,endpoint); return null;
        }
      } return null;
    }

    async callRaw(endpoint, options={}) {
      if (window.__OFFLINE || this.isOffline) {
        this.isOffline=true;
        console.warn(`[API] Offline → skip raw ${endpoint}`);
        await cm_backoff(1,'slow');
        return null;
      }
      const url=`${this.BASE_URL}${endpoint}`;
      const authHeaders=await this.getAuthHeaders();
      const isForm=options.body&&(options.body instanceof FormData);
      const headers={...(options.body&&!isForm?{'Content-Type':'application/json'}:{}),...authHeaders,...(options.headers||{})};
      try{
        const uid=this.uidManager?.uid||window.CoreManager?.uid;
        if(uid&&!headers['X-Client-UID']) headers['X-Client-UID']=uid;
      }catch{}
      try{
        const res=await fetch(url,{...options,headers,credentials:'same-origin'}); this.isOffline=false; return res;
      }catch(e){
        const ne=cm_normalizeNetworkError(e);
        if(ne.code==='OFFLINE'){this.isOffline=true; cm_notifyOnce(ne,endpoint); return null;}
        throw ne;
      }
    }

    clearCache(){ requestCache.clear(); console.log('[CoreManager] Cache cleared'); }
    getStats(){ return {...this.stats, cacheSize:requestCache.size, cacheHitRate:this.stats.requests>0?(this.stats.cacheHits/this.stats.requests*100).toFixed(1)+'%':'0%', connectionQuality, adaptiveTimeout, avgResponseTime:avgResponseTime.toFixed(0)+'ms'}; }
  }

  const uidManager = new UIDManager();
  const apiManager = new APIManager(uidManager);

  window.CoreManager = {
    uid: uidManager.uid,
    apiCall: (e,o)=>apiManager.call(e,o),
    apiCallMultipart: (e,f,o)=>apiManager.callMultipart(e,f,o),
    apiCallRaw: (e,o)=>apiManager.callRaw(e,o),
    clearCache: ()=>apiManager.clearCache(),
    getStats: ()=>apiManager.getStats(),
    _apiManager: apiManager
  };

  window.uid = uidManager.uid;
  window.apiCall = window.CoreManager.apiCall;
  window.apiCallMultipart = window.CoreManager.apiCallMultipart;
  window.apiCallRaw = window.CoreManager.apiCallRaw;

  //patch pause status
    // [PATCH] Pause automatique du polling /status pendant les transactions ou uploads
  const originalApiCall = window.CoreManager.apiCall;
  const originalMultipart = window.CoreManager.apiCallMultipart;

  let statusPollingPaused = false;
  function pauseStatusPolling(why) {
    if (statusPollingPaused) return;
    statusPollingPaused = true;
    console.log(`[CoreManager] ⏸️ Polling /status paused (${why})`);
  }
  function resumeStatusPolling(why) {
    if (!statusPollingPaused) return;
    statusPollingPaused = false;
    console.log(`[CoreManager] ▶️ Polling /status resumed (${why})`);
  }

  // Wrapper intelligent
  window.CoreManager.apiCall = async (endpoint, options) => {
    if (endpoint === '/status' && statusPollingPaused) {
      // Ne pas spammer quand on est en transaction
      return null;
    }

    if (endpoint.includes('order') || endpoint.includes('upload') || endpoint.includes('paypal')) {
      pauseStatusPolling(endpoint);
      try {
        const res = await originalApiCall(endpoint, options);
        resumeStatusPolling(endpoint);
        return res;
      } catch (e) {
        resumeStatusPolling(endpoint);
        throw e;
      }
    }

    return await originalApiCall(endpoint, options);
  };

  window.CoreManager.apiCallMultipart = async (endpoint, formData, options) => {
    pauseStatusPolling('upload');
    try {
      const res = await originalMultipart(endpoint, formData, options);
      resumeStatusPolling('upload');
      return res;
    } catch (e) {
      resumeStatusPolling('upload');
      throw e;
    }
  };

  //patch pause status
  console.log('[CoreManager] Optimized version initialized with UID:', uidManager.uid);
})();
