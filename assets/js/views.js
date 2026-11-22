'use strict';
// ================= View counting =================
// A post/video counts as "viewed" once it has been on screen for ~1.2s. Ids are batched and sent every 5s
// (and when the app is hidden), at most once per item per session, never for your own content.
const seenViews = new Set();
// Persistent "already seen" memory (last 400 items) — the server pushes these down in the ranking so feeds stay fresh
const SEEN_KEY = 'snap_seen';
let seenStore = [];
try { seenStore = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]'); } catch (e) {}
window.getSeenIds = (prefix) => seenStore.filter(k => k[0] === prefix).map(k => k.slice(1));
function rememberSeen(key) {
    if (seenStore.includes(key)) return;
    seenStore.push(key); if (seenStore.length > 400) seenStore = seenStore.slice(-400);
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seenStore)); } catch (e) {}
}
const pendingViews = { posts: new Set(), videos: new Set() };
const viewTimers = new WeakMap();

const viewObserver = new IntersectionObserver((entries) => {
    entries.forEach(en => {
        const el = en.target;
        if (en.isIntersecting && en.intersectionRatio >= 0.6) {
            if (viewTimers.has(el)) return;
            viewTimers.set(el, setTimeout(() => {
                const postId = el.dataset.viewPost, videoId = el.dataset.videoId;
                const key = postId ? 'p' + postId : 'v' + videoId;
                if (seenViews.has(key)) return;
                seenViews.add(key); rememberSeen(key);
                (postId ? pendingViews.posts : pendingViews.videos).add(postId || videoId);
            }, 1200));
        } else if (viewTimers.has(el)) {
            clearTimeout(viewTimers.get(el));
            viewTimers.delete(el);
        }
    });
}, { threshold: [0.6] });

function watchViewTargets(root) {
    (root || document).querySelectorAll('[data-view-post], .short-item[data-video-id]').forEach(el => {
        if (el.dataset.viewWatched) return;
        el.dataset.viewWatched = '1';
        viewObserver.observe(el);
    });
}
new MutationObserver(() => watchViewTargets()).observe(document.body, { childList: true, subtree: true });

async function flushViews() {
    if (!pendingViews.posts.size && !pendingViews.videos.size) return;
    const body = { initData: tgAuth(), posts: [...pendingViews.posts], videos: [...pendingViews.videos] };
    pendingViews.posts.clear(); pendingViews.videos.clear();
    try { await fetch('/api/trackViews', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), keepalive: true }); } catch (e) {}
}
setInterval(flushViews, 5000);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushViews(); });
