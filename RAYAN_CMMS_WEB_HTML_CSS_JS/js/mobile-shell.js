/* Mobile navigation shared by the CMMS dashboards. */
(function setupMobileShell() {
  function install() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar || document.querySelector('.mobile-menu-button')) return;

    document.body.classList.add('mobile-shell-ready');
    sidebar.id = sidebar.id || 'cmms-mobile-navigation';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mobile-menu-button';
    toggle.setAttribute('aria-label', 'Open navigation menu');
    toggle.setAttribute('aria-controls', sidebar.id);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span></span><span></span><span></span>';

    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'mobile-sidebar-backdrop';
    backdrop.setAttribute('aria-label', 'Close navigation menu');

    const close = () => {
      document.body.classList.remove('sidebar-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation menu');
    };
    const open = () => {
      document.body.classList.add('sidebar-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close navigation menu');
    };

    toggle.addEventListener('click', () => {
      document.body.classList.contains('sidebar-open') ? close() : open();
    });
    backdrop.addEventListener('click', close);
    sidebar.addEventListener('click', event => {
      if (event.target.closest('a, button')) close();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 760) close();
    });

    document.body.append(backdrop, toggle);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
