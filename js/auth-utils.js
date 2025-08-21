// auth-utils.js — JWT auth légère sans modules
(function(){
  const JWT_EXPIRY_HOURS = 24;
  
  // Simple JWT encoder/decoder sans crypto (pour le frontend seulement)
  function base64UrlEncode(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  
  function base64UrlDecode(str) {
    str += '==='.slice(0, (4 - str.length % 4) % 4);
    return atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  }
  
  function getOrCreateToken() {
    const stored = localStorage.getItem('iw_jwt');
    if (stored) {
      try {
        const parts = stored.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(base64UrlDecode(parts[1]));
          // Vérifier si le token expire dans moins d'1h
          if (payload.exp && (payload.exp - Math.floor(Date.now() / 1000)) > 3600) {
            return stored;
          }
        }
      } catch (e) {
        console.warn('[AUTH] Invalid stored token, regenerating');
      }
    }
    
    // Créer un nouveau token
    return refreshToken();
  }
  
  async function refreshToken() {
    try {
      const uid = window.uid || localStorage.getItem('iw_uid');
      if (!uid) throw new Error('No UID available');
      
      const response = await fetch('/.netlify/functions/auth-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uid })
      });
      
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Token generation failed');
      
      localStorage.setItem('iw_jwt', data.token);
      return data.token;
    } catch (e) {
      console.error('[AUTH] Token refresh failed:', e);
      return null;
    }
  }
  
  function getAuthHeaders() {
    const token = getOrCreateToken();
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }
  
  // Export global
  window.AuthUtils = {
    getOrCreateToken,
    refreshToken,
    getAuthHeaders
  };
})();