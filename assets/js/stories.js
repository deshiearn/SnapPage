'use strict';
// ================= Stories (24h image status) =================
const STORY_MS = 5000;
let storyGroups = [];
let sv = { g: 0, i: 0, timer: null, startedAt: 0, remaining: STORY_MS, paused: false, downAt: 0 };

function seenStories() { try { return new Set(JSON.parse(localStorage.getItem('seenStories') || '[]')); } catch (e) { return new Set(); } }
function markSeen(id) {
    try { const s = seenStories(); s.add(String(id)); localStorage.setItem('seenStories', JSON.stringify([...s].slice(-300))); } catch (e) {}
}
function timeAgo(iso) {
    const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
}

async function loadStories() {
    try {
        const res = await fetch('/api/getStories', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ initData: tgAuth() }) });
        storyGroups = await res.json();
        if (!Array.isArray(storyGroups)) storyGroups = [];
    } catch (e) { storyGroups = []; }
    renderStoriesBar();
}

function renderStoriesBar() {
    const bar = document.getElementById('storiesBar');
    if (!bar) return;
    const seen = seenStories();
    const mine = storyGroups.find(g => g.isMe);
    const myPhoto = (currentUser && currentUser.photo_url) || 'https://ui-avatars.com/api/?name=U';
    let html = `
        <div class="story-item" onclick="${mine ? `openStoryViewer(${storyGroups.indexOf(mine)})` : 'pickStoryImage()'}">
            <div class="story-ring ${mine ? '' : 'none'} ${mine && mine.stories.every(s => seen.has(String(s.id))) ? 'seen' : ''}"><img src="${myPhoto}" class="story-avatar"></div>
            <button class="story-plus" onclick="event.stopPropagation();pickStoryImage()"><i class="fas fa-plus"></i></button>
            <span>Your story</span>
        </div>`;
    storyGroups.forEach((g, idx) => {
        if (g.isMe) return;
        const allSeen = g.stories.every(s => seen.has(String(s.id)));
        html += `
        <div class="story-item" onclick="openStoryViewer(${idx})">
            <div class="story-ring ${allSeen ? 'seen' : ''}"><img src="${g.author_photo}" class="story-avatar" onerror="this.src='https://ui-avatars.com/api/?name=U'"></div>
            <span>${escapeHtml((g.author_name || 'User').split(' ')[0])}</span>
        </div>`;
    });
    bar.innerHTML = html;
}

// ---------- Creating a story ----------
window.pickStoryImage = () => document.getElementById('storyFileInput').click();

document.getElementById('storyFileInput').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.type.startsWith('video/')) return prepStoryVideo(file);
    storyVideo = null;
    document.getElementById('storyPreviewVid').classList.add('hidden');
    document.getElementById('storyPreview').classList.remove('hidden');
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onload = () => {
            // Shrink to max 1080px JPEG so uploads are small and fast on mobile data
            const scale = Math.min(1, 1080 / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            storyDraft = c.toDataURL('image/jpeg', 0.82);
            document.getElementById('storyPreview').src = storyDraft;
            document.getElementById('storyCaption').value = '';
            openModal('storyCompose');
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
});
let storyDraft = null, storyVideo = null;

function prepStoryVideo(file) {
    if (file.size > 12 * 1024 * 1024) { tg.showAlert('Video is too big. Pick a short clip under 12 MB (about 30 seconds).'); return; }
    const url = URL.createObjectURL(file);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
        if (probe.duration > 31) { URL.revokeObjectURL(url); tg.showAlert('Story videos can be up to 30 seconds.'); return; }
        const r = new FileReader();
        r.onload = () => {
            storyVideo = r.result; storyDraft = null;
            const pv = document.getElementById('storyPreviewVid');
            pv.src = url; pv.classList.remove('hidden');
            document.getElementById('storyPreview').classList.add('hidden');
            document.getElementById('storyCaption').value = '';
            openModal('storyCompose'); try { pv.play(); } catch (e) {}
        };
        r.readAsDataURL(file);
    };
    probe.onerror = () => tg.showAlert('Could not read this video. Try an MP4 file.');
    probe.src = url;
}

window.MB_SCREENS.storyCompose = () => MB.show('storyCompose', { text: 'Share Story', onClick: () => shareStory(), inPage: document.getElementById('storyShareBtn') });

window.shareStory = async () => {
    if (!storyDraft && !storyVideo) return;
    const btn = document.getElementById('storyShareBtn');
    btn.disabled = true; btn.innerText = 'Sharing...';
    if (window.MB) MB.update('storyCompose', { busy: true });
    try {
        const res = await fetch('/api/createStory', { method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth(), image: storyDraft, video: storyVideo, caption: document.getElementById('storyCaption').value.trim() }) });
        const data = await res.json();
        if (data && data.success) {
            storyDraft = null; storyVideo = null;
            try { document.getElementById('storyPreviewVid').pause(); } catch (e) {}
            closeModal('storyCompose');
            await loadStories();
            try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
        } else {
            tg.showAlert((data && data.error) || 'Could not share your story');
        }
    } catch (e) { tg.showAlert('Could not share your story. Check your connection.'); }
    if (window.MB) MB.update('storyCompose', { busy: false });
    btn.disabled = false; btn.innerText = 'Share';
};

