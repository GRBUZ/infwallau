// contact-modal.js — open/close the Netlify contact form modal
(function(){
  const btn = document.getElementById('contactBtn');
  const modal = document.getElementById('contactModal');
  if (!btn || !modal) return;

  function open(){ modal.classList.remove('hidden'); }
  function close(){ modal.classList.add('hidden'); }

  btn.addEventListener('click', (e)=>{ e.preventDefault(); open(); });
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
  window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') close(); });
})();