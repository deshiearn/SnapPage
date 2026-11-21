'use strict';
// Browser mode: outside Telegram there is no initData, so visitors get a throw-away guest
// account (signed token from /api/guestInit, kept in localStorage) and a top banner nudging
// them to open the real Telegram Mini App. Inside Telegram none of this runs.
(function () {
    const tg = window.Telegram.WebApp;
    const IN_TG = !!(tg.initData && tg.initData.length);
    const KEY = 'snap_guest_token';
    let token = '';
    try { token = localStorage.getItem(KEY) || ''; } catch (e) {}

    window.IS_GUEST = !IN_TG;
    window.tgAuth = () => (IN_TG ? tg.initData : token);

    window.ensureGuest = async () => {
        if (IN_TG || token) return;
        try {
            const r = await fetch('/api/guestInit', { method: 'POST' });
            const d = await r.json();
            if (d && d.token) { token = d.token; try { localStorage.setItem(KEY, token); } catch (e) {} }
        } catch (e) { /* offline: auth will fail and the app shows its fallback */ }
    };

    window.showGuestBanner = () => {
        if (IN_TG) return;
        const bar = document.getElementById('guestBanner');
        if (!bar) return;
        bar.classList.remove('hidden');
        document.body.classList.add('has-guest-bar');
    };
    window.openInTelegram = () => { window.location.href = 'https://t.me/SnapPagesBot/app'; };
})();
