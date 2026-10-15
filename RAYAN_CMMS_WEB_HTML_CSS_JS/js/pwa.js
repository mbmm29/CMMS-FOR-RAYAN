(function () {
  const INSTALL = 'Install app';
  const IOS_HINT = 'Add RAYAN CMMS to your home screen from the browser Share menu.';
  const PHONE = 'Phone notices';
  const PUSH_FLAG = 'cmms-push-enabled';
  const FALLBACK = {
    'Install app': 'تثبيت التطبيق',
    'Add RAYAN CMMS to your home screen from the browser Share menu.': 'أضف RAYAN CMMS إلى الشاشة الرئيسية من قائمة المشاركة في المتصفح.',
    'Phone notices': 'إشعارات الهاتف',
    'The phone could not be registered for notices.': 'تعذر تسجيل الهاتف لاستلام الإشعارات.',
    'Phone notices are on.': 'إشعارات الهاتف مفعّلة.',
    'Phone notices are off.': 'إشعارات الهاتف غير مفعّلة.',
    'Phone notices were blocked in the browser.': 'تم منع إشعارات الهاتف من إعدادات المتصفح.',
    'This browser cannot show phone notices.': 'هذا المتصفح لا يدعم إشعارات الهاتف.',
    'Enable phone notices': 'تفعيل إشعارات الهاتف',
    'Re-enable phone notices': 'إعادة تفعيل إشعارات الهاتف',
    'Send test notice': 'إرسال إشعار تجريبي',
    'Test notice sent. Check the phone notification tray.': 'تم إرسال إشعار تجريبي. راجع لوحة إشعارات الهاتف.',
    'Notification settings': 'ضبط الإشعارات',
    'Open this page from the home-screen app on iPhone to receive notices.': 'على آيفون افتح التطبيق من الشاشة الرئيسية لاستلام الإشعارات.',
    'Enable notices on this phone, then send a test notice to confirm sound and the on-screen banner.': 'فعّل الإشعارات على هذا الهاتف ثم أرسل إشعارًا تجريبيًا للتأكد من الصوت والشريط الظاهر فوق التطبيقات.',
    'On Android: App info → Notifications → General → enable Sound and Show as pop-up (like WhatsApp).': 'على أندرويد: معلومات التطبيق ← الإشعارات ← عام ← فعّل الصوت وإظهار كنافذة منبثقة (مثل واتساب).',
    'On iPhone: turn off Focus (Personal), or allow CMMS in Focus → Apps. Then leave the app (Home) and send a test notice.': 'على آيفون: أوقف وضع التركيز (Personal) أو اسمح لـ CMMS من التركيز ← التطبيقات. ثم اخرج من التطبيق (Home) وأرسل إشعارًا تجريبيًا.',
    'Test notice sent. Leave CMMS now (Home) to hear the banner over other apps.': 'تم إرسال إشعار تجريبي. اخرج من CMMS الآن (Home) لتسمع الصوت ويظهر الشريط فوق التطبيقات.',
    'Test notice sent. Check the phone notification tray.': 'تم إرسال إشعار تجريبي. راجع لوحة إشعارات الهاتف والصوت.',
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

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function noticesAlreadyOn() {
    return localStorage.getItem(PUSH_FLAG) === '1';
  }

  function markNoticesOn() {
    localStorage.setItem(PUSH_FLAG, '1');
  }

  function clearNoticesFlag() {
    localStorage.removeItem(PUSH_FLAG);
  }

  function pushSupported() {
    return 'serviceWorker' in navigator
      && 'PushManager' in window
      && typeof Notification !== 'undefined';
  }

  function urlBase64ToUint8Array(value) {
    const padding = '='.repeat((4 - (value.length % 4)) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const output = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
    return output;
  }

  function playNoticeTone() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
      [[880, 0], [1175, 0.14], [988, 0.28]].forEach(([freq, offset]) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + offset);
        osc.connect(gain);
        osc.start(now + offset);
        osc.stop(now + offset + 0.16);
      });
      setTimeout(() => { try { ctx.close(); } catch (_) {} }, 800);
    } catch (_) {}
  }

  function noticeDisplayOptions(body, tag) {
    return {
      body: String(body || '').slice(0, 180),
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      lang: 'ar',
      dir: 'rtl',
      tag: tag || `cmms-${Date.now()}`,
      renotify: true,
      silent: false,
      requireInteraction: true,
      vibrate: [180, 80, 180, 80, 280],
      timestamp: Date.now(),
      interruptionLevel: 'timeSensitive',
      data: { url: '/index.html#work-orders' },
      actions: [
        { action: 'open', title: 'فتح' },
        { action: 'dismiss', title: 'إغلاق' },
      ],
    };
  }

  async function showLocalNotice(title, body, options) {
    const text = String(body || '').slice(0, 180);
    if (!pushSupported() || Notification.permission !== 'granted') return false;
    const opts = options || {};
    if (!opts.quiet) playNoticeTone();
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, noticeDisplayOptions(text, `cmms-test-${Date.now()}`));
      return true;
    } catch (_) {
      try {
        new Notification(title, noticeDisplayOptions(text, `cmms-test-${Date.now()}`));
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  function scheduleBackgroundTestNotice(title, body) {
    // iOS suppresses banner/sound while the PWA is open; show after the user leaves.
    const fire = () => {
      if (!document.hidden) return;
      document.removeEventListener('visibilitychange', fire);
      showLocalNotice(title, body, { quiet: false });
    };
    document.addEventListener('visibilitychange', fire);
    setTimeout(() => {
      if (document.hidden) fire();
    }, 1200);
  }

  async function subscribePhone(force) {
    if (!noticeUser() || typeof apiRequest !== 'function') return false;
    if (!pushSupported()) throw new Error(label('This browser cannot show phone notices.'));
    if (Notification.permission !== 'granted') return false;
    const registration = await navigator.serviceWorker.ready;
    const key = await apiRequest('/push/key');
    const applicationServerKey = urlBase64ToUint8Array(key.public_key);
    let subscription = await registration.pushManager.getSubscription();
    if (force && subscription) {
      try { await subscription.unsubscribe(); } catch (_) {}
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
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

  async function enablePhoneNotices() {
    if (!noticeUser()) throw new Error(label('Only a technician can receive phone notices.'));
    if (!pushSupported()) throw new Error(label('This browser cannot show phone notices.'));
    if (isIos() && !isStandalone()) {
      throw new Error(label('Open this page from the home-screen app on iPhone to receive notices.'));
    }
    let permission = Notification.permission;
    if (permission !== 'granted') {
      permission = await Notification.requestPermission();
    }
    if (permission !== 'granted') {
      clearNoticesFlag();
      if (permission === 'denied') throw new Error(label('Phone notices were blocked in the browser.'));
      throw new Error(label('The phone could not be registered for notices.'));
    }
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const ok = await subscribePhone(true);
    if (!ok) {
      clearNoticesFlag();
      throw new Error(label('The phone could not be registered for notices.'));
    }
    if (typeof apiRequest === 'function') {
      try { await apiRequest('/push/test', { method: 'POST', body: '{}' }); } catch (_) {}
    }
    scheduleBackgroundTestNotice(
      label('Phone notices are on.'),
      label('Test notice sent. Leave CMMS now (Home) to hear the banner over other apps.'),
    );
    playNoticeTone();
    return true;
  }

  async function sendTestNotice() {
    if (!noticeUser()) throw new Error(label('Only a technician can receive phone notices.'));
    if (Notification.permission !== 'granted' || !noticesAlreadyOn()) {
      await enablePhoneNotices();
      return true;
    }
    if (typeof apiRequest === 'function') {
      await apiRequest('/push/test', { method: 'POST', body: '{}' });
    }
    scheduleBackgroundTestNotice(
      label('Notification settings'),
      label('Test notice sent. Leave CMMS now (Home) to hear the banner over other apps.'),
    );
    playNoticeTone();
    return true;
  }

  function noticeStatus() {
    if (!noticeUser()) return { code: 'role', text: label('Only a technician can receive phone notices.') };
    if (!pushSupported()) return { code: 'unsupported', text: label('This browser cannot show phone notices.') };
    if (Notification.permission === 'denied') return { code: 'denied', text: label('Phone notices were blocked in the browser.') };
    if (isIos() && !isStandalone()) return { code: 'ios', text: label('Open this page from the home-screen app on iPhone to receive notices.') };
    if (Notification.permission === 'granted' && noticesAlreadyOn()) return { code: 'on', text: label('Phone notices are on.') };
    return { code: 'off', text: label('Phone notices are off.') };
  }

  window.cmmsPush = {
    enable: enablePhoneNotices,
    test: sendTestNotice,
    status: noticeStatus,
    supported: pushSupported,
    isPhone: isPhoneDevice,
    playTone: playNoticeTone,
    refreshHeader: function () { refreshPhone(); },
  };

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'cmms-push') playNoticeTone();
    });
    window.addEventListener('load', function () {
      refreshPhone();
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(function (registration) {
        if (registration && registration.update) registration.update();
        refreshPhone();
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && noticeUser()) {
          subscribePhone(false).then(function (ok) {
            if (!ok) clearNoticesFlag();
            refreshPhone();
          }).catch(function () {
            clearNoticesFlag();
            refreshPhone();
          });
        }
      }).catch(function () {
        refreshPhone();
      });
    });
  }

  const style = document.createElement('style');
  style.textContent = '.install-app{border:1px solid #99baf0;background:#fff;color:#062857;border-radius:8px;padding:8px 12px;font:700 13px Arial,sans-serif;cursor:pointer}.header-actions .install-app{margin-inline-end:8px}.login-footer .install-app,.login-footer .install-app-hint{display:block;margin:12px auto 0;text-align:center}.install-app-hint{margin:8px 0 0;max-width:280px;font:12px Arial,sans-serif;color:#d7e4f8}';
  document.head.appendChild(style);

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
      && pushSupported()
      && !noticesAlreadyOn()
      && Notification.permission !== 'denied';
    phone.hidden = !canAsk;
    phone.textContent = label(PHONE);
  }

  phone.addEventListener('click', async function () {
    if (!noticeUser() || isLoginPage()) return;
    try {
      await enablePhoneNotices();
      phone.hidden = true;
      if (typeof toast === 'function') toast(label('Phone notices are on.'));
      refreshPhone();
    } catch (error) {
      clearNoticesFlag();
      refreshPhone();
      if (typeof toast === 'function') toast(error.message || label('The phone could not be registered for notices.'));
    }
  });

  refreshPhone();
  document.addEventListener('cmms-language', refreshPhone);
  window.addEventListener('resize', refreshPhone);
  window.addEventListener('storage', refreshPhone);

  const host = appHost || document.querySelector('.login-footer');
  if (isStandalone() || !host) return;

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

  if (isIos()) hint.hidden = false;

  document.addEventListener('cmms-language', function () {
    button.textContent = label(INSTALL);
    hint.textContent = label(IOS_HINT);
    refreshPhone();
  });
})();
