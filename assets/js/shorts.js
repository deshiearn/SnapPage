'use strict';
// ================= SHORTS (TikTok-style video feed) =================
let shortsPage = 1;
let isLoadingShorts = false;
let hasMoreShorts = true;
let shortsObserver = null;
// Videos must start muted so autoplay isn't blocked by the browser; tapping the
// sound button is a real user gesture, so we can safely unmute from then on.
let shortsMuted = true;

let shortsMode = 'foryou';   // 'foryou' | 'following'

async function loadShorts(reset = false) {
    if (isLoadingShorts) return;
    isLoadingShorts = true;
    const feed = document.getElementById('shortsFeed');
    if (reset) { feed.innerHTML = ''; shortsPage = 1; hasMoreShorts = true; }
    const empty = document.getElementById('shortsEmptyState');

    try {
        const res = await fetch('/api/getShorts', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ page: shortsPage, limit: 5, initData: tgAuth(), following: shortsMode === 'following' })
        });
        const videos = await res.json();

        if (!videos || videos.length === 0) {
            hasMoreShorts = false;
            if (reset) {
                document.getElementById('shortsEmptyMsg').textContent = shortsMode === 'following'
                    ? 'Follow people to see their reels here.' : 'No Shorts yet — be the first to upload!';
                empty.classList.remove('hidden');
            }
            return;
        }
        empty.classList.add('hidden');
        if (videos.length < 5) hasMoreShorts = false;

        videos.forEach(v => {
            if (!feed.querySelector(`[data-video-id="${v.id}"]`)) feed.insertAdjacentHTML('beforeend', renderShortItem(v));
        });
        observeShorts();
    } catch (e) {
        console.error("Shorts load failed:", e);
    } finally {
        document.getElementById('shortsEntryLoading').classList.add('hidden');
        isLoadingShorts = false;
    }
}

window.setShortsMode = (mode) => {
    if (mode === shortsMode) { refreshShorts(); return; }      // tapping the active tab = refresh
    shortsMode = mode;
    document.querySelectorAll('.rl-tab').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    document.getElementById('shortsEntryLoading').classList.remove('hidden');
    loadShorts(true);
};

function renderShortItem(v) {
    const myReaction = currentUser && v.reactions ? (v.reactions[currentUser.tg_id] || '') : '';
    const shortLikeCount = (v.likes_count || 0) + Object.keys(v.reactions || {}).length;
    const hasLiked = v.likes_users && currentUser && v.likes_users.includes(currentUser.tg_id);
    const verifiedIcon = v.author_verified ? ' <i class="fas fa-check-circle" style="color:#3b82f6"></i>' : '';
    const captionHtml = animateEmojis(formatCaption(v.caption, v.author_level || 1, v.entities));
    const mine = currentUser && (String(v.author_id) === String(currentUser.tg_id) || (currentUser.channels || []).some(c => String(c.id) === String(v.author_id)));
    const showFollow = !mine && !v.is_following && v.type !== 'channel';
    const avatar = v.author_photo || 'https://ui-avatars.com/api/?name=U';
    return `
    <div class="short-item rl-item" data-video-id="${v.id}" data-author="${v.author_id}">
        <video class="rl-video" src="${v.stream_url}" playsinline muted preload="metadata" poster=""
            onloadedmetadata="this.classList.toggle('rl-cover', this.videoHeight >= this.videoWidth * 1.2)"
            onwaiting="this.closest('.rl-item').classList.add('buffering')"
            onplaying="this.closest('.rl-item').classList.remove('buffering', 'paused')"
            oncanplay="this.closest('.rl-item').classList.remove('buffering')"
            onpause="if(!this.ended)this.closest('.rl-item').classList.add('paused')"
            ontimeupdate="rlProgress(this)" onended="rlEnded(this)"></video>
        <div class="rl-shade"></div>

        <div class="rl-spin"></div>
        <div class="rl-pause"><i class="fas fa-play"></i></div>
        <div class="rl-tap" onclick="handleShortTap(event, '${v.id}')"></div>

        <div class="rl-rail">
            <div class="rl-avwrap" onclick="openProfile('${v.author_id}')">
                <img src="${avatar}" class="rl-av" loading="lazy" onerror="this.src='https://ui-avatars.com/api/?name=U'">
                ${showFollow ? `<button class="rl-plus" onclick="event.stopPropagation();rlFollow(this,'${v.author_id}')" aria-label="Follow"><i class="fas fa-plus"></i></button>` : ''}
            </div>
            <button onclick="likeVideo(this, '${v.id}')" data-react="video" data-id="${v.id}" class="react-btn rl-btn">
                <span class="react-emoji text-2xl ${myReaction ? '' : 'hidden'}">${myReaction}</span><i class="${myReaction ? 'hidden ' : ''}${hasLiked ? 'fas fa-heart text-red-500' : 'far fa-heart'}"></i>
                <span class="like-count">${shortLikeCount}</span>
                <span class="rl-react-row" data-react-row="video:${v.id}">${buildReactionRowHtml('video', v.id, v.likes_count || 0, v.reactions || {}, false)}</span>
            </button>
            <button onclick="openComments('${v.id}', 'video')" class="rl-btn"><i class="far fa-comment-dots"></i><span>Comment</span></button>
            <button onclick="shareVideoDirectly('${v.id}')" class="rl-btn"><i class="far fa-paper-plane"></i><span>Share</span></button>
            <button onclick="openShortOptions('${v.id}', '${v.author_id}', '${v.type}')" class="rl-btn" aria-label="More"><i class="fas fa-ellipsis"></i></button>
        </div>

        <div class="rl-info">
            <div class="rl-author" onclick="openProfile('${v.author_id}')"><b>${escapeHtml(v.author_name || 'User')}${verifiedIcon}</b></div>
            <p class="rl-cap caption-clamp" data-full="${escapeHtml(v.caption || '').replace(/"/g, '&quot;')}">${captionHtml}</p>
            <button onclick="toggleCaption(this)" class="hidden see-more-btn rl-more">more</button>
        </div>

        <div class="rl-bar" ontouchstart="rlScrub(event,this)" ontouchmove="rlScrub(event,this)" onpointerdown="rlScrub(event,this)"><i></i></div>
    </div>`;
}

