/*
 * Technician shell: this controls what is shown, not the data model.
 * API authorization remains enforced by the backend for every request.
 */
(function applyTechnicianShell() {
  const user = typeof getSavedUser === 'function' ? getSavedUser() : null;
  const pages = {
    TECHNICIAN: ['work-orders', 'pm-schedule', 'equipment', 'sop', 'daily-reports', 'lubrication'],
    LUBRICATION_TECHNICIAN: ['lubrication', 'work-orders', 'new-equipment', 'sop', 'pm-schedule'],
  };
  const allowed = pages[user?.role];
  if (!allowed) return;

  const allowedPages = new Set(allowed);
  const home = user.role === 'LUBRICATION_TECHNICIAN' ? 'lubrication' : 'work-orders';
  document.body.classList.add('technician-interface');

  document.querySelectorAll('.nav-link').forEach(link => {
    link.hidden = !allowedPages.has(link.dataset.page);
  });

  const requestedPage = location.hash.replace('#', '');
  if (!allowedPages.has(requestedPage)) location.replace(`index.html#${home}`);
})();
