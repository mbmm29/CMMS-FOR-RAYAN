(function () {
  const INSTALL = 'Install app';
  const IOS_HINT = 'Add RAYAN CMMS to your home screen from the browser Share menu.';
  const PHONE = 'Phone notices';
  const PUSH_FLAG = 'cmms-push-enabled';
  const FALLBACK = {
    'Install app': 'تثبيت التطبيق',
    'Add RAYAN CMMS to your home screen from the browser Share menu.': 'أضف RAYAN CMMS إلى الشاشة الرئيسية من قائمة المشاركة في المتصفح.',
    'Phone notices': 'إشعارات الهاتف'
  };

  function label(key) {
    if (typeof window.t === 'function') return window.t(key);
    return localStorage.getItem('cmms-lang') === 'ar' && FALLBACK[key] ? FALLBACK[key] : key;
  }

  function noticeUser() {
    if (typeof getSavedUser !== 'function') return null;
    const user = getSavedUser();
    if (!user || (user.role !== 'TECHNICIAN' && user.role !== 'LUBRICATION_TECHNICIAN' && user.role !== 'MAINTENANCE_ENGINEER')) return null;
    return user;
  }

  function isLoginPage() {
    return Boolean(document.getElementById('loginForm') || document.getElementById('loginPage'));
  }

  function isPhoneDevice() {
    const ua = navigator.userAgent || '';
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)) return true;
    if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return true;
    return window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches;
  }

  function noticesAlreadyOn() {
    if (localStorage.getItem(PUSH_FLAG) === '1') return true;
    try {
      return typeof Notification !== 'undefined' && Notification.permission === 'granted';
    } catch (_) {
      return false;
    }
  }

  function markNoticesOn() {
    localStorage.setItem(PUSH_FLAG, '1');
  }

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
    return output;
  }

  async function subscribePhone() {
    if (!noticeUser() || typeof apiRequest !== 'function') return false;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return false;
    const registration = await navigator.serviceWorker.ready;
    const key = await apiRequest('/push/key');
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key.public_key),
      });
    }
    const json = subscription.toJSON();
    await apiRequest('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({
        endpoint: json.endpoint,
        p256dh: json.keys && json.keys.p256dh,
        auth: json.keys && json.keys.auth,
      }),
    });
    markNoticesOn();
    return true;
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      refreshPhone();
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function () {
        refreshPhone();
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          subscribePhone().then(function (ok) {
            if (ok) refreshPhone();
          }).catch(function () {});
        }
      }).catch(function () {
        refreshPhone();
      });
    });
  }

  const style = document.createElement('style');
  style.textContent = '.install-app{border:1px solid #99baf0;background:#fff;color:#062857;border-radius:8px;padding:8px 12px;font:700 13px Arial,sans-serif;cursor:pointer}.header-actions .install-app{margin-inline-end:8px}.login-footer .install-app,.login-footer .install-app-hint{display:block;margin:12px auto 0;text-align:center}.install-app-hint{margin:8px 0 0;max-width:280px;font:12px Arial,sans-serif;color:#d7e4f8}';
  document.head.appendChild(style);

  // Phone notices: main app header only, phones only, hide after the user enables them.
  const appHost = document.querySelector('.header-actions');
  const phone = document.createElement('button');
  phone.type = 'button';
  phone.id = 'phone-notices';
  phone.hidden = true;
  phone.className = 'install-app';
  phone.setAttribute('data-i18n', PHONE);
  phone.textContent = label(PHONE);
  if (appHost && !isLoginPage()) appHost.prepend(phone);

  function refreshPhone() {
    const canAsk = Boolean(appHost)
      && !isLoginPage()
      && isPhoneDevice()
      && Boolean(noticeUser())
      && 'Notification' in window
      && 'PushManager' in window
      && !noticesAlreadyOn()
      && Notification.permission !== 'denied';
    phone.hidden = !canAsk;
    phone.textContent = label(PHONE);
  }

  phone.addEventListener('click', async function () {
    if (!noticeUser() || !isPhoneDevice() || isLoginPage()) return;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      refreshPhone();
      return;
    }
    try {
      await subscribePhone();
      phone.hidden = true;
      refreshPhone();
    } catch (error) {
      if (typeof toast === 'function') toast(error.message || label('The phone could not be registered for notices.'));
    }
  });

  refreshPhone();
  document.addEventListener('cmms-language', refreshPhone);
  window.addEventListener('resize', refreshPhone);

  // Install app / iOS hint may still appear on login or the main header.
  const host = appHost || document.querySelector('.login-footer');
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone || !host) return;

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
    refreshPhone();
  });
})();
