'use strict';
// ================= Maintenance mode: full-screen notice whenever the server says "503 + X-Maintenance" =================
(function () {
    let shown = false, timer = null;
    function show(msg, support) {
        const o = document.getElementById('maintenanceOverlay'); if (!o) return;
        const p = document.getElementById('mtMsg'); if (p && msg) p.textContent = msg;
        if (support) document.getElementById('mtSupport').href = support;
        else fetch('/api/appStatus').then(r => r.json()).then(j => { if (j && j.supportLink) document.getElementById('mtSupport').href = j.supportLink; }).catch(() => {});
        o.classList.remove('hidden'); shown = true;
        try { Telegram.WebApp.MainButton.hide(); } catch (e) {}
        if (!timer) timer = setInterval(async () => {          // come back automatically when maintenance ends
            try { const s = await (await origFetch('/api/status', { cache: 'no-store' })).json(); if (!s.maintenance) location.reload(); } catch (e) {}
        }, 20000);
    }
    const origFetch = window.fetch.bind(window);
    window.fetch = async function () {
        const r = await origFetch.apply(null, arguments);
        if (r.status === 503 && r.headers.get('X-Maintenance')) { r.clone().json().then(j => show(j && j.message)).catch(() => show()); }
        return r;
    };
    window.showMaintenance = show;
})();