// ----- progress bar / scrubbing / autoplay next -----
window.rlProgress = (v) => {
    const bar = v.closest('.rl-item').querySelector('.rl-bar i');
    if (bar && v.duration) bar.style.width = (v.currentTime / v.duration * 100) + '%';
};
window.rlScrub = (e, el) => {
    e.stopPropagation();
    const v = el.closest('.rl-item').querySelector('video');
    const pt = e.touches ? e.touches[0] : e;
    const r = el.getBoundingClientRect();
    if (v.duration) v.currentTime = Math.max(0, Math.min(1, (pt.clientX - r.left) / r.width)) * v.duration;
};
window.rlEnded = (v) => {
    // keep people watching: roll straight on to the next reel, or replay if this is the last one
    const item = v.closest('.rl-item'), next = item.nextElementSibling;
    if (next && next.classList.contains('rl-item')) next.scrollIntoView({ behavior: 'smooth' });
    else { v.currentTime = 0; v.play().catch(() => {}); }
};
window.rlFollow = async (btn, authorId) => {
    btn.disabled = true;
    try {
        const res = await fetch('/api/toggleFollow', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ initData: tgAuth(), targetId: authorId }) });
        const d = await res.json();
        if (d && d.success) {
            if (!d.following) { await fetch('/api/toggleFollow', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ initData: tgAuth(), targetId: authorId }) }); }   // was already following — undo the toggle
            document.querySelectorAll(`.rl-item[data-author="${authorId}"] .rl-plus`).forEach(b => { b.classList.add('done'); b.innerHTML = '<i class="fas fa-check"></i>'; setTimeout(() => b.remove(), 900); });
            try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
        } else tg.showAlert((d && d.error) || 'Could not follow');
    } catch (e) { btn.disabled = false; }
};

// Single tap = play/pause · double tap anywhere = like with a heart burst
let rlLast = { t: 0, id: '' };
window.handleShortTap = (e, videoId) => {
    const item = e.currentTarget.closest('.short-item'), video = item.querySelector('video');
    const now = Date.now();
    if (rlLast.id === videoId && now - rlLast.t < 300) {
        rlLast = { t: 0, id: '' };
        const r = item.getBoundingClientRect();
        const h = document.createElement('i');
        h.className = 'fas fa-heart rl-burst'; h.style.left = (e.clientX - r.left) + 'px'; h.style.top = (e.clientY - r.top) + 'px';
        item.appendChild(h); setTimeout(() => h.remove(), 800);
        const btn = item.querySelector('.react-btn'), ic = btn && btn.querySelector('i');
        const liked = btn && (btn.querySelector('.react-emoji:not(.hidden)') || (ic && ic.classList.contains('fas')));
        if (btn && !liked) likeVideo(btn, videoId);
        return;
    }
    rlLast = { t: now, id: videoId };
    setTimeout(() => {
        if (rlLast.id === videoId && rlLast.t === now && video) { if (video.paused) video.play().catch(() => {}); else video.pause(); }
    }, 300);
};

