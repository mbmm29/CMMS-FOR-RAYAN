/* Mobile navigation shared by the CMMS dashboards. */
(function setupMobileShell() {
  function menuLabel(open) {
    const key = open ? 'Close navigation menu' : 'Open navigation menu';
    if (typeof window.t === 'function') return window.t(key);
    if (localStorage.getItem('cmms-lang') === 'ar') return open ? 'إغلاق القائمة' : 'فتح القائمة';
    return key;
  }

  function settlePage() {
    const workspace = document.getElementById('workspace') || document.querySelector('.reports-layout');
    if (!workspace) return;
    workspace.classList.remove('page-settle');
    void workspace.offsetWidth;
    workspace.classList.add('page-settle');
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  function install() {
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar || document.querySelector('.mobile-menu-button')) return;

    document.body.classList.add('mobile-shell-ready');
    sidebar.id = sidebar.id || 'cmms-mobile-navigation';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mobile-menu-button';
    toggle.setAttribute('aria-label', menuLabel(false));
    toggle.setAttribute('aria-controls', sidebar.id);
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = '<span></span><span></span><span></span>';

    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'mobile-sidebar-backdrop';
    backdrop.setAttribute('aria-label', menuLabel(true));

    const close = () => {
      document.body.classList.remove('sidebar-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', menuLabel(false));
    };
    const open = () => {
      document.body.classList.add('sidebar-open');
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', menuLabel(true));
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
      if (window.innerWidth > 980) close();
    });
    window.addEventListener('hashchange', () => {
      close();
      settlePage();
    });
    document.addEventListener('cmms-language', () => {
      toggle.setAttribute('aria-label', menuLabel(document.body.classList.contains('sidebar-open')));
      backdrop.setAttribute('aria-label', menuLabel(true));
    });

    document.body.append(backdrop, toggle);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
