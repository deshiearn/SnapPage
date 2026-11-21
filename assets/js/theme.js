// Telegram theme + native bottom button (MainButton). Loaded before core.js.
// Docs: https://core.telegram.org/bots/webapps#themeparams , #mainbutton
(function () {
    const tg = window.Telegram.WebApp;
    const root = document.documentElement;
    const ver = (v) => { try { return tg.isVersionAtLeast(v); } catch (e) { return false; } };

    // ---------- colour helpers ----------
    const hex2rgb = (h) => {
        if (!h || h[0] !== '#') return null;
        if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
        const n = parseInt(h.slice(1, 7), 16);
        return isNaN(n) ? null : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const rgb2hex = (c) => '#' + c.map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
    const mix = (a, b, t) => { // t = share of b
        const A = hex2rgb(a), B = hex2rgb(b);
        return A && B ? rgb2hex(A.map((x, i) => x + (B[i] - x) * t)) : a;
    };
    const alpha = (h, a) => { const c = hex2rgb(h); return c ? `rgba(${c[0]},${c[1]},${c[2]},${a})` : h; };

    // ---------- theme ----------
    const FALLBACK = {
        light: { bg_color: '#ffffff', secondary_bg_color: '#f3f4f6', section_bg_color: '#ffffff', text_color: '#111827', hint_color: '#6b7280', link_color: '#2563eb', button_color: '#2563eb', button_text_color: '#ffffff', destructive_text_color: '#ef4444', section_separator_color: '#e5e7eb' },
        dark:  { bg_color: '#1c1c1e', secondary_bg_color: '#1c1c1e', section_bg_color: '#2c2c2e', text_color: '#f2f2f7', hint_color: '#a1a1a6', link_color: '#64b5ff', button_color: '#0a84ff', button_text_color: '#ffffff', destructive_text_color: '#ff6b61', section_separator_color: '#3a3a3c' }
    };

    window.applyTheme = function () {
        // Preference from Settings: system (follow Telegram) | light | dark
        let pref = 'system';
        try { pref = localStorage.getItem('snap_theme') || 'system'; } catch (e) {}
        const dark = pref === 'system' ? tg.colorScheme === 'dark' : pref === 'dark';
        const fb = FALLBACK[dark ? 'dark' : 'light'];
        const p = (pref === 'system' || (tg.colorScheme === 'dark') === dark) ? (tg.themeParams || {}) : {};   // opposite of Telegram → built-in palette
        const g = (k) => (hex2rgb(p[k]) ? p[k] : fb[k]);

        const page = g('secondary_bg_color');       // page background
        const surf = g('section_bg_color');         // cards / sheets
        const text = g('text_color');
        const v = {
            '--app-bg': page,
            '--app-surface': surf,
            '--app-surface2': mix(surf, text, dark ? 0.1 : 0.04),
            '--app-sep': g('section_separator_color'),
            '--app-sep2': mix(g('section_separator_color'), text, 0.12),
            '--app-text': text,
            '--app-hint': g('hint_color'),
            '--app-link': g('link_color'),
            '--app-accent': g('button_color'),
            '--app-accent-text': g('button_text_color'),
            '--app-danger': g('destructive_text_color'),
            '--app-bg-glass': alpha(page, 0.92),
            '--app-surface-glass': alpha(surf, 0.92),
            '--app-accent-tint': alpha(g('button_color'), 0.16),
            '--app-accent-tint2': alpha(g('button_color'), 0.24)
        };
        const b = document.body;
        Object.keys(v).forEach(k => b.style.setProperty(k, v[k]));
        b.classList.toggle('dark-mode', dark);
        b.classList.toggle('bg-gray-900', dark);
        b.classList.toggle('text-white', dark);
        b.classList.toggle('bg-gray-100', !dark);
        b.classList.toggle('text-gray-900', !dark);
        b.classList.add('themed');

        // Tell Telegram our colours so header / background / bottom bar blend in
        try { if (ver('6.1')) { tg.setHeaderColor('secondary_bg_color'); tg.setBackgroundColor(page); } } catch (e) {}
        try { if (ver('7.10')) tg.setBottomBarColor(surf); } catch (e) {}
    };

    window.setThemePref = (v) => {
        try { localStorage.setItem('snap_theme', v); } catch (e) {}
        applyTheme(); markThemeBtn();
    };
    window.markThemeBtn = () => {
        let pref = 'system'; try { pref = localStorage.getItem('snap_theme') || 'system'; } catch (e) {}
        document.querySelectorAll('[data-theme-btn]').forEach(b => b.classList.toggle('active', b.dataset.themeBtn === pref));
    };

    // ---------- safe-area (notch / Telegram header in fullscreen) ----------
    function applySafeArea() {
        if (!ver('8.0')) return;                        // older clients: CSS env() fallback
        const s = tg.safeAreaInset || {}, c = tg.contentSafeAreaInset || {};
        const top = tg.isFullscreen ? (s.top || 0) + (c.top || 0) : 0;
        root.style.setProperty('--top-inset', top + 'px');
        root.style.setProperty('--bottom-inset', (s.bottom || 0) + 'px');
    }

    // ---------- MainButton manager ----------
    // One owner at a time (the top-most open screen). Falls back to the in-page button when
    // the client has no native bottom button (plain browser / very old Telegram).
    const supported = !!tg.MainButton && tg.platform && tg.platform !== 'unknown';
    const MB = { stack: [], handler: null, supported };
    window.MB = MB;

    function paint() {
        if (!supported) return;
        const top = MB.stack[MB.stack.length - 1];
        const btn = tg.MainButton;
        if (MB.handler) { try { btn.offClick(MB.handler); } catch (e) {} MB.handler = null; }
        if (!top) { btn.hideProgress(); btn.hide(); return; }
        btn.setParams({ text: top.text, is_visible: true, is_active: top.active !== false });
        MB.handler = top.onClick;
        btn.onClick(MB.handler);
        top.busy ? btn.showProgress(false) : btn.hideProgress();
    }
    // Register a screen's button; `inPage` = element to hide while the native one is in use
    MB.show = (id, cfg) => {
        MB.stack = MB.stack.filter(x => x.id !== id);
        MB.stack.push(Object.assign({ id }, cfg));
        if (supported && cfg.inPage) cfg.inPage.classList.add('hidden');
        paint();
    };
    MB.update = (id, patch) => {
        const e = MB.stack.find(x => x.id === id); if (!e) return;
        Object.assign(e, patch);
        if (e.inPage && !supported) { e.inPage.disabled = e.active === false || !!e.busy; }
        if (MB.stack[MB.stack.length - 1] === e) paint();
    };
    MB.hide = (id) => {
        const e = MB.stack.find(x => x.id === id);
        MB.stack = MB.stack.filter(x => x.id !== id);
        if (e && e.inPage) e.inPage.classList.remove('hidden');
        paint();
    };

    // Weak phone / data-saver → "lite" mode (no blur, fewer animations) so scrolling stays smooth
    try {
        const c = navigator.connection || {};
        const weak = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 3) || c.saveData;
        if (weak) document.documentElement.classList.add('lite-pending');
    } catch (e) {}
    const applyLite = () => { if (document.documentElement.classList.contains('lite-pending')) document.body.classList.add('lite'); };

    tg.onEvent('themeChanged', applyTheme);
    tg.onEvent('safeAreaChanged', applySafeArea);
    tg.onEvent('contentSafeAreaChanged', applySafeArea);
    tg.onEvent('fullscreenChanged', applySafeArea);
    if (document.body) { applyTheme(); applySafeArea(); applyLite(); markThemeBtn(); }
    else document.addEventListener('DOMContentLoaded', () => { applyTheme(); applySafeArea(); applyLite(); markThemeBtn(); });
})();
