(function () {
  const INSTALL = 'Install app';
  const IOS_HINT = 'Add RAYAN CMMS to your home screen from the browser Share menu.';
  const FALLBACK = {
    'Install app': 'تثبيت التطبيق',
    'Add RAYAN CMMS to your home screen from the browser Share menu.': 'أضف RAYAN CMMS إلى الشاشة الرئيسية من قائمة المشاركة في المتصفح.'
  };

  function label(key) {
    if (typeof window.t === 'function') return window.t(key);
    return localStorage.getItem('cmms-lang') === 'ar' && FALLBACK[key] ? FALLBACK[key] : key;
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    });
  }

  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return;

  const host = document.querySelector('.header-actions') || document.querySelector('.login-footer');
  if (!host) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'install-app';
  button.hidden = true;
  button.className = 'install-app';
  button.setAttribute('data-i18n', INSTALL);
  button.textContent = label(INSTALL);

  const hint = document.createElement('p');
  hint.id = 'install-app-hint';
  hint.hidden = true;
  hint.className = 'install-app-hint';
  hint.setAttribute('data-i18n', IOS_HINT);
  hint.textContent = label(IOS_HINT);

  host.appendChild(button);
  host.appendChild(hint);

  const style = document.createElement('style');
  style.textContent = '.install-app{border:1px solid #99baf0;background:#fff;color:#062857;border-radius:8px;padding:8px 12px;font:700 13px Arial,sans-serif;cursor:pointer}.header-actions .install-app{margin-inline-end:8px}.login-footer .install-app,.login-footer .install-app-hint{display:block;margin:12px auto 0;text-align:center}.install-app-hint{margin:8px 0 0;max-width:280px;font:12px Arial,sans-serif;color:#d7e4f8}';
  document.head.appendChild(style);

  let deferred = null;
  window.addEventListener('beforeinstallprompt', function (event) {
    deferred = event;
    button.hidden = false;
    button.textContent = label(INSTALL);
  });

  button.addEventListener('click', async function () {
    if (!deferred) return;
    deferred.prompt();
    const choice = await deferred.userChoice;
    deferred = null;
    if (choice && choice.outcome === 'accepted') button.hidden = true;
  });

  window.addEventListener('appinstalled', function () {
    button.hidden = true;
    hint.hidden = true;
  });

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) hint.hidden = false;

  document.addEventListener('cmms-language', function () {
    button.textContent = label(INSTALL);
    hint.textContent = label(IOS_HINT);
  });
})();
