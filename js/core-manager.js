// core-manager.js — Gestionnaire centralisé pour UID, Auth et API calls
(function() {
  'use strict';
  
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
      this.MAX_RETRIES = 2;
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
    
    async call(endpoint, options = {}) {
      const authHeaders = await this.getAuthHeaders();
      
      const headers = {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders,
        ...(options.headers || {})
      };
      
      const config = {
        ...options,
        headers,
        credentials: 'same-origin'
      };
      
      let attempt = 0;
      while (attempt <= this.MAX_RETRIES) {
        try {
          const response = await fetch(`${this.BASE_URL}${endpoint}`, config);
          
          // Gestion erreur 401 avec retry automatique
          if (response.status === 401 && attempt === 0 && window.AuthUtils) {
            console.warn('[API] Token expired, refreshing...');
            try {
              localStorage.removeItem('iw_jwt');
              const newAuthHeaders = await this.getAuthHeaders();
              config.headers = { ...config.headers, ...newAuthHeaders };
              attempt++;
              continue;
            } catch (e) {
              console.error('[API] Auth refresh failed:', e);
              break;
            }
          }
          
          return await response.json().catch(() => null);
        } catch (e) {
          console.error(`[API] Attempt ${attempt + 1} failed:`, e);
          if (attempt >= this.MAX_RETRIES) {
            return null;
          }
          attempt++;
        }
      }
      
      return null;
    }
    
    async callMultipart(endpoint, formData, options = {}) {
      const authHeaders = await this.getAuthHeaders();
      
      const headers = {
        ...authHeaders,
        ...(options.headers || {})
        // PAS de Content-Type pour FormData
      };
      
      const config = {
        method: 'POST',
        body: formData,
        headers,
        credentials: 'same-origin',
        ...options
      };
      
      try {
        const response = await fetch(`${this.BASE_URL}${endpoint}`, config);
        
        if (response.status === 401 && window.AuthUtils) {
          console.warn('[API] Token expired during upload, refreshing...');
          localStorage.removeItem('iw_jwt');
          const newAuthHeaders = await this.getAuthHeaders();
          config.headers = { ...config.headers, ...newAuthHeaders };
          
          const retryResponse = await fetch(`${this.BASE_URL}${endpoint}`, config);
          return await retryResponse.json().catch(() => null);
        }
        
        return await response.json().catch(() => null);
      } catch (e) {
        console.error('[API] Multipart call failed:', e);
        return null;
      }
    }
    
    async callRaw(endpoint, options = {}) {
      const authHeaders = await this.getAuthHeaders();
      
      const headers = {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...authHeaders,
        ...(options.headers || {})
      };
      
      return await fetch(`${this.BASE_URL}${endpoint}`, {
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