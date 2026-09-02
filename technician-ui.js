/*
 * Technician shell: this controls what is shown, not the data model.
 * API authorization remains enforced by the backend for every request.
 */
(function applyTechnicianShell() {
  const user = typeof getSavedUser === 'function' ? getSavedUser() : null;
  if (user?.role !== 'TECHNICIAN') return;

  const allowedPages = new Set(['work-orders', 'daily-reports']);
  document.body.classList.add('technician-interface');

  document.querySelectorAll('.nav-link').forEach(link => {
    link.hidden = !allowedPages.has(link.dataset.page);
  });

  const requestedPage = location.hash.replace('#', '');
  if (!allowedPages.has(requestedPage) || requestedPage === 'daily-reports') {
    location.replace('daily-reports.html');
    return;
  }

  // Technicians update assigned work rather than create a new work order.
  const action = document.getElementById('primary-action');
  if (action) action.hidden = true;
})();
