'use strict';
const tg = window.Telegram.WebApp;
let currentUser = null;
let imagesArray = [];
let currentPostIdForComment = null;
let editModePostId = null;

// FIXED Modal navigation stack to handle Telegram's Native Back Button
let openModalsStack = [];

// Pagination/Infinite scroll variables (10 posts at a time)
let currentPage = 1;
let feedMode = 'all';          // 'all' (For You) | 'following'
let isLoadingFeed = false;
let hasMorePosts = true;

// Apply Full Screen App natively if API is supported, otherwise expand
try { tg.ready(); } catch (e) {}
try { tg.expand(); } catch (e) {}
try { if (tg.isVersionAtLeast && tg.isVersionAtLeast('8.0') && tg.requestFullscreen && !tg.isFullscreen) tg.requestFullscreen(); } catch (e) {}
try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch (e) {}

// Failsafe: never leave the user on the loading screen forever
setTimeout(() => { const l = document.getElementById('appLoadingScreen'); if (l) l.classList.add('hidden'); }, 10000);

// Automatic Dark / Light mode detection
// Theme is handled by theme.js (applyTheme + themeChanged listener)
function applyAutoTheme() { applyTheme(); }
applyAutoTheme();

// "_ref_<myId>" appended to share links so people who join through them count as my invites
window.refSuffix = () => (typeof currentUser !== 'undefined' && currentUser && currentUser.tg_id) ? `_ref_${currentUser.tg_id}` : '';

function getTelegramUser() {
    const user = tg.initDataUnsafe?.user || {};
    return {
        tg_id: user.id ? String(user.id) : "99999999",
        name: [user.first_name, user.last_name].filter(Boolean).join(' ') || "Telegram User",
        username: user.username || "tg_user",
        photo_url: user.photo_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.first_name || 'U')}`
    };
}

// Referral & Leveling Calculation
function calculateLevel(refCount) {
    if (refCount >= 5) return 3;
    if (refCount >= 3) return 2;
    return 1;
}

// Navigate to the standalone Admin Panel page, forwarding initData since a full
// page navigation loses Telegram's initData (it's only attached to the launch URL).
window.goToAdminPanel = () => {
    window.location.href = `/admin?tgInitData=${encodeURIComponent(tg.initData || '')}`;
};

// Redirect handler for clicking on post profiles (Loads Telegram profile or Channel directly)
window.openProfileLink = (type, authorId, username) => {
    if (username && username !== 'private') {
        tg.openTelegramLink(`https://t.me/${username}`);
    } else if (type === 'channel') {
        // A private channel with no public username can't be opened by outsiders
        tg.showAlert("This is a private channel and can't be opened.");
    } else {
        tg.openTelegramLink(`tg://user?id=${authorId}`);
    }
}

// Resolve a shared link like ?startapp=post_123 or ?startapp=video_45 — Telegram
// passes this through tg.initDataUnsafe.start_param when the app is launched from it.
async function handleSharedDeepLink() {
    try {
        // tg.initDataUnsafe.start_param is only populated by t.me/bot/app?startapp= deep
        // links (our own Share buttons). Notification buttons instead open a web_app
        // button whose URL just carries ?startapp=... as a normal query string, which we
        // have to read from the page's own URL instead.
        const urlParams = new URLSearchParams(window.location.search);
        const startParam = (tg.initDataUnsafe && tg.initDataUnsafe.start_param) || urlParams.get('startapp');
        if (!startParam) return;

        // Shared links may carry the sharer's id ("..._ref_123"); the server already counted it as an invite
        const sp = startParam.replace(/_ref_\d+$/, '');
        if (sp.startsWith('video_')) {
            await openShortById(sp.replace('video_', ''));
        } else if (sp.startsWith('profile_')) {
            openProfile(sp.replace('profile_', ''));
        } else if (sp.startsWith('post_')) {
            const postId = sp.replace('post_', '');
            const res = await fetch('/api/getPostById', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ postId }) });
            const post = await res.json();
            if (post && post.id) {
                const feed = document.getElementById('feed');
                const existing = feed.querySelector(`[data-shared-post="${post.id}"]`);
                if (!existing) {
                    feed.insertAdjacentHTML('afterbegin', renderSharedPostWrapper(post));
                    feed.firstElementChild.scrollIntoView({ behavior: 'smooth' });
                } else {
                    existing.scrollIntoView({ behavior: 'smooth' });
                }
            }
        }
    } catch (e) { console.error("Deep link resolution failed:", e); }
}

