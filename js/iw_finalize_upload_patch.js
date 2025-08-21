/* iw_finalize_upload_patch.js — UID unify + DOM-selection + JWT via apiCall/apiCallMultipart (aucun fetch direct sur endpoints sensibles) */
(function(){
  const grid        = document.getElementById('grid');
  const modal       = document.getElementById('modal');
  const form        = document.getElementById('form');
  const confirmBtn  = document.getElementById('confirm');
  const cancelBtn   = document.getElementById('cancel');
  const nameInput   = document.getElementById('name');
  const linkInput   = document.getElementById('link');
  const emailInput  = document.getElementById('email');
  const fileInput   = document.getElementById('image') || document.getElementById('avatar') || (form && form.querySelector('input[type="file"]'));

  if (!grid || !form || !confirmBtn) { console.warn('[IW patch] required elements not found'); return; }

  // === UID unify (reuse existing window.uid if present; persist in localStorage) ===
  function makeUid(){ try{ return crypto.randomUUID(); }catch(_){ return Date.now().toString(36)+Math.random().toString(36).slice(2); } }
  (function ensureUid(){
    try{
      const k='iw_uid';
      let v = (typeof window.uid !== 'undefined' && window.uid) ? String(window.uid) : (localStorage.getItem(k) || '');
      if (!v) { v = makeUid(); }
      localStorage.setItem(k, v);
      window.uid = v; // <- single source of truth for ALL scripts
    }catch(_){
      window.uid = window.uid || makeUid();
    }
  })();
  const uid = window.uid;

  function getSelectedIndices(){
    return Array.from(document.querySelectorAll('.cell.sel')).map(el => +el.dataset.idx);
  }
  function normalizeUrl(u){ u=String(u||'').trim(); if(!u) return ''; if(!/^https?:\/\//i.test(u)) u='https://'+u; return u; }

  // Fallbacks si absents (status peut rester public)
  if (typeof window.renderRegions !== 'function') {
    window.renderRegions = function(){
      const gridEl = document.getElementById('grid'); if (!gridEl) return;
      gridEl.querySelectorAll('.region-overlay').forEach(n=>n.remove());
      const first = gridEl.querySelector('.cell'); const size = first ? first.offsetWidth : 10;
      const regionLink = {};
      for (const [idx, s] of Object.entries(window.sold||{})) if (s && s.regionId && !regionLink[s.regionId] && s.linkUrl) regionLink[s.regionId]=s.linkUrl;
      for (const [rid, reg] of Object.entries(window.regions||{})) {
        if (!reg || !reg.rect || !reg.imageUrl) continue;
        const {x,y,w,h} = reg.rect;
        const tl = gridEl.querySelector(`.cell[data-idx="${y*100+x}"]`); if (!tl) continue;
        const a=document.createElement('a'); a.className='region-overlay';
        if (regionLink[rid]) { a.href=regionLink[rid]; a.target='_blank'; a.rel='noopener nofollow'; }
        Object.assign(a.style,{position:'absolute',left:tl.offsetLeft+'px',top:tl.offsetTop+'px',width:(w*size)+'px',height:(h*size)+'px',backgroundImage:`url("${reg.imageUrl}")`,backgroundSize:'cover',backgroundPosition:'center',backgroundRepeat:'no-repeat',zIndex:999});
        gridEl.appendChild(a);
      }
      gridEl.style.position='relative'; gridEl.style.zIndex=2;
    };
  }
  if (typeof window.refreshStatus !== 'function') {
    window.refreshStatus = async function(){
      try{
        const r=await fetch('/.netlify/functions/status?ts='+Date.now());
        const d=await r.json();
        window.sold=d.sold||{}; window.locks=d.locks||{}; window.regions=d.regions||{}; window.renderRegions?.();
      }catch(e){ console.warn('[IW patch] refreshStatus failed', e); }
    };
  }

  // Appel JSON sécurisé via app.js
  async function callJson(endpoint, options = {}){
    if (typeof window.apiCall !== 'function') {
      console.error('[IW patch] apiCall indisponible: appel annulé pour', endpoint);
      return null;
    }
    return window.apiCall(endpoint, options);
  }

  // Upload multipart sécurisé via app.js
  async function callMultipart(endpoint, formData, options = {}){
    if (typeof window.apiCallMultipart !== 'function') {
      console.error('[IW patch] apiCallMultipart indisponible: upload annulé');
      return null;
    }
    return window.apiCallMultipart(endpoint, formData, options);
  }

  async function unlockSelection(){
    try{
      const blocks=getSelectedIndices(); if(!blocks.length) return;
      await callJson('/unlock',{
        method:'POST',
        body:JSON.stringify({ blocks })
      });
    }catch(_){}
  }

  // Déverrouillage en arrière-plan (keepalive) — via apiCall uniquement
  async function unlockKeepalive(){
    try{
      if (typeof window.apiCall !== 'function') return;
      const blocks=getSelectedIndices(); if(!blocks.length) return;
      await window.apiCall('/unlock', {
        method:'POST',
        body:JSON.stringify({ blocks }),
        headers:{ 'Content-Type':'application/json' },
        keepalive:true
      });
    }catch(_){}
  }

  document.addEventListener('keydown',e=>{ if(e.key==='Escape') unlockSelection(); },{passive:true});
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='hidden'){
      unlockKeepalive();
    }
  });

   async function doConfirm(){
    const name=(nameInput&&nameInput.value||'').trim();
    const linkUrl=normalizeUrl(linkInput&&linkInput.value);
    const blocks=getSelectedIndices();
    if(!blocks.length){ alert('Please select at least one block.'); return; }
    if(!name||!linkUrl){ alert('Name and Profile URL are required.'); return; }

    confirmBtn.disabled = true;

    // Re-reserve just before finalize (if backend supports it), using the SAME uid
    try{
      const rsv=await fetch('/.netlify/functions/reserve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uid,blocks,ttl:180000})});
      const jr=await rsv.json();
      if(!jr.ok){
        await window.refreshStatus().catch(()=>{});
        alert(jr.error||'Some blocks are already locked/sold. Please reselect.');
        confirmBtn.disabled=false; return;
      }
    }catch(_){ /* ignore if not present */ }

    // Finalize WITH uid
    const fRes=await fetch('/.netlify/functions/finalize',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uid,name,linkUrl,blocks})});
    const out=await fRes.json();
    if(!out.ok){ alert(out.error||'Finalize failed'); confirmBtn.disabled=false; return; }

    // Optional upload
    try{
      const file=fileInput&&fileInput.files&&fileInput.files[0];
      if(file){
        if(!file.type.startsWith('image/')) throw new Error('Please upload an image file.');
        if(file.size>5*1024*1024) throw new Error('Max 5 MB.');
        const fd=new FormData(); fd.append('file',file,file.name); fd.append('regionId',out.regionId);
        const upRes=await fetch('/.netlify/functions/upload',{method:'POST',body:fd});
        const up=await upRes.json(); if(!up.ok) throw new Error(up.error||'UPLOAD_FAILED');
        console.log('[IW patch] image linked:', up.imageUrl);
      }
    }catch(e){ console.warn('[IW patch] upload failed:', e); }

    await window.refreshStatus().catch(()=>{});
    modal?.classList?.add('hidden');
    confirmBtn.disabled=false;
  }

  // Force-rebind Confirm
  const newBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(newBtn, confirmBtn);
  newBtn.id = 'confirm';
  newBtn.addEventListener('click', (e)=>{ e.preventDefault(); doConfirm(); });

  if (cancelBtn){
    const nc = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(nc, cancelBtn);
    nc.id='cancel';
    nc.addEventListener('click', async (e)=>{ e.preventDefault(); await unlockSelection(); modal?.classList?.add('hidden'); });
  }

  window.refreshStatus().catch(()=>{});
  console.log('[IW patch] UID unify active. uid=', uid);
})();