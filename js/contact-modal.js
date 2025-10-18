// contact-modal.js — Version simple
document.addEventListener('DOMContentLoaded', function() {
  const btn = document.querySelector('a[href="#contact"]');
  const modal = document.getElementById('contactModal');
  const form = document.getElementById('contactForm');
  
  if (!btn || !modal || !form) return;

  function open(){ 
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }
  
  function close(){ 
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  btn.addEventListener('click', (e) => { 
    e.preventDefault(); 
    open(); 
  });
  
  modal.querySelectorAll('[data-close]').forEach(el => {
    el.addEventListener('click', close);
  });
  
  window.addEventListener('keydown', (e) => { 
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      close(); 
    }
  });
  
  // ✅ Gérer la soumission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    
    submitBtn.disabled = true;
    submitBtn.innerHTML = '📤 Sending...';
    
    try {
      const formData = new FormData(form);
      
      const response = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formData).toString()
      });
      
      if (response.ok) {
        // ✅ Utiliser le Toast de app.js (qui existe déjà)
        if (typeof Toast !== 'undefined') {
          Toast.success('Message sent successfully! We\'ll get back to you soon. 📬');
        }
        form.reset();
        setTimeout(() => close(), 1000);
      } else {
        throw new Error('Network error');
      }
    } catch (error) {
      console.error('[Contact] Error:', error);
      if (typeof Toast !== 'undefined') {
        Toast.error('Failed to send message. Please try again.');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  });
});