function renderSharedPostWrapper(post) {
    // Reuses the same card markup as the main feed, but wrapped with a highlight ring
    const html = buildPostCardHtml(post);
    return `<div data-shared-post="${post.id}" class="ring-2 ring-blue-400 rounded-xl">${html}</div>`;
}

// Support link can be changed from the Admin Panel; falls back to the default set in the HTML
async function loadSupportLink() {
    try {
        const res = await fetch('/api/appStatus');
        const status = await res.json();
        if (status && status.supportLink) {
            document.getElementById('supportLink').href = status.supportLink;
        }
    } catch (e) { /* keep the default link */ }
}

async function initApp() {
    // 0. Check maintenance mode before anything else renders
    try {
        const statusRes = await fetch('/api/appStatus');
        const status = await statusRes.json();
        if (status && status.maintenance) {
            // Still resolve currentUser quietly so an admin can be let through later if needed;
            // for now, all non-admin visitors are blocked.
            document.getElementById('appLoadingScreen').classList.add('hidden');
            document.getElementById('maintenanceOverlay').classList.remove('hidden');
            return;
        }
    } catch (e) { /* if the status check fails, fail open so the app is still usable */ }

    const liveUser = getTelegramUser();
    
    // 1. UPDATE LIVE TELEGRAM DATA IMMEDIATELY
    const safePhoto = liveUser.photo_url;
    document.getElementById('navProfilePic').src = safePhoto;
    document.getElementById('settingsProfilePic').src = safePhoto;
    document.getElementById('settingsProfileName').innerText = liveUser.name;
    document.getElementById('settingsProfileUsername').innerText = liveUser.username ? `@${liveUser.username}` : '';
    document.getElementById('settingsProfileLevel').innerText = `Level 1`;
    
    // Refer link opens the BOT CHAT (not the Mini App) so /start runs and the
    // referral gets verified and counted server-side.
    const link = `https://t.me/SnapPagesBot?start=ref_${liveUser.tg_id}`;
    document.getElementById('referInputLink').value = link;

    try {
        // 2. Fetch/Create User dynamically via secure Auth API
        const authRes = await fetch('/api/auth', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tg.initData })
        });
        
        const authData = await authRes.json();
        
        if (authData && authData.success) {
            currentUser = authData.user;
        } else {
            throw new Error("Auth API response failed");
        }

        // Refresh UI with calculated DB details
        const nameEl = document.getElementById('settingsProfileName');
        nameEl.innerHTML = liveUser.name + (currentUser.is_verified ? ' <i class="fas fa-check-circle verified-badge"></i>' : '');
        document.getElementById('settingsProfileLevel').innerText = `Level ${currentUser.level || 1}`;
        if (currentUser.streak_count > 0) {
            const st = document.getElementById('settingsStreak');
            st.innerText = `🔥 ${currentUser.streak_count}-day streak`;
            st.classList.remove('hidden');
        }

        if (currentUser.is_admin) {
            document.getElementById('adminBadge').classList.remove('hidden');
            document.getElementById('adminPanelBtn').classList.remove('hidden');
        }

    } catch(dbErr) {
        console.error("Auth routing failed, using live fallbacks:", dbErr);
        currentUser = { ...liveUser, level: 1, channels: [], is_admin: false, is_verified: false };
    }

    // 3. Load Feed — must finish before we try to pin a shared post on top of it
    try {
        loadTrendingTags();
        loadStories();
        await loadPosts(1, true);
        await loadSupportLink();

        // 4. Deep link handling — someone opened a shared post/video link
        await handleSharedDeepLink();
    } catch (e) {
        console.error("Initial load failed:", e);
    } finally {
        // 5. Everything the user will see first is ready (or failed) — reveal the app either way
        document.getElementById('appLoadingScreen').classList.add('hidden');
    }
}
