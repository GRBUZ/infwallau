// locks.js — Lock manager (merge local-wins + heartbeat + expirations)
(function(){
  'use strict';

  if (!window.CoreManager) {
    console.error('[LockManager] CoreManager required (uid + apiCall)');
    return;
  }

  const { apiCall } = window.CoreManager;
  const uid = window.CoreManager.uid || window.uid;

  // State local des locks
  let localLocks = Object.create(null);    // { "idx": { uid, until } }
  const othersLastSeen = Object.create(null);
  const OTHERS_GRACE_MS = 3000;           // Grâce temporaire pour "trous" réseau
  let hbTimer = null;
  let hbBlocks = [];                       // blocks courants pour le heartbeat
  const HB_INTERVAL_MS = 30000;           // 30 secondes au lieu de 4

  // Limites de durée et inactivité
  let hbStartedAt = 0;
  let hbMaxMs = 180000;          // durée totale max du heartbeat (3 min)
  let hbAutoUnlock = true;       // libérer automatiquement à l'arrêt
  let hbRequireActivity = true;  // ne pas prolonger si l'utilisateur est inactif
  let lastActivityTs = Date.now();
  const IDLE_LIMIT_MS = 120000;  // inactif après 2 min (au lieu de 3)

  // Suivre un minimum d'activité côté client
  (function attachActivityListenersOnce(){
    const bump = () => { lastActivityTs = Date.now(); };
    window.addEventListener('mousemove', bump, { passive:true });
    window.addEventListener('keydown',   bump, { passive:true });
    window.addEventListener('touchstart',bump, { passive:true });
    window.addEventListener('click',     bump, { passive:true });
  })();

  // Petit event emitter
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

  // Merge: local-wins pour MES locks encore valides, sinon on prend les locks serveur
  function merge(serverLocks){
    pruneLocal();
    const t = now();
    const out = Object.create(null);

    // 1) Mes locks locaux d'abord
    for (const [k, l] of Object.entries(localLocks)) {
      if (l && l.uid === uid && l.until > t) {
        out[k] = { uid: l.uid, until: l.until };
      }
    }

    // 2) Locks du serveur (vérité pour les autres) + noter "vu à t"
    for (const [k, l] of Object.entries(serverLocks || {})) {
      if (l && l.until > t) {
        out[k] = { uid: l.uid, until: l.until };
        if (l.uid !== uid) othersLastSeen[k] = t;
      }
    }

    // 3) Grâce de quelques secondes pour des locks "autres" disparus
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

    // Appel serveur
    const res = await apiCall('/reserve', {
      method: 'POST',
      body: JSON.stringify({ blocks: indices, ttl: ttlMs })
    });

    if (!res || !res.ok) {
      // Si on était en optimiste:false, on n'a rien modifié localement.
      return { ok:false, locked: [], conflicts: (res && res.conflicts) || [], locks: localLocks, error: res && res.error };
    }

    // Ajuster localLocks avec la vérité renvoyée par le serveur
    localLocks = merge(res.locks || {});
    return { ok:true, locked: res.locked || [], conflicts: res.conflicts || [], locks: localLocks, ttlSeconds: res.ttlSeconds };
  }

  async function unlock(blocks){
    const indices = Array.isArray(blocks) ? blocks.map(n=>parseInt(n,10)).filter(Number.isInteger) : [];
    if (!indices.length) return { ok:true, locks: localLocks };

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
      // On laisse status()/merge() recaler
      return { ok:false, locks: localLocks, error: res && res.error };
    }

    // Prendre locks serveur nettoyés
    localLocks = merge(res.locks || {});
    return { ok:true, locks: localLocks };
  }

  function haveMyValidLocksStrict(indices, skewMs = 1000){
    if (!Array.isArray(indices) || !indices.length) return false;
    const t = Date.now() + Math.max(0, skewMs|0);
    return indices.every(i => {
      const l = localLocks[String(i)];
      return l && l.uid === uid && l.until > t;
    });
  }


function startHeartbeat(blocks, intervalMs = HB_INTERVAL_MS, ttlMs = 180000, options = {}){
  
  stopHeartbeat();
  hbBlocks = Array.isArray(blocks) ? blocks.slice() : [];
  if (!hbBlocks.length) return;

  // Options avec valeurs par défaut
  hbMaxMs = Math.max(30000, options.maxMs || 180000); // min 30s, défaut 3min
  hbAutoUnlock = options.autoUnlock !== false;
  hbRequireActivity = options.requireActivity !== false;

  hbStartedAt = Date.now();
  lastActivityTs = Date.now();

  console.log('[LockManager] Starting heartbeat for', hbBlocks.length, 'blocks, maxMs:', hbMaxMs, 'requireActivity:', hbRequireActivity);

  // Premier renouvellement avec optimisme (on vient juste de créer ces locks)
  lock(hbBlocks, ttlMs, { optimistic: true }).catch((e) => {
    console.warn('[LockManager] Initial heartbeat lock failed:', e);
  });

  hbTimer = setInterval(async () => {
    const now = Date.now();
    const blocksSnapshot = hbBlocks.slice();
    const elapsed = now - hbStartedAt;

    // DEBUG: Log pour diagnostiquer
    console.log(`[Heartbeat] tick - elapsed=${elapsed}ms, maxMs=${hbMaxMs}, blocks=${blocksSnapshot.length}`);

    // Cap de durée totale
    if (elapsed > hbMaxMs) {
      console.log('[LockManager] Heartbeat max duration reached, stopping');
      stopHeartbeat();
      if (hbAutoUnlock && blocksSnapshot.length) { 
        try { await unlock(blocksSnapshot); } catch {} 
      }
      return;
    }

    // Inactivité prolongée
    if (hbRequireActivity && (now - lastActivityTs > IDLE_LIMIT_MS)) {
      console.log('[LockManager] User inactive for too long, stopping heartbeat');
      stopHeartbeat();
      if (hbAutoUnlock && blocksSnapshot.length) { 
        try { await unlock(blocksSnapshot); } catch {} 
      }
      return;
    }

    // Renouvellement (PAS d'optimisme local - on fait confiance au serveur)
    if (blocksSnapshot.length) {
      try {
        const result = await lock(blocksSnapshot, ttlMs, { optimistic: false });
        if (!result || !result.ok) {
          console.warn('[LockManager] Heartbeat renewal failed - server rejected:', result?.error);
          // NE PAS arrêter le heartbeat pour un échec ponctuel
          // Le serveur peut être temporairement surchargé
        } else {
          console.log('[LockManager] Heartbeat renewal success');
        }
      } catch (e) {
        console.warn('[LockManager] Heartbeat renewal failed - network error:', e);
        // NE PAS arrêter le heartbeat pour un échec ponctuel
      }
    }
  }, Math.max(1000, intervalMs));
}

  function stopHeartbeat(){
    if (hbTimer) {
      console.trace('[LockManager] stopHeartbeat() called from:'); 
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
    getLocalLocks, isLocked, getMine, getTheirs,
    on, off
  };

  // Export global
  window.LockManager = api;

  // Optionnel: CommonJS
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();