// ---------- Viewer ----------
window.openStoryViewer = (groupIdx) => {
    sv.g = groupIdx; sv.i = 0;
    const seen = seenStories();
    const idx = storyGroups[groupIdx].stories.findIndex(s => !seen.has(String(s.id)));
    if (idx > 0) sv.i = idx;          // resume at the first unseen story
    openModal('storyViewer');
    showStory();
};

window.closeStoryViewer = () => {
    clearTimeout(sv.timer);
    try { document.getElementById('storyVid').pause(); } catch (e) {}
    closeModal('storyViewer');
    renderStoriesBar();
};

function showStory() {
    const g = storyGroups[sv.g];
    const st = g && g.stories[sv.i];
    if (!st) { closeStoryViewer(); return; }
    markSeen(st.id);
    const vid = document.getElementById('storyVid'), img = document.getElementById('storyImg');
    const isVid = st.media_type === 'video' && st.video_url;
    vid.classList.toggle('hidden', !isVid); img.classList.toggle('hidden', !!isVid);
    if (isVid) { img.removeAttribute('src'); } else { vid.pause(); vid.removeAttribute('src'); img.src = st.image_url; }
    document.getElementById('storyAvatar').src = g.author_photo;
    document.getElementById('storyName').innerText = g.author_name || 'User';
    document.getElementById('storyTime').innerText = timeAgo(st.created_at);
    const cap = document.getElementById('storyCaptionView');
    cap.innerText = st.caption || ''; cap.classList.toggle('hidden', !st.caption);
    document.getElementById('storyDeleteBtn').classList.toggle('hidden', !g.isMe);
    document.getElementById('storyBars').innerHTML = g.stories.map((_, i) =>
        `<div class="story-seg"><div class="story-fill ${i < sv.i ? 'done' : ''}"></div></div>`).join('');
    // preload the next image
    const nxt = g.stories[sv.i + 1] || (storyGroups[sv.g + 1] && storyGroups[sv.g + 1].stories[0]);
    if (nxt && nxt.image_url) new Image().src = nxt.image_url;
    if (isVid) {
        vid.src = st.video_url; vid.currentTime = 0; sv.vid = vid;
        vid.onloadedmetadata = () => { startStoryTimer(Math.min(30000, Math.max(2000, (vid.duration || 10) * 1000))); vid.play().catch(() => { vid.muted = true; vid.play().catch(() => {}); }); };
        vid.onerror = () => startStoryTimer(STORY_MS);
        clearTimeout(sv.timer);
    } else { sv.vid = null; startStoryTimer(STORY_MS); }
}

function startStoryTimer(ms) {
    clearTimeout(sv.timer);
    sv.remaining = ms; sv.startedAt = Date.now(); sv.paused = false;
    const fill = document.querySelectorAll('#storyBars .story-fill')[sv.i];
    if (fill) { fill.style.animation = 'none'; void fill.offsetWidth; fill.style.animation = `storyFill ${ms}ms linear forwards`; }
    sv.timer = setTimeout(nextStory, ms);
}
function pauseStory() {
    if (sv.paused) return;
    sv.paused = true;
    if (sv.vid) try { sv.vid.pause(); } catch (e) {}
    clearTimeout(sv.timer);
    sv.remaining = Math.max(200, sv.remaining - (Date.now() - sv.startedAt));
    const fill = document.querySelectorAll('#storyBars .story-fill')[sv.i];
    if (fill) fill.style.animationPlayState = 'paused';
}
function resumeStory() {
    if (!sv.paused) return;
    sv.paused = false; sv.startedAt = Date.now();
    if (sv.vid) try { sv.vid.play(); } catch (e) {}
    const fill = document.querySelectorAll('#storyBars .story-fill')[sv.i];
    if (fill) fill.style.animationPlayState = 'running';
    sv.timer = setTimeout(nextStory, sv.remaining);
}

function nextStory() {
    const g = storyGroups[sv.g];
    if (sv.i < g.stories.length - 1) { sv.i++; showStory(); }
    else if (sv.g < storyGroups.length - 1) { sv.g++; sv.i = 0; showStory(); }
    else closeStoryViewer();
}
function prevStory() {
    if (sv.i > 0) { sv.i--; showStory(); }
    else if (sv.g > 0) { sv.g--; sv.i = 0; showStory(); }
    else showStory();
}

// Tap left third = back, right = next; press-and-hold pauses
(() => {
    const zone = document.getElementById('storyZone');
    zone.addEventListener('pointerdown', () => { sv.downAt = Date.now(); pauseStory(); });
    zone.addEventListener('pointerup', (e) => {
        const held = Date.now() - sv.downAt;
        if (held < 220) {
            const x = e.clientX / window.innerWidth;
            resumeStory();
            x < 0.33 ? prevStory() : nextStory();
        } else resumeStory();
    });
    zone.addEventListener('pointercancel', resumeStory);
})();

window.deleteCurrentStory = async () => {
    const g = storyGroups[sv.g], st = g && g.stories[sv.i];
    if (!st) return;
    pauseStory();
    tg.showConfirm('Delete this story?', async (ok) => {
        if (!ok) { resumeStory(); return; }
        try { await fetch('/api/deleteStory', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ initData: tgAuth(), id: st.id }) }); } catch (e) {}
        closeStoryViewer();
        loadStories();
    });
};
