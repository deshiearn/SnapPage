'use strict';
// ================= SHORTS (TikTok-style video feed) =================
let shortsPage = 1;
let isLoadingShorts = false;
let hasMoreShorts = true;
let shortsObserver = null;
// Videos must start muted so autoplay isn't blocked by the browser; tapping the
// sound button is a real user gesture, so we can safely unmute from then on.
let shortsMuted = true;

async function loadShorts(reset = false) {
    if (isLoadingShorts) return;
    isLoadingShorts = true;
    const feed = document.getElementById('shortsFeed');
    if (reset) { feed.innerHTML = ''; shortsPage = 1; hasMoreShorts = true; }

    try {
        const res = await fetch('/api/getShorts', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ page: shortsPage, limit: 5 })
        });
        const videos = await res.json();

        if (!videos || videos.length === 0) {
            hasMoreShorts = false;
            if (reset) document.getElementById('shortsEmptyState').classList.remove('hidden');
            return;
        }
        document.getElementById('shortsEmptyState').classList.add('hidden');
        if (videos.length < 5) hasMoreShorts = false;

        videos.forEach(v => feed.insertAdjacentHTML('beforeend', renderShortItem(v)));
        observeShorts();
    } catch (e) {
        console.error("Shorts load failed:", e);
    } finally {
        document.getElementById('shortsEntryLoading').classList.add('hidden');
        isLoadingShorts = false;
    }
}

function renderShortItem(v) {
    const myReaction = currentUser && v.reactions ? (v.reactions[currentUser.tg_id] || '') : '';
    const shortLikeCount = (v.likes_count || 0) + Object.keys(v.reactions || {}).length;
    const hasLiked = v.likes_users && currentUser && v.likes_users.includes(currentUser.tg_id);
    const verifiedIcon = v.author_verified ? ' <i class="fas fa-check-circle verified-badge" style="color:#3b82f6"></i>' : '';
    const captionHtml = animateEmojis(formatCaption(v.caption, v.author_level || 1, v.entities));
    const plainLength = (v.caption || '').length;
    return `
    <div class="short-item fade-in w-full h-full snap-start relative flex items-center justify-center bg-black" style="scroll-snap-align: start;" data-video-id="${v.id}">
        <video class="w-full h-full object-contain" src="${v.stream_url}" loop muted playsinline preload="auto"
            onwaiting="this.closest('.short-item').querySelector('.short-loading').classList.remove('hidden')"
            onplaying="this.closest('.short-item').querySelector('.short-loading').classList.add('hidden')"
            oncanplay="this.closest('.short-item').querySelector('.short-loading').classList.add('hidden')"
            onpause="this.closest('.short-item').querySelector('.short-pause-indicator').classList.remove('hidden')"
            onplay="this.closest('.short-item').querySelector('.short-pause-indicator').classList.add('hidden')"></video>

        <div class="short-loading hidden absolute inset-0 flex items-center justify-center pointer-events-none">
            <div class="w-10 h-10 border-4 border-white/30 border-t-white rounded-full" style="animation: spin 0.8s linear infinite;"></div>
        </div>

        <div class="short-pause-indicator hidden absolute inset-0 flex items-center justify-center pointer-events-none">
            <div class="bg-black/40 rounded-full w-16 h-16 flex items-center justify-center">
                <i class="fas fa-pause text-white text-3xl"></i>
            </div>
        </div>

        <!-- Tap zones: middle tap toggles play/pause; double-tap left/right seeks -5s/+5s -->
        <div class="absolute inset-0" onclick="handleShortTap(event, '${v.id}')">
            <div class="short-seek-left absolute left-0 top-0 h-full w-1/2 flex items-center justify-center gap-1 opacity-0 pointer-events-none transition-opacity duration-300">
                <i class="fas fa-backward text-white text-2xl"></i><span class="text-white text-xs font-bold">5s</span>
            </div>
            <div class="short-seek-right absolute right-0 top-0 h-full w-1/2 flex items-center justify-center gap-1 opacity-0 pointer-events-none transition-opacity duration-300">
                <i class="fas fa-forward text-white text-2xl"></i><span class="text-white text-xs font-bold">5s</span>
            </div>
        </div>

        <div class="absolute top-4 left-4 right-16 flex items-center gap-2 cursor-pointer" style="top: calc(env(safe-area-inset-top, 24px) + 60px);" onclick="openProfile('${v.author_id}')">
            <img src="${v.author_photo}" class="w-9 h-9 rounded-full border-2 border-white object-cover">
            <span class="text-white text-sm font-bold drop-shadow">${v.author_name}${verifiedIcon}</span>
        </div>

        <div class="absolute right-3 bottom-28 flex flex-col items-center gap-5 text-white">
            <button onclick="likeVideo(this, '${v.id}')" data-react="video" data-id="${v.id}" class="react-btn flex flex-col items-center gap-1">
                <span class="react-emoji text-2xl ${myReaction ? '' : 'hidden'}">${myReaction}</span><i class="${myReaction ? 'hidden ' : ''}${hasLiked ? 'fas fa-heart text-red-500' : 'far fa-heart'} text-2xl"></i>
                <span class="text-xs like-count">${shortLikeCount}</span>
            </button>
            <button onclick="openComments('${v.id}', 'video')" class="flex flex-col items-center gap-1">
                <i class="fas fa-comment text-2xl"></i>
                <span class="text-xs">Comment</span>
            </button>
            <button onclick="shareVideoDirectly('${v.id}')" class="flex flex-col items-center gap-1">
                <i class="fas fa-share text-2xl"></i>
                <span class="text-xs">Share</span>
            </button>
            <button onclick="openShortOptions('${v.id}', '${v.author_id}', '${v.type}')">
                <i class="fas fa-ellipsis-v text-2xl"></i>
            </button>
        </div>

        <div class="absolute left-3 right-20 bottom-8 text-white pointer-events-none">
            <div class="pointer-events-auto inline-block">
                <p class="text-sm caption-clamp" data-full="${escapeHtml(v.caption || '').replace(/"/g, '&quot;')}">${captionHtml}</p>
                <button onclick="toggleCaption(this)" class="hidden see-more-btn text-xs font-bold text-gray-300 mt-1">See more</button>
            </div>
        </div>
    </div>`;
}

