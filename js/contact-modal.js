// contact-modal.js — open/close the Netlify contact form modal
(function(){
  // ✅ Chercher le lien avec href="#contact" au lieu d'un bouton
  const btn = document.querySelector('a[href="#contact"]');
  const modal = document.getElementById('contactModal');
  if (!btn || !modal) return;

  function open(){ 
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; // ✅ Bloquer le scroll
  }
  
  function close(){ 
    modal.classList.add('hidden');
    document.body.style.overflow = ''; // ✅ Restaurer le scroll
  }

  btn.addEventListener('click', (e)=>{ e.preventDefault(); open(); });
  modal.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', close));
  window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') close(); });
})();