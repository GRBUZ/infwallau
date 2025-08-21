Contact Form (Netlify Forms) — Patch
========================================

This patch adds a CONTACT modal that submits via Netlify Forms.
You'll receive submissions in Netlify → Forms, and you can enable email notifications there.

Included files
--------------
- js/contact-modal.js              (opens/closes the modal)
- contact-success.html             (redirect target after submit)
- snippets/contact_modal_snippet.html  (HTML to paste into your index.html)

How to install
--------------
1) Upload the two files:
   - js/contact-modal.js
   - contact-success.html

2) Open your index.html and paste the contents of `snippets/contact_modal_snippet.html`
   just before </body>. Keep your existing purchase modal intact.

3) Ensure your "Contact Me" button has id="contactBtn". Example:
   <a id="contactBtn" class="btn pill outline" href="#" role="button">Contact Me</a>

4) Commit & deploy. Netlify will detect the form named "contact".

Enable email notifications
--------------------------
Netlify → Site settings → Forms → Notifications → Add notification (Email) → select form "contact".
