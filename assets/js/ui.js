'use strict';
// Switch Tabs (FIXED: Clicking Home nav icon triggers a clean page 1 reload refresh)
let shortsActive = false;
let currentTab = 'home';

// Phone/Telegram Back must never close the app while you're deeper than the Home feed:
// an active search or any tab other than Home gets its own "step back".
window.homeSearchActive = () => { const i = document.getElementById('homeSearchInput'); return !!(i && i.value.trim()); };
window.baseBackNeeded = () => !shortsActive && (currentTab !== 'home' || homeSearchActive());
window.syncBackButton = () => { if (openModalsStack.length > 0 || baseBackNeeded()) tg.BackButton.show(); else tg.BackButton.hide(); };
window.switchTab = (tab) => {
    if (tab === 'shorts') {
        enterShorts();
        return;
    }
    if (shortsActive) leaveShortsUI();
    currentTab = tab;

    ['home', 'settings'].forEach(t => {
        const element = document.getElementById(`tab-${t}`);
        if(element) element.classList.add('hidden');
    });
    document.getElementById(`tab-${tab}`).classList.remove('hidden');
    
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active', 'text-blue-600'));
    const activeBtn = document.getElementById(`nav-${tab}`);
    if(activeBtn) activeBtn.classList.add('active', 'text-blue-600');
    
    if(tab === 'settings') document.getElementById('navProfilePic').classList.add('border-blue-600');
    else document.getElementById('navProfilePic').classList.remove('border-blue-600');

    if (tab === 'home') {
        loadPosts(1, true); // Clean re-fetch on Home nav click
        if (typeof loadStories === 'function') loadStories();
    }
};

// Shorts is a full-screen, immersive mode: header + bottom nav hide while it's open.
function enterShorts() {
    shortsActive = true;
    ['home', 'settings'].forEach(t => {
        const element = document.getElementById(`tab-${t}`);
        if(element) element.classList.add('hidden');
    });
    document.getElementById('appHeader').classList.add('hidden');
    document.getElementById('bottomNav').classList.add('hidden');
    document.getElementById('tab-shorts').classList.remove('hidden');

    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active', 'text-blue-600'));
    document.getElementById('nav-shorts').classList.add('active', 'text-blue-600');

    openModalsStack.push('__shorts__');
    tg.BackButton.show();

    if (document.getElementById('shortsFeed').children.length === 0) {
        document.getElementById('shortsEntryLoading').classList.remove('hidden');
        loadShorts(true);
    }
}

function leaveShortsUI() {
    shortsActive = false;
    document.getElementById('tab-shorts').classList.add('hidden');
    document.getElementById('appHeader').classList.remove('hidden');
    document.getElementById('bottomNav').classList.remove('hidden');
    document.querySelectorAll('#shortsFeed video').forEach(v => v.pause());
    openModalsStack = openModalsStack.filter(m => m !== '__shorts__');
    syncBackButton();
}

window.exitShorts = () => {
    leaveShortsUI();
    switchTab('home');
};

// Native MainButton per screen: each entry is built by the file that owns the feature
// (format.js / stories.js / extras.js) and registered here by modal id.
window.MB_SCREENS = window.MB_SCREENS || {};
function mbOpen(id) { const f = window.MB_SCREENS[id]; if (f) f(); }
function mbClose(id) { if (window.MB && window.MB_SCREENS[id]) MB.hide(id); }

// UI Open / Close modals
window.openModal = (id) => {
    if (id === 'channelModal') {
        openSheet('channelModalBg', 'channelSheet');
        renderChannels();
        return;
    }

    const el = document.getElementById(id);
    if (el) {
        el.classList.remove('hidden');
        
        // Track modal stack to invoke native BackButton on Telegram header
        openModalsStack.push(id);
        tg.BackButton.show();
        mbOpen(id);
    }

    if(id === 'postModal') {
        // NOTE: this must NOT reset the title/editModePostId here — triggerEditPost()
        // sets those up *before* calling openModal(), and doing it here would silently
        // flip an edit back into "Create Post" mode. See openNewPostModal() for that reset.
        renderPreviews();   // refresh counters / tiles
    }
};

// Resets the post composer to "new post" mode, then opens it — used by the floating + button
window.openNewPostModal = () => {
    editModePostId = null;
    imagesArray = [];
    document.getElementById('postText').value = '';
    renderPreviews();
    openModal('postModal');
    document.getElementById('postModalTitle').innerText = "Create Post";
    try { const d = localStorage.getItem('snap_draft'); if (d) { document.getElementById('postText').value = d; renderPreviews(); } } catch (e) {}   // unsent text comes back
};

window.closeModal = (id) => {
    const el = document.getElementById(id);
    if (el) {
        el.classList.add('hidden');
        openModalsStack = openModalsStack.filter(m => m !== id);
        mbClose(id);

        // If all modals are closed, hide Telegram's Native BackButton
        syncBackButton();
    }
};

// Bottom sheets use a separate bg/sheet pair instead of the single-id modal system,
// so they need their own entry in the Telegram BackButton stack to close correctly.
const SHEET_MAP = {
    optionsModalBg: 'optionsSheet',
    reportModalBg: 'reportSheet',
    commentModalBg: 'commentSheet',
    referModalBg: 'referSheet',
    channelModalBg: 'channelSheet',
    profileModalBg: 'profileSheet',
    notifModalBg: 'notifSheet',
    legalModalBg: 'legalSheet',
    prefsModalBg: 'prefsSheet'
};

function openSheet(bg, sheet) {
    document.getElementById(bg).classList.remove('hidden');
    setTimeout(() => document.getElementById(sheet).classList.add('open'), 10);
    openModalsStack.push(bg);
    tg.BackButton.show();
    mbOpen(bg);
}

window.closeSheet = (bg, sheet) => {
    document.getElementById(sheet).classList.remove('open');
    setTimeout(() => document.getElementById(bg).classList.add('hidden'), 300);
    openModalsStack = openModalsStack.filter(m => m !== bg);
    mbClose(bg);
    syncBackButton();
}
window.openLightbox = (src) => { document.getElementById('lightboxImg').src = src; openModal('lightbox'); }

// Telegram Native BackButton Event registration
tg.BackButton.onClick(() => {
    if (openModalsStack.length > 0) {
        const lastModal = openModalsStack[openModalsStack.length - 1];
        if (lastModal === '__shorts__') {
            exitShorts();
        } else if (lastModal === 'storyViewer') {
            closeStoryViewer();
        } else if (SHEET_MAP[lastModal]) {
            closeSheet(lastModal, SHEET_MAP[lastModal]);
        } else {
            closeModal(lastModal);
        }
    } else if (homeSearchActive()) {
        clearHomeSearch();
    } else if (currentTab !== 'home') {
        switchTab('home');
    }
    syncBackButton();
});

// Caption URL restriction logic based on level
