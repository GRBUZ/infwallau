// locks.js – Lock manager optimisé avec limite 5 min
(function(){
  'use strict';

  if (!window.CoreManager) {
    console.error('[LockManager] CoreManager required (uid + apiCall)');
    return;
  }

  const { apiCall } = window.CoreManager;
  const uid = window.CoreManager.uid || window.uid;

  // État optimisé
  let localLocks = Object.create(null);
  const othersLastSeen = Object.create(null);
  const OTHERS_GRACE_MS = 3000;
  
  // Heartbeat avec limite 5 min totale
  let hbTimer = null;
  let hbBlocks = [];
  let hbStartedAt = 0;
  let hbMaxMs = 300000;  // 5 min par défaut
  let hbAutoUnlock = true;
  const HB_INTERVAL_MS = 30000;  // 30s fixe

  // Tracking d'activité (conservé pour stats)
  let lastActivityTs = Date.now();
  let recentActivity = [];
  const ACTIVITY_WINDOW = 30000;

  function trackActivity(type = 'generic') {
    const now = Date.now();
    lastActivityTs = now;
    
    recentActivity.push({ type, timestamp: now });
    recentActivity = recentActivity.filter(a => now - a.timestamp < ACTIVITY_WINDOW);
  }

  function getActivityLevel() {
    const now = Date.now();
    const recent = recentActivity.filter(a => now - a.timestamp < 10000);
    
    if (recent.length > 10) return 'high';
    if (recent.length > 3) return 'medium';
    if (recent.length > 0) return 'low';
    return 'idle';
  }

  // Event listeners optimisés avec throttling
  let activityThrottled = false;
  
  function throttledActivity(type) {
    if (activityThrottled) return;
    activityThrottled = true;
    
    trackActivity(type);
    
    setTimeout(() => {
      activityThrottled = false;
    }, 1000);
  }

  (function attachActivityListenersOnce(){
    window.addEventListener('mousemove', () => throttledActivity('mouse'), { passive: true });
    window.addEventListener('keydown', () => throttledActivity('key'), { passive: true });
    window.addEventListener('touchstart', () => throttledActivity('touch'), { passive: true });
    window.addEventListener('click', () => throttledActivity('click'), { passive: true });
    window.addEventListener('scroll', () => throttledActivity('scroll'), { passive: true });
  })();

  // Event emitter optimisé
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

  // Pruning avec cache
  let lastPruneTime = 0;
  const PRUNE_INTERVAL = 5000;

  function pruneLocal(){
    const currentTime = now();
    if (currentTime - lastPruneTime < PRUNE_INTERVAL) {
      return;
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

  // Merge optimisé avec diff detection
  let lastServerLocksHash = '';

  function hashLocks(locks) {
    const keys = Object.keys(locks).sort();
    return keys.map(k => `${k}:${locks[k].uid}:${locks[k].until}`).join('|');
  }

  function merge(serverLocks){
    const serverHash = hashLocks(serverLocks || {});
    if (serverHash === lastServerLocksHash && Object.keys(localLocks).length > 0) {
      return localLocks;
    }
    lastServerLocksHash = serverHash;

    pruneLocal();
    const t = now();
    const out = Object.create(null);

    // Mes locks locaux d'abord
    for (const [k, l] of Object.entries(localLocks)) {
      if (l && l.uid === uid && l.until > t) {
        out[k] = { uid: l.uid, until: l.until };
      }
    }

    // Locks serveur
    for (const [k, l] of Object.entries(serverLocks || {})) {
      if (l && l.until > t) {
        out[k] = { uid: l.uid, until: l.until };
        if (l.uid !== uid) {
          othersLastSeen[k] = t;
        }
      }
    }

    // Grâce pour locks autres disparus
    for (const [k, l] of Object.entries(localLocks)) {
      if (!out[k] && l && l.uid !== uid && l.until > t) {
        const last = othersLastSeen[k] || 0;
        if (t - last < OTHERS_GRACE_MS) {
          out[k] = { uid: l.uid, until: l.until };
        } else {
          delete othersLastSeen[k];
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

  // Batch lock setting
  function setLocalLocks(indices, ttlMs){
    const t = now();
    const until = t + (ttlMs || 180000);
    let changed = false;
    
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

  // Lock avec retry intelligent
  let lockRetryCount = 0;
  const MAX_LOCK_RETRIES = 3;

  async function lock(blocks, ttlMs = 180000, { optimistic = true } = {}){
    const indices = Array.isArray(blocks) ? blocks.map(n=>parseInt(n,10)).filter(Number.isInteger) : [];
    if (!indices.length) {
      return { ok:false, locked: [], conflicts: [], locks: localLocks };
    }

    // Vérification précoce des conflits
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

    // Optimisme local
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
          lockRetryCount = 0;
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
        
        console.error(`[LockManager] Lock failed after ${attempt} attempts:`, error);
        return { ok: false, locked: [], conflicts: [], locks: localLocks, error: error.message };
      }
    }

    return { ok: false, locked: [], conflicts: [], locks: localLocks, error: 'Max retries exceeded' };
  }

  // Unlock groupé
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

  // Validation stricte avec cache
  let validationCache = new Map();
  const VALIDATION_CACHE_TTL = 1000;

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

  // ✅ HEARTBEAT SIMPLIFIÉ - 5 MIN MAX TOTAL
  function startHeartbeat(blocks, options = {}){
    stopHeartbeat();
    
    hbBlocks = Array.isArray(blocks) ? blocks.slice() : [];
    
    const MAX_HEARTBEAT_BLOCKS = 500;
    if (hbBlocks.length > MAX_HEARTBEAT_BLOCKS) {
      console.warn(`[LockManager] Clamping heartbeat to ${MAX_HEARTBEAT_BLOCKS} blocks`);
      hbBlocks = hbBlocks.slice(0, MAX_HEARTBEAT_BLOCKS);
    }

    if (!hbBlocks.length) return;

    const intervalMs = options.intervalMs || HB_INTERVAL_MS;
    const ttlMs = options.ttlMs || 180000;
    hbMaxMs = options.maxTotalMs || 300000;  // 5 min par défaut
    hbAutoUnlock = options.autoUnlock !== false;

    hbStartedAt = Date.now();
    lastActivityTs = Date.now();

    console.log(`[LockManager] Starting heartbeat: ${hbBlocks.length} blocks, ${hbMaxMs}ms max`);

    // Premier renouvellement optimiste
    lock(hbBlocks, ttlMs, { optimistic: true }).catch((e) => {
      console.warn('[LockManager] Initial heartbeat lock failed:', e);
    });

    // ✅ TICK SIMPLIFIÉ (pas d'adaptive, juste vérif limite)
    const tick = async () => {
      const elapsed = Date.now() - hbStartedAt;
      const blocksSnapshot = hbBlocks.slice();

      // ✅ VÉRIFICATION LIMITE 5 MIN TOTALE
      if (elapsed > hbMaxMs) {
        console.log(`[LockManager] Max duration reached (${hbMaxMs}ms), stopping`);
        stopHeartbeat();
        if (hbAutoUnlock && blocksSnapshot.length) { 
          try { await unlock(blocksSnapshot); } catch {} 
        }
        return;
      }

      // Renouvellement
      if (blocksSnapshot.length) {
        try {
          const result = await lock(blocksSnapshot, ttlMs, { optimistic: false });
          
          if (!result || !result.ok) {
            console.warn('[LockManager] Heartbeat renewal failed (backend rejected):', result?.error);
            // Backend a refusé = probablement dépassé 5 min côté serveur
            stopHeartbeat();
            return;
          }
          
          console.log('[LockManager] Heartbeat renewal OK');
        } catch (e) {
          console.warn('[LockManager] Heartbeat renewal error:', e);
        }
      }

      // Prochain tick (intervalle fixe)
      hbTimer = setTimeout(tick, intervalMs);
    };

    // Premier tick
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
  
  function isHeartbeatRunning(){
    return !!hbTimer;
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

  // Nettoyage périodique
  setInterval(() => {
    pruneLocal();
    
    const now = Date.now();
    for (const [k, timestamp] of Object.entries(othersLastSeen)) {
      if (now - timestamp > OTHERS_GRACE_MS * 3) {
        delete othersLastSeen[k];
      }
    }
    
    for (const [key, value] of validationCache.entries()) {
      if (now - value.timestamp > VALIDATION_CACHE_TTL * 5) {
        validationCache.delete(key);
      }
    }
  }, 30000);

  // ✅ API SIMPLIFIÉE
  const api = {
    lock, 
    unlock, 
    merge,
    heartbeat: { 
      start: startHeartbeat, 
      stop: stopHeartbeat, 
      setBlocks: setHeartbeatBlocks,
      isRunning: isHeartbeatRunning  // ← Nouveau
    },
    getLocalLocks, 
    isLocked, 
    getMine, 
    getTheirs,
    on, 
    off,
    
    getStats: () => ({
      localLocksCount: Object.keys(localLocks).length,
      othersLastSeenCount: Object.keys(othersLastSeen).length,
      heartbeatActive: !!hbTimer,
      heartbeatBlocks: hbBlocks.length,
      heartbeatElapsed: hbTimer ? Date.now() - hbStartedAt : 0,
      heartbeatMaxMs: hbMaxMs,
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

  window.LockManager = api;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  console.log('[LockManager] Loaded with 5min limit');
})();