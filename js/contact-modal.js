// contact-modal.js — with Toast notification
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
  
  // ✅ NOUVEAU: Gérer la soumission du formulaire
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    
    // Désactiver le bouton
    submitBtn.disabled = true;
    submitBtn.textContent = '📤 Sending...';
    
    try {
      // Soumettre via fetch pour rester sur la page
      const formData = new FormData(form);
      const response = await fetch('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(formData).toString()
      });
      
      if (response.ok) {
        // ✅ Succès : Toast + fermer modal + reset form
        if (window.Toast) {
          Toast.success('Message sent successfully! We\'ll get back to you soon. 📬', 4000);
        } else {
          alert('Message sent successfully!');
        }
        form.reset();
        close();
      } else {
        throw new Error('Network response was not ok');
      }
    } catch (error) {
      console.error('[Contact] Submit error:', error);
      if (window.Toast) {
        Toast.error('Failed to send message. Please try again.', 4000);
      } else {
        alert('Failed to send message. Please try again.');
      }
    } finally {
      // Réactiver le bouton
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });
});