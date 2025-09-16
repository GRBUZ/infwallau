// locks.js — Lock manager (merge local-wins + heartbeat + expirations) - VERSION CORRIGÉE
(function(){
  'use strict';

  if (!window.CoreManager) {
    console.error('[LockManager] CoreManager required (uid + apiCall)');
    return;
  }

  const { apiCall } = window.CoreManager;
  const uid = window.CoreManager.uid || window.uid;

  // State local des locks
  let localLocks = Object.create(null);
  const othersLastSeen = Object.create(null);
  const OTHERS_GRACE_MS = 3000;
  let hbTimer = null;
  let hbBlocks = [];
  const HB_INTERVAL_MS = 4000;

  // Limites simplifiées
  let hbStartedAt = 0;
  let hbMaxMs = 300000; // 5 minutes max
  let hbAutoUnlock = true;
  let lastActivityTs = Date.now();

  // Activity tracking
  const bump = () => { lastActivityTs = Date.now(); };
  window.addEventListener('mousemove', bump, { passive:true });
  window.addEventListener('keydown', bump, { passive:true });
  window.addEventListener('touchstart', bump, { passive:true });

  // Event emitter
  const listeners = new Set();
  function emitChange(){
    for (const cb of listeners) {
      try { cb(getSnapshot()); } catch {}
    }
  }
  function on(evt, cb){ if (evt==='change' && typeof cb==='function') listeners.add(cb); }
  function off(evt, cb){ if (evt==='change') listeners.delete(cb); }

  function now(){ return Date.now(); }

  function pruneLocal(){
    const t = now();
    const out = Object.create(null);
    for (const [k, l] of Object.entries(localLocks)) {
      if (l && typeof l.until === 'number' && l.until > t) {
        out[k] = l;
      }
    }
    localLocks = out;
  }

  function merge(serverLocks){
    pruneLocal();
    const t = now();
    const out = Object.create(null);

    // 1) Mes locks locaux valides en priorité
    for (const [k, l] of Object.entries(localLocks)) {
      if (l && l.uid === uid && l.until > t) {
        out[k] = { uid: l.uid, until: l.until };
      }
    }

    // 2) Locks serveur pour les autres + mise à jour "dernière vue"
    for (const [k, l] of Object.entries(serverLocks || {})) {
      if (l && l.until > t) {
        out[k] = { uid: l.uid, until: l.until };
        if (l.uid !== uid) othersLastSeen[k] = t;
      }
    }

    // 3) Grâce temporaire pour locks "autres" qui ont disparu
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

    localLocks = out;
    emitChange();
    return out;
  }

  function setLocalLocks(indices, ttlMs){
    const t = now();
    const until = t + (ttlMs || 180000);
    let changed = false;
    for (const idx of indices) {
      const key = String(idx);
      const cur = localLocks[key];
      if (!cur || cur.uid !== uid || cur.until < until) {
        localLocks[key] = { uid, until };
        changed = true;
      }
    }
    if (changed) emitChange();
  }

  async function lock(blocks, ttlMs = 180000, { optimistic = true } = {}){
    const indices = Array.isArray(blocks) ? blocks.map(n=>parseInt(n,10)).filter(Number.isInteger) : [];
    if (!indices.length) return { ok:false, locked: [], conflicts: [], locks: localLocks };

    // Optimisme local seulement si demandé
    if (optimistic) setLocalLocks(indices, ttlMs);

    try {
      const res = await apiCall('/reserve', {
        method: 'POST',
        body: JSON.stringify({ blocks: indices, ttl: ttlMs })
      });

      if (!res || !res.ok) {
        return { ok:false, locked: [], conflicts: (res && res.conflicts) || [], locks: localLocks, error: res && res.error };
      }

      // Merger avec la réponse serveur
      localLocks = merge(res.locks || {});
      return { ok:true, locked: res.locked || [], conflicts: res.conflicts || [], locks: localLocks, ttlSeconds: res.ttlSeconds };
    } catch (error) {
      console.error('[LockManager] lock() failed:', error);
      return { ok:false, locked: [], conflicts: [], locks: localLocks, error: error.message };
    }
  }

  async function unlock(blocks){
    const indices = Array.isArray(blocks) ? blocks.map(n=>parseInt(n,10)).filter(Number.isInteger) : [];
    if (!indices.length) return { ok:true, locks: localLocks };

    try {
      const res = await apiCall('/unlock', {
        method: 'POST',
        body: JSON.stringify({ blocks: indices })
      });

      // Retirer localement mes locks pour ces indices
      for (const idx of indices) {
        const key = String(idx);
        const l = localLocks[key];
        if (l && l.uid === uid) delete localLocks[key];
      }
      emitChange();

      if (!res || !res.ok) {
        return { ok:false, locks: localLocks, error: res && res.error };
      }

      localLocks = merge(res.locks || {});
      return { ok:true, locks: localLocks };
    } catch (error) {
      console.error('[LockManager] unlock() failed:', error);
      return { ok:false, locks: localLocks, error: error.message };
    }
  }

  function haveMyValidLocksStrict(indices, skewMs = 1000){
    if (!Array.isArray(indices) || !indices.length) return false;
    const t = Date.now() + Math.max(0, skewMs|0);
    return indices.every(i => {
      const l = localLocks[String(i)];
      return l && l.uid === uid && l.until > t;
    });
  }

  // HEARTBEAT SIMPLIFIÉ - suppression des vérifications conflictuelles
  function startHeartbeat(blocks, intervalMs = HB_INTERVAL_MS, ttlMs = 180000, options = {}){
    stopHeartbeat();
    
    hbBlocks = Array.isArray(blocks) ? blocks.slice() : [];
    if (!hbBlocks.length) return;

    hbMaxMs = Math.max(60000, options.maxMs || 300000); // au moins 1 minute
    hbAutoUnlock = options.autoUnlock !== false;
    const requireActivity = options.requireActivity !== false;
    
    hbStartedAt = Date.now();
    lastActivityTs = Date.now();

    console.log('[LockManager] Starting heartbeat for blocks:', hbBlocks);

    // Premier renouvellement immédiat (sans optimisme pour être sûr)
    lock(hbBlocks, ttlMs, { optimistic: false }).then(result => {
      console.log('[LockManager] Initial heartbeat lock result:', result);
    }).catch(err => {
      console.warn('[LockManager] Initial heartbeat lock failed:', err);
    });

    hbTimer = setInterval(async ()=>{
      const now = Date.now();
      
      // Vérification de durée maximale
      if (now - hbStartedAt > hbMaxMs) {
        console.log('[LockManager] Heartbeat max duration reached, stopping');
        const blocksSnapshot = hbBlocks.slice();
        stopHeartbeat();
        if (hbAutoUnlock && blocksSnapshot.length) {
          try { await unlock(blocksSnapshot); } catch {}
        }
        return;
      }

      // Vérification d'activité (seulement si demandée)
      if (requireActivity && (now - lastActivityTs > 180000)) {
        console.log('[LockManager] User inactive, stopping heartbeat');
        const blocksSnapshot = hbBlocks.slice();
        stopHeartbeat();
        if (hbAutoUnlock && blocksSnapshot.length) {
          try { await unlock(blocksSnapshot); } catch {}
        }
        return;
      }

      // Renouvellement simple sans vérification préalable
      if (hbBlocks.length) {
        try {
          const result = await lock(hbBlocks, ttlMs, { optimistic: false });
          console.log('[LockManager] Heartbeat renewal:', result.ok ? 'success' : 'failed', result);
        } catch (err) {
          console.warn('[LockManager] Heartbeat renewal error:', err);
        }
      }
    }, Math.max(1000, intervalMs));
  }

  function stopHeartbeat(){
    if (hbTimer) { 
      clearInterval(hbTimer); 
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
  function isLocked(idx){ const l = localLocks[String(idx)]; return !!(l && l.until > now()); }
  function getMine(){
    const me = {};
    const t = now();
    for (const [k,l] of Object.entries(localLocks)) if (l && l.uid === uid && l.until > t) me[k] = l;
    return me;
  }
  function getTheirs(){
    const other = {};
    const t = now();
    for (const [k,l] of Object.entries(localLocks)) if (l && l.uid !== uid && l.until > t) other[k] = l;
    return other;
  }

  const api = {
    lock, unlock, merge,
    heartbeat: { start: startHeartbeat, stop: stopHeartbeat, setBlocks: setHeartbeatBlocks },
    getLocalLocks, isLocked, getMine, getTheirs, haveMyValidLocksStrict,
    on, off
  };

  window.LockManager = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();