// Double-tap left/right to seek -5s/+5s; a single tap in the middle toggles play/pause
let shortTapState = {};
window.handleShortTap = (e, videoId) => {
    const container = e.currentTarget.closest('.short-item');
    const video = container.querySelector('video');
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const isRight = (x - rect.left) > rect.width / 2;
    const now = Date.now();
    const key = videoId + (isRight ? '_r' : '_l');
    const last = shortTapState[key] || 0;

    if (now - last < 350) {
        shortTapState[key] = 0;
        if (video) {
            video.currentTime = isRight
                ? Math.min(video.duration || (video.currentTime + 5), video.currentTime + 5)
                : Math.max(0, video.currentTime - 5);
        }
        const indicator = container.querySelector(isRight ? '.short-seek-right' : '.short-seek-left');
        if (indicator) {
            indicator.classList.remove('opacity-0');
            setTimeout(() => indicator.classList.add('opacity-0'), 400);
        }
    } else {
        shortTapState[key] = now;
        setTimeout(() => {
            if (shortTapState[key] === now && video) {
                if (video.paused) video.play().catch(() => {}); else video.pause();
            }
        }, 300);
    }
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
function animateEmojis(html) {
    if (!html) return html;
    const re = /(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*)/gu;
    return html.split(/(<[^>]*>)/).map(part => part.startsWith('<') ? part : part.replace(re, '<span class="emoji-pop">$1</span>')).join('');
}

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
    if (icon) icon.className = shortsMuted ? 'fas fa-volume-mute' : 'fas fa-volume-up';
};

// Reloads the Shorts feed from the top with fresh videos
window.refreshShorts = async () => {
    const icon = document.getElementById('shortsRefreshIcon');
    if (icon) icon.classList.add('fa-spin');
    document.getElementById('shortsFeed').scrollTo({ top: 0 });
    await loadShorts(true);
    if (icon) icon.classList.remove('fa-spin');
};

// Autoplay the Short in view, pause the rest — classic TikTok scroll behavior
function observeShorts() {
    if (shortsObserver) shortsObserver.disconnect();
    shortsObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const video = entry.target.querySelector('video');
            if (!video) return;
            if (entry.isIntersecting) {
                video.muted = shortsMuted; // respect the current sound preference every time a video (re)starts
                video.play().catch(() => {});
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

window.shareVideoDirectly = (id) => {
    const forwardLink = `https://t.me/SnapPagesBot/app?startapp=video_${id}`;
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(forwardLink)}&text=${encodeURIComponent('Check out this Short on SnapPages!')}`);
};

window.likeVideo = async (btn, videoId) => {
    btn.disabled = true;
    try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
    try {
        const res = await fetch('/api/likeVideo', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tg.initData, videoId })
        });
        const data = await res.json();
        if (data && data.success) {
            btn.querySelector('.like-count').innerText = data.likesCount;
            const emo = btn.querySelector('.react-emoji'); if (emo) emo.classList.add('hidden');
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
        <button onclick="saveVideoToChat('${videoId}')" class="opt-item opt-green"><span class="opt-icon"><i class="fas fa-download"></i></span><span>Save<small>Send to your chat</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
        ${isMine
            ? `<button onclick="deleteVideoDirect('${videoId}')" class="opt-item opt-red"><span class="opt-icon"><i class="fas fa-trash-alt"></i></span><span>Delete Video<small>Cannot be undone</small></span><i class="fas fa-chevron-right opt-chev"></i></button>`
            : `<button onclick="openReportSheet('${videoId}', 'video')" class="opt-item opt-orange"><span class="opt-icon"><i class="fas fa-flag"></i></span><span>Report<small>Tell us what is wrong</small></span><i class="fas fa-chevron-right opt-chev"></i></button>`}
    `;
};

window.saveVideoToChat = async (videoId) => {
    closeSheet('optionsModalBg', 'optionsSheet');
    try {
        const res = await fetch('/api/saveVideo', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tg.initData, videoId }) });
        const data = await res.json();
        if (data && data.success) tg.showAlert("Saved! Check your chat with the bot.");
        else tg.showAlert(`Failed: ${data.error || 'Server error'}`);
    } catch(e) { tg.showAlert("Save failed."); }
};

window.deleteVideoDirect = (videoId) => {
    closeSheet('optionsModalBg', 'optionsSheet');
    tg.showConfirm("Delete this video?", async (ok) => {
        if (!ok) return;
        const res = await fetch('/api/deleteVideo', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tg.initData, videoId }) });
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
            body: JSON.stringify({ initData: tg.initData, caption: document.getElementById('videoCaptionText').value, videoBase64: selectedVideoBase64 })
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