window.toggleCaption = (btn) => {
    const p = btn.previousElementSibling;
    const expanded = p.classList.toggle('caption-expanded');
    p.classList.toggle('caption-clamp', !expanded);
    btn.innerText = expanded ? 'See less' : 'See more';
};

// Show "See more" only for captions that are actually clipped
window.refreshCaptionOverflows = (root) => {
    (root || document).querySelectorAll('.caption-clamp').forEach(p => {
        const btn = p.nextElementSibling;
        if (!btn || !btn.classList.contains('see-more-btn')) return;
        const overflow = p.scrollHeight > p.clientHeight + 1;
        btn.classList.toggle('hidden', !overflow);
        const sp = btn.nextElementSibling;
        if (sp && sp.classList.contains('see-more-spacer')) sp.classList.toggle('hidden', overflow);
    });
};

// Re-check "See more" whenever content is (re)rendered
{ let t; new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => refreshCaptionOverflows(), 80); })
    .observe(document.body, { childList: true, subtree: true }); }
window.addEventListener('resize', () => refreshCaptionOverflows());

// Wrap emoji in animated spans (text nodes only, never inside tags)
// Emojis in posts are shown as plain, static text (no per-emoji animation — lighter and calmer)
function animateEmojis(html) { return html; }

window.handleImgSliderScroll = (el) => {
    const idx = Math.round(el.scrollLeft / Math.max(el.clientWidth, 1));
    const dots = el.parentElement.querySelectorAll('.img-dot');
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
};

// Global sound toggle — flips the shared mute preference and applies it live
window.toggleShortsSound = () => {
    shortsMuted = !shortsMuted;
    document.querySelectorAll('#shortsFeed video').forEach(v => { v.muted = shortsMuted; });
    const icon = document.getElementById('shortsSoundIcon');
    if (icon) icon.className = shortsMuted ? 'fas fa-volume-xmark' : 'fas fa-volume-high';
};

// Reloads the Shorts feed from the top with fresh videos
window.refreshShorts = async () => {
    const icon = document.getElementById('shortsRefreshIcon');
    if (icon) icon.classList.add('fa-spin');
    document.getElementById('shortsFeed').scrollTo({ top: 0 });
    await loadShorts(true);
    if (icon) icon.classList.remove('fa-spin');
};

// Autoplay the reel in view, pause the rest; warm up the next one so swiping feels instant
function observeShorts() {
    if (shortsObserver) shortsObserver.disconnect();
    shortsObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const video = entry.target.querySelector('video');
            if (!video) return;
            if (entry.isIntersecting) {
                video.muted = shortsMuted;
                video.play().catch(() => {});
                const nx = entry.target.nextElementSibling && entry.target.nextElementSibling.querySelector('video');
                if (nx) nx.preload = 'auto';
                const pv = entry.target.previousElementSibling && entry.target.previousElementSibling.querySelector('video');
                if (pv) pv.currentTime = 0;
            } else {
                video.pause();
            }
        });
    }, { threshold: 0.6 });
    document.querySelectorAll('.short-item').forEach(item => shortsObserver.observe(item));
}

document.getElementById('shortsFeed').addEventListener('scroll', function() {
    if (this.scrollTop + this.clientHeight >= this.scrollHeight - 200) {
        if (!isLoadingShorts && hasMoreShorts) {
            shortsPage++;
            loadShorts(false);
        }
    }
});

// Opens the main Reels page starting at one specific reel (used by profile grid + deep links)
window.openShortById = async (videoId) => {
    try {
        const res = await fetch('/api/getVideoById', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ videoId, initData: tgAuth() }) });
        const video = await res.json();
        const feed = document.getElementById('shortsFeed');
        if (video && video.id) {
            feed.innerHTML = renderShortItem(video);
            shortsPage = 1; hasMoreShorts = true;
            document.getElementById('shortsEmptyState').classList.add('hidden');
            if (!shortsActive) switchTab('shorts');
            feed.scrollTop = 0;
            observeShorts();
            document.getElementById('shortsEntryLoading').classList.add('hidden');
            loadShorts(false);          // the rest of the reels follow below, without duplicates
        } else {
            switchTab('shorts');
        }
    } catch (e) { switchTab('shorts'); }
};

window.shareVideoDirectly = (id) => {
    trackShare('video', id);
    const forwardLink = `https://t.me/SnapPagesBot/app?startapp=video_${id}${refSuffix()}`;
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(forwardLink)}&text=${encodeURIComponent('Check out this Short on SnapPages!')}`);
};

window.likeVideo = async (btn, videoId) => {
    btn.disabled = true;
    try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
    try {
        const res = await fetch('/api/likeVideo', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth(), videoId })
        });
        const data = await res.json();
        if (data && data.success) {
            btn.querySelector('.like-count').innerText = data.likesCount;
            const emo = btn.querySelector('.react-emoji'); if (emo) emo.classList.add('hidden');
            syncReactionUI('video', videoId, data);
            const icon = btn.querySelector('i');
            icon.className = (data.hasLiked ? 'fas fa-heart text-red-500 text-2xl' : 'far fa-heart text-2xl') + ' icon-pop';
        }
    } catch(e) { console.error("Video like failed:", e); }
    finally { btn.disabled = false; }
};

window.openShortOptions = (videoId, authorId, type) => {
    const content = document.getElementById('optionsContent');
    openSheet('optionsModalBg', 'optionsSheet');

    let isMine = false;
    if (currentUser) {
        if (type === 'channel') {
            isMine = currentUser.channels && currentUser.channels.some(c => String(c.id) === String(authorId));
        } else {
            isMine = String(authorId) === String(currentUser.tg_id);
        }
    }

    content.innerHTML = `
        <button onclick="copyContentLink('video', '${videoId}')" class="opt-item opt-blue"><span class="opt-icon"><i class="fas fa-link"></i></span><span>Copy Link<small>Share it anywhere</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
        <button onclick="saveVideoToChat('${videoId}')" class="opt-item opt-green"><span class="opt-icon"><i class="fas fa-download"></i></span><span>Save<small>Send to your chat</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
        ${isMine
            ? `<button onclick="deleteVideoDirect('${videoId}')" class="opt-item opt-red"><span class="opt-icon"><i class="fas fa-trash-alt"></i></span><span>Delete Video<small>Cannot be undone</small></span><i class="fas fa-chevron-right opt-chev"></i></button>`
            : `<button onclick="openReportSheet('${videoId}', 'video')" class="opt-item opt-orange"><span class="opt-icon"><i class="fas fa-flag"></i></span><span>Report<small>Tell us what is wrong</small></span><i class="fas fa-chevron-right opt-chev"></i></button>`}
    `;
};

window.saveVideoToChat = async (videoId) => {
    closeSheet('optionsModalBg', 'optionsSheet');
    try {
        const res = await fetch('/api/saveVideo', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), videoId }) });
        const data = await res.json();
        if (data && data.success) tg.showAlert("Saved! Check your chat with the bot.");
        else tg.showAlert(`Failed: ${data.error || 'Server error'}`);
    } catch(e) { tg.showAlert("Save failed."); }
};

window.deleteVideoDirect = (videoId) => {
    closeSheet('optionsModalBg', 'optionsSheet');
    tg.showConfirm("Delete this video?", async (ok) => {
        if (!ok) return;
        const res = await fetch('/api/deleteVideo', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), videoId }) });
        const data = await res.json();
        if (data && data.success) {
            const el = document.querySelector(`.short-item[data-video-id="${videoId}"]`);
            if (el) el.remove();
        }
    });
};

// Video upload (Add Short)
let selectedVideoBase64 = null;
document.getElementById('videoUploadInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
        tg.showAlert("Video must be under 15MB.");
        this.value = '';
        return;
    }
    document.getElementById('videoFileName').innerText = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => { selectedVideoBase64 = ev.target.result; };
    reader.readAsDataURL(file);
});

document.getElementById('submitVideoBtn').addEventListener('click', async () => {
    if (!selectedVideoBase64) return tg.showAlert("Choose a video first.");
    const btn = document.getElementById('submitVideoBtn');
    btn.innerText = "Uploading..."; btn.disabled = true;
    try {
        const res = await fetch('/api/createVideo', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth(), caption: document.getElementById('videoCaptionText').value, videoBase64: selectedVideoBase64 })
        });
        const data = await res.json();
        if (data && data.success) {
            tg.showAlert("Short uploaded!");
            closeModal('videoUploadModal');
            document.getElementById('videoCaptionText').value = '';
            document.getElementById('videoFileName').innerText = '';
            selectedVideoBase64 = null;
            loadShorts(true);
        } else {
            tg.showAlert(`Upload failed: ${data.error || 'Server error'}`);
        }
    } catch(e) {
        tg.showAlert("Upload failed: network error.");
    } finally {
        btn.innerText = "Upload"; btn.disabled = false;
    }
});

window.goBackFromShorts = () => { if (typeof exitShorts === 'function') exitShorts(); else switchTab('home'); };
