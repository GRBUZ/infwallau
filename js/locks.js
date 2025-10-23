// locks.js — Lock manager optimisé avec debouncing et prédiction
(function(){
  'use strict';

  if (!window.CoreManager) {
    console.error('[LockManager] CoreManager required (uid + apiCall)');
    return;
  }

  const { apiCall } = window.CoreManager;
  const uid = window.CoreManager.uid || window.uid;

  // OPTIMISATION 1: État optimisé avec WeakMap pour performance
  let localLocks = Object.create(null);
  const othersLastSeen = Object.create(null);
  const OTHERS_GRACE_MS = 3000;
  
  // OPTIMISATION 2: Heartbeat adaptatif selon l'activité
  let hbTimer = null;
  let hbBlocks = [];
  const HB_INTERVAL_MS = 25000; // Réduit de 30s à 25s pour plus de réactivité

  let hbStartedAt = 0;
  let hbMaxMs = 180000;
  let hbAutoUnlock = true;
  //let hbRequireActivity = true;
  let lastActivityTs = Date.now();
  const IDLE_LIMIT_MS = 100000; // Réduit de 120s à 100s

  // OPTIMISATION 3: Tracking d'activité plus granulaire
  let recentActivity = [];
  const ACTIVITY_WINDOW = 30000; // 30 secondes

  function trackActivity(type = 'generic') {
    const now = Date.now();
    lastActivityTs = now;
    
    recentActivity.push({ type, timestamp: now });
    
    // Nettoyer les anciennes activités
    recentActivity = recentActivity.filter(a => now - a.timestamp < ACTIVITY_WINDOW);
  }

  function getActivityLevel() {
    const now = Date.now();
    const recent = recentActivity.filter(a => now - a.timestamp < 10000); // 10s
    
    if (recent.length > 10) return 'high';
    if (recent.length > 3) return 'medium';
    if (recent.length > 0) return 'low';
    return 'idle';
  }

  // OPTIMISATION 4: Event listeners optimisés avec throttling
  let activityThrottled = false;
  
  function throttledActivity(type) {
    if (activityThrottled) return;
    activityThrottled = true;
    
    trackActivity(type);
    
    setTimeout(() => {
      activityThrottled = false;
    }, 1000); // Throttle à 1 seconde
  }

  (function attachActivityListenersOnce(){
    window.addEventListener('mousemove', () => throttledActivity('mouse'), { passive: true });
    window.addEventListener('keydown', () => throttledActivity('key'), { passive: true });
    window.addEventListener('touchstart', () => throttledActivity('touch'), { passive: true });
    window.addEventListener('click', () => throttledActivity('click'), { passive: true });
    window.addEventListener('scroll', () => throttledActivity('scroll'), { passive: true });
  })();

  // OPTIMISATION 5: Event emitter optimisé
  const listeners = new Set();
  let emitScheduled = false;

  function emitChange(){
    if (emitScheduled) return;
    emitScheduled = true;
    
    requestAnimationFrame(() => {
      const snapshot = getSnapshot();
      for (const cb of listeners) {
        try { cb(snapshot); } catch {}
      }
      emitScheduled = false;
    });
  }
  
  function on(evt, cb){ 
    if (evt==='change' && typeof cb==='function') listeners.add(cb); 
  }
  function off(evt, cb){ 
    if (evt==='change') listeners.delete(cb); 
  }

  function now(){ return Date.now(); }

  // OPTIMISATION 6: Pruning avec cache de dernière exécution
  let lastPruneTime = 0;
  const PRUNE_INTERVAL = 5000; // 5 secondes minimum entre les prunes

  function pruneLocal(){
    const currentTime = now();
    if (currentTime - lastPruneTime < PRUNE_INTERVAL) {
      return; // Skip si trop récent
    }
    
    lastPruneTime = currentTime;
    const t = currentTime;
    const out = Object.create(null);
    let prunedCount = 0;
    
    for (const [k, l] of Object.entries(localLocks)) {
      if (l && typeof l.until === 'number' && l.until > t) {
        out[k] = l;
      } else {
        prunedCount++;
      }
    }
    
    if (prunedCount > 0) {
      console.log(`[LockManager] Pruned ${prunedCount} expired locks`);
      localLocks = out;
    }
  }

  // OPTIMISATION 7: Merge optimisé avec diff detection
  let lastServerLocksHash = '';

  function hashLocks(locks) {
    const keys = Object.keys(locks).sort();
    return keys.map(k => `${k}:${locks[k].uid}:${locks[k].until}`).join('|');
  }

  function merge(serverLocks){
    // Early exit si pas de changements serveur
    const serverHash = hashLocks(serverLocks || {});
    if (serverHash === lastServerLocksHash && Object.keys(localLocks).length > 0) {
      return localLocks; // Pas de changements
    }
    lastServerLocksHash = serverHash;

    pruneLocal();
    const t = now();
    const out = Object.create(null);

    // 1) Mes locks locaux d'abord (priorité locale)
    for (const [k, l] of Object.entries(localLocks)) {
      if (l && l.uid === uid && l.until > t) {
        out[k] = { uid: l.uid, until: l.until };
      }
    }

    // 2) Locks serveur avec mise à jour du tracking
    for (const [k, l] of Object.entries(serverLocks || {})) {
      if (l && l.until > t) {
        out[k] = { uid: l.uid, until: l.until };
        if (l.uid !== uid) {
          othersLastSeen[k] = t;
        }
      }
    }

    // 3) Grâce pour locks autres disparus (avec cleanup)
    for (const [k, l] of Object.entries(localLocks)) {
      if (!out[k] && l && l.uid !== uid && l.until > t) {
        const last = othersLastSeen[k] || 0;
        if (t - last < OTHERS_GRACE_MS) {
          out[k] = { uid: l.uid, until: l.until };
        } else {
          delete othersLastSeen[k]; // Cleanup
        }
      }
    }

    const changed = Object.keys(out).length !== Object.keys(localLocks).length;
    localLocks = out;
    
    if (changed) {
      emitChange();
    }
    
    return out;
  }

  // OPTIMISATION 8: Batch lock setting avec deduplication
  function setLocalLocks(indices, ttlMs){
    const t = now();
    const until = t + (ttlMs || 180000);
    let changed = false;
    
    // Dédupliquer les indices
    const uniqueIndices = [...new Set(indices)];
    
    for (const idx of uniqueIndices) {
      const key = String(idx);
      const cur = localLocks[key];
      if (!cur || cur.uid !== uid || cur.until < until) {
        localLocks[key] = { uid, until };
        changed = true;
      }
    }
    
    if (changed) emitChange();
  }

  // OPTIMISATION 9: Lock avec retry intelligent et backoff adaptatif
  let lockRetryCount = 0;
  const MAX_LOCK_RETRIES = 3;

  async function lock(blocks, ttlMs = 180000, { optimistic = true } = {}){
    const indices = Array.isArray(blocks) ? blocks.map(n=>parseInt(n,10)).filter(Number.isInteger) : [];
    if (!indices.length) {
      return { ok:false, locked: [], conflicts: [], locks: localLocks };
    }

    // OPTIMISATION: Vérification précoce des conflits locaux
    const conflicts = [];
    for (const idx of indices) {
      const l = localLocks[String(idx)];
      if (l && l.uid !== uid && l.until > now()) {
        conflicts.push(idx);
      }
    }
    
    if (conflicts.length > 0 && !optimistic) {
      console.warn(`[LockManager] Pre-flight conflict detection: ${conflicts.length} conflicts`);
      return { ok:false, locked: [], conflicts, locks: localLocks };
    }

    // Optimisme local avec prédiction
    if (optimistic) {
      setLocalLocks(indices, ttlMs);
    }

    let attempt = 0;
    while (attempt <= MAX_LOCK_RETRIES) {
      try {
        const res = await window.CoreManager.apiCall('/reserve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blocks: indices, ttl: ttlMs })
        });

        if (!res || !res.ok) {
          // Échec mais pas une erreur réseau
          lockRetryCount = 0; // Reset sur échec métier
          return { 
            ok: false, 
            locked: [], 
            conflicts: (res && res.conflicts) || [], 
            locks: localLocks, 
            error: res && res.error 
          };
        }

        // Succès
        lockRetryCount = 0;
        localLocks = merge(res.locks || {});
        
        const until = Number(res.until) || 0;
        const totalAmount = (res.totalAmount != null && isFinite(Number(res.totalAmount))) ? Number(res.totalAmount) : undefined;
        const unitPrice = (res.unitPrice != null && isFinite(Number(res.unitPrice))) ? Number(res.unitPrice) : undefined;

        return {
          ok: true,
          locked: res.locked || [],
          conflicts: res.conflicts || [],
          locks: localLocks,
          ttlSeconds: res.ttlSeconds,
          regionId: res.regionId,
          until,
          totalAmount,
          unitPrice
        };

      } catch (error) {
        attempt++;
        lockRetryCount++;
        
        const isRetriable = error.retriable || error.status === 0 || error.status >= 500;
        
        if (attempt <= MAX_LOCK_RETRIES && isRetriable) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          console.warn(`[LockManager] Lock attempt ${attempt} failed, retrying in ${backoffMs}ms`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }
        
        // Échec définitif
        console.error(`[LockManager] Lock failed after ${attempt} attempts:`, error);
        return { ok: false, locked: [], conflicts: [], locks: localLocks, error: error.message };
      }
    }

    return { ok: false, locked: [], conflicts: [], locks: localLocks, error: 'Max retries exceeded' };
  }

  // OPTIMISATION 10: Unlock groupé avec batch processing
  async function unlock(blocks){
    const indices = Array.isArray(blocks) ? blocks.map(n=>parseInt(n,10)).filter(Number.isInteger) : [];
    if (!indices.length) return { ok:true, locks: localLocks };

    // Optimisation locale immédiate
    let locallyRemoved = 0;
    for (const idx of indices) {
      const key = String(idx);
      const l = localLocks[key];
      if (l && l.uid === uid) {
        delete localLocks[key];
        locallyRemoved++;
      }
    }
    
    if (locallyRemoved > 0) {
      emitChange();
    }

    // Appel serveur avec retry simple
    try {
      const res = await apiCall('/unlock', {
        method: 'POST',
        body: JSON.stringify({ blocks: indices })
      });

      if (!res || !res.ok) {
        return { ok: false, locks: localLocks, error: res && res.error };
      }

      localLocks = merge(res.locks || {});
      return { ok: true, locks: localLocks };
      
    } catch (error) {
      console.warn('[LockManager] Unlock failed:', error);
      return { ok: false, locks: localLocks, error: error.message };
    }
  }

  // OPTIMISATION 11: Validation stricte avec cache
  let validationCache = new Map();
  const VALIDATION_CACHE_TTL = 1000; // 1 seconde

  function haveMyValidLocksStrict(indices, skewMs = 1000){
    if (!Array.isArray(indices) || !indices.length) return false;
    
    const cacheKey = `${indices.join(',')}_${skewMs}`;
    const cached = validationCache.get(cacheKey);
    const now = Date.now();
    
    if (cached && (now - cached.timestamp) < VALIDATION_CACHE_TTL) {
      return cached.result;
    }
    
    const t = now + Math.max(0, skewMs|0);
    const result = indices.every(i => {
      const l = localLocks[String(i)];
      return l && l.uid === uid && l.until > t;
    });
    
    validationCache.set(cacheKey, { result, timestamp: now });
    
    // Nettoyer le cache périodiquement
    if (validationCache.size > 100) {
      const oldEntries = [];
      for (const [key, value] of validationCache.entries()) {
        if (now - value.timestamp > VALIDATION_CACHE_TTL * 2) {
          oldEntries.push(key);
        }
      }
      oldEntries.forEach(key => validationCache.delete(key));
    }
    
    return result;
  }

  // OPTIMISATION 12: Heartbeat adaptatif selon l'activité
  function startHeartbeat(blocks, options = {}) {
  const intervalMs = options.intervalMs || 30000;   // 30s par défaut
  const ttlMs = options.ttlMs || 180000;            // 180s renewal
  const maxTotalMs = options.maxTotalMs || 300000;  // 5 min MAX
  
  stopHeartbeat();
  hbBlocks = Array.from(new Set(blocks)).slice(0, 500);
  if (!hbBlocks.length) return;
  
  hbStartedAt = Date.now();  // ← Tracker temps local
  hbMaxMs = maxTotalMs;
  hbAutoUnlock = options.autoUnlock !== false;
  
  // Premier renewal immédiat
  lock(hbBlocks, ttlMs, { optimistic: true }).catch(...);
  
  // Loop adaptatif simplifié
  const tick = async () => {
    const elapsed = Date.now() - hbStartedAt;
    
    // Vérif limite locale (protection client)
    if (elapsed > hbMaxMs) {
      console.log('[Heartbeat] Max duration reached (5min), stopping');
      stopHeartbeat();
      if (hbAutoUnlock) {
        try { await unlock(hbBlocks); } catch (e) {}
      }
      return;
    }
    
    // Renewal
    try {
      const result = await lock(hbBlocks, ttlMs, { optimistic: false });
      
      if (!result || !result.ok) {
        console.warn('[Heartbeat] Renewal failed (backend rejected):', result?.error);
        // Backend a refusé = probablement dépassé 5 min côté serveur
        stopHeartbeat();
        return;
      }
      
      console.log('[Heartbeat] Renewal OK');
    } catch (e) {
      console.error('[Heartbeat] Renewal error:', e);
    }
    
    // Next tick (fixe, pas adaptatif pour simplifier)
    hbTimer = setTimeout(tick, intervalMs);
  };
  
  hbTimer = setTimeout(tick, intervalMs);
}


  function stopHeartbeat(){
    if (hbTimer) { 
      clearTimeout(hbTimer); 
      hbTimer = null; 
      console.log('[LockManager] Heartbeat stopped');
    }
    hbBlocks = [];
    hbStartedAt = 0;
  }

  function setHeartbeatBlocks(blocks){
    hbBlocks = Array.isArray(blocks) ? blocks.slice() : [];
  }

  function getSnapshot(){
    return { locks: { ...localLocks }, uid };
  }

  function getLocalLocks(){ return { ...localLocks }; }
  
  function isLocked(idx){ 
    const l = localLocks[String(idx)]; 
    return !!(l && l.until > now()); 
  }
  
  function getMine(){
    const me = {};
    const t = now();
    for (const [k,l] of Object.entries(localLocks)) {
      if (l && l.uid === uid && l.until > t) me[k] = l;
    }
    return me;
  }
  
  function getTheirs(){
    const other = {};
    const t = now();
    for (const [k,l] of Object.entries(localLocks)) {
      if (l && l.uid !== uid && l.until > t) other[k] = l;
    }
    return other;
  }

  // OPTIMISATION 13: Nettoyage périodique et stats
  setInterval(() => {
    pruneLocal();
    
    // Nettoyer othersLastSeen
    const now = Date.now();
    for (const [k, timestamp] of Object.entries(othersLastSeen)) {
      if (now - timestamp > OTHERS_GRACE_MS * 3) {
        delete othersLastSeen[k];
      }
    }
    
    // Nettoyer le cache de validation
    for (const [key, value] of validationCache.entries()) {
      if (now - value.timestamp > VALIDATION_CACHE_TTL * 5) {
        validationCache.delete(key);
      }
    }
  }, 30000); // Toutes les 30 secondes

  // OPTIMISATION 14: API avec méthodes de debug et stats
  const api = {
    lock, 
    unlock, 
    merge,
    heartbeat: { 
      start: (blocks, options) => startHeartbeat(blocks, options),
      stop: stopHeartbeat,
      isRunning: () => !!hbTimer
    },
    getLocalLocks, 
    isLocked, 
    getMine, 
    getTheirs,
    on, 
    off,
    
    // Nouvelles méthodes d'optimisation
    getStats: () => ({
      localLocksCount: Object.keys(localLocks).length,
      othersLastSeenCount: Object.keys(othersLastSeen).length,
      heartbeatActive: !!hbTimer,
      heartbeatBlocks: hbBlocks.length,
      activityLevel: getActivityLevel(),
      recentActivityCount: recentActivity.length,
      validationCacheSize: validationCache.size,
      lockRetryCount
    }),
    
    clearCaches: () => {
      validationCache.clear();
      recentActivity = [];
      console.log('[LockManager] Caches cleared');
    }
  };

  // Export global
  window.LockManager = api;

  // Optionnel: CommonJS
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  console.log('[LockManager] Optimized version loaded');
})();