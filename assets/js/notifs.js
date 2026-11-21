'use strict';
// ================= In-app notifications (bell) =================
let notifItems = [];
const NOTIF_ICON = {
    like: ['fa-heart', 'text-red-500'], reaction: ['fa-heart', 'text-orange-500'], comment: ['fa-comment', 'text-blue-500'],
    reply: ['fa-reply', 'text-blue-500'], mention: ['fa-at', 'text-purple-500'], comment_like: ['fa-heart', 'text-red-500'],
    share: ['fa-share', 'text-green-500'], views: ['fa-eye', 'text-yellow-500'], follow: ['fa-user-plus', 'text-blue-500'],
    referral: ['fa-gift', 'text-green-500']
};

function timeAgo(iso) {
    const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
}

function setBadge(n) {
    const b = document.getElementById('notifBadge');
    if (!b) return;
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('hidden', !n);
}

window.loadNotifCount = async () => {
    if (!currentUser || document.hidden) return;
    try {
        const r = await fetch('/api/notifCount', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ initData: tgAuth() }) });
        const d = await r.json();
        setBadge(d.count || 0);
    } catch (e) { /* offline */ }
};

const post = (url, body) => fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(Object.assign({ initData: tgAuth() }, body)) }).then(r => r.json());

function notifRowHtml(n) {
    const [icon, color] = NOTIF_ICON[n.type] || ['fa-bell', 'text-blue-500'];
    const avatar = n.actor_photo
        ? `<img src="${n.actor_photo}" class="w-11 h-11 rounded-full object-cover" onerror="this.style.display='none'">`
        : `<div class="w-11 h-11 rounded-full bg-gray-100 flex items-center justify-center"><i class="fas ${icon} ${color}"></i></div>`;
    const who = n.actor_name ? `<b>${escapeHtml(n.actor_name)}</b> ` : '';
    return `<div class="notif-row ${n.is_read ? '' : 'unread'}" data-nid="${n.id}" onclick="openNotif('${n.id}')">
        <div class="relative flex-shrink-0">${avatar}<span class="notif-type ${color}"><i class="fas ${icon}"></i></span></div>
        <div class="flex-1 min-w-0">
            <p class="text-[13px] leading-snug text-gray-800 break-words">${who}${escapeHtml(n.message || '')}</p>
            <span class="text-[11px] text-gray-400">${timeAgo(n.created_at)}</span>
        </div>
        <button class="notif-x" onclick="event.stopPropagation(); removeNotif('${n.id}')" aria-label="Remove"><i class="fas fa-times"></i></button>
    </div>`;
}

function renderNotifs() {
    const list = document.getElementById('notifList');
    list.innerHTML = notifItems.length
        ? notifItems.map(notifRowHtml).join('')
        : '<div class="text-center text-gray-400 py-16"><i class="fas fa-bell text-4xl mb-3 opacity-40"></i><p class="text-sm font-semibold">No notifications yet</p></div>';
}

window.openNotifs = async () => {
    openSheet('notifModalBg', 'notifSheet');
    document.getElementById('notifList').innerHTML = '<div class="text-center text-gray-400 py-16"><i class="fas fa-spinner fa-spin text-2xl"></i></div>';
    try {
        const d = await post('/api/notifications', {});
        notifItems = d.items || [];
        renderNotifs();
        if (d.unread) { post('/api/notifRead', {}); }     // seen → clear the badge (rows keep their "new" tint until closed)
        setBadge(0);
    } catch (e) { document.getElementById('notifList').innerHTML = '<p class="text-center text-red-400 text-sm py-10">Could not load notifications</p>'; }
};

window.removeNotif = (id) => {
    notifItems = notifItems.filter(n => String(n.id) !== String(id));
    const row = document.querySelector(`.notif-row[data-nid="${id}"]`);
    if (row) { row.classList.add('removing'); setTimeout(() => { row.remove(); if (!notifItems.length) renderNotifs(); }, 220); }
    post('/api/notifDelete', { id });
};

window.clearAllNotifs = () => {
    if (!notifItems.length) return;
    notifItems = []; renderNotifs(); setBadge(0);
    post('/api/notifDelete', {});
};

// Show one post at the top of the feed (same trick as shared links)
window.openPostById = async (postId) => {
    if (typeof shortsActive !== 'undefined' && shortsActive) exitShorts();
    switchTab('home');
    const d = await fetch('/api/getPostById', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ postId }) }).then(r => r.json());
    if (!d || !d.id) { tg.showAlert('This post is no longer available.'); return false; }
    const feed = document.getElementById('feed');
    let el = feed.querySelector(`[data-shared-post="${d.id}"]`);
    if (!el) { feed.insertAdjacentHTML('afterbegin', renderSharedPostWrapper(d)); el = feed.firstElementChild; }
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return true;
};

window.openNotif = async (id) => {
    const n = notifItems.find(x => String(x.id) === String(id));
    if (!n) return;
    closeSheet('notifModalBg', 'notifSheet');
    await new Promise(r => setTimeout(r, 120));
    try {
        if (n.target_type === 'profile') return openProfile(n.target_id);
        if (n.target_type === 'video') {
            await openShortById(n.target_id);
            if (n.comment_id) { window.focusCommentId = n.comment_id; openComments(n.target_id, 'video'); }
            return;
        }
        if (n.target_type === 'post') {
            const ok = await openPostById(n.target_id);
            if (ok && n.comment_id) { window.focusCommentId = n.comment_id; openComments(n.target_id, 'post'); }
        }
    } catch (e) { console.error('openNotif failed', e); }
};

window.trackShare = (contentType, id) => { post('/api/trackShare', { contentType, id }).catch(() => {}); };

// Poll the unread count while the app is visible (one tiny count query per minute)
setInterval(loadNotifCount, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadNotifCount(); });
