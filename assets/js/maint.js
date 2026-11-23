'use strict';
// ================= Maintenance mode: full-screen notice whenever the server says "503 + X-Maintenance" =================
(function () {
    let shown = false, timer = null;
    function show(msg) {
        if (shown) { const p = document.getElementById('mtMsg'); if (p && msg) p.textContent = msg; return; }
        shown = true;
        const d = document.createElement('div'); d.id = 'mtOverlay'; d.className = 'mt-overlay';
        d.innerHTML = '<div class="mt-box"><div class="mt-gear"><i class="fas fa-gear"></i><i class="fas fa-gear mt-g2"></i></div><h2>Under Maintenance</h2><p id="mtMsg"></p><button onclick="location.reload()">Try again</button></div>';
        document.body.appendChild(d);
        document.getElementById('mtMsg').textContent = msg || 'We will be back soon.';
        try { Telegram.WebApp.MainButton.hide(); } catch (e) {}
        timer = setInterval(async () => {                       // come back automatically when maintenance ends
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
