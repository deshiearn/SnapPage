'use strict';
// Load Posts Feed with Pagination and Infinite Scroll (10 posts at a time)
let feedLoaded = [], feedCursor = null;   // ranked-feed pagination state (see /api/getPosts)
async function loadPosts(page = 1, clearFeed = true) {
    if (isLoadingFeed) return;
    isLoadingFeed = true;

    const feed = document.getElementById('feed');
    if (clearFeed) {
        feed.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fas fa-spinner fa-spin text-3xl"></i></div>';
        currentPage = 1;
        hasMorePosts = true;
        feedLoaded = []; feedCursor = null;
    } else {
        const scrollLoading = document.createElement('div');
        scrollLoading.id = 'feed-scroll-loading';
        scrollLoading.className = 'text-center text-gray-400 py-4';
        scrollLoading.innerHTML = '<i class="fas fa-spinner fa-spin text-xl"></i>';
        feed.appendChild(scrollLoading);
    }
    
    try {
        const res = await fetch('/api/getPosts', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth(), page, limit: 10, feed: feedMode, ranked: true, exclude: feedLoaded.slice(-300), cursor: feedCursor || undefined, seen: getSeenIds('p').slice(-300) })
        });
        const posts = await res.json();
        if (Array.isArray(posts)) posts.forEach(p => { feedLoaded.push(String(p.id)); if (p._older) feedCursor = p.created_at; });

        const indicator = document.getElementById('feed-scroll-loading');
        if (indicator) indicator.remove();

        if (!posts || posts.length === 0) {
            hasMorePosts = false;
            if (clearFeed) {
                feed.innerHTML = feedMode === 'following'
                    ? '<div class="text-center text-gray-400 py-12 px-6"><i class="fas fa-user-plus text-4xl mb-3 opacity-60"></i><p class="font-bold">Your Following feed is empty</p><p class="text-xs mt-1">Tap a name or photo on any post and press Follow to see their posts here.</p></div>'
                    : '<div class="text-center text-gray-400 py-10">No posts on feed.</div>';
            }
            isLoadingFeed = false;
            return;
        }

        if (posts.length < 10) {
            hasMorePosts = false;
        }

        await ensureAds();
        if (clearFeed) adCursor = 0;
        const resolvedHtml = posts.map((post, i) => buildPostCardHtml(post) + (feedAds.length && (i === Math.min(2, posts.length - 1) || i === 7) ? buildAdHtml() : '')).join('');

        if (clearFeed) {
            feed.innerHTML = resolvedHtml;
        } else {
            feed.insertAdjacentHTML('beforeend', resolvedHtml);
        }
    } catch(e) {
        console.error(e);
        if (clearFeed) {
            feed.innerHTML = `<div class="text-center text-red-500 py-10">Failed to load posts from Database. Check your connection.</div>`;
        }
    } finally {
        isLoadingFeed = false;
    }
}

// Builds one post card's HTML — used by the main feed and by shared deep links
function buildPostCardHtml(post) {
    // FIXED: Fallback parser to cleanly convert raw PostgreSQL string arrays into JavaScript arrays
    let imageUrls = post.image_urls;
    if (typeof imageUrls === 'string') {
        if (imageUrls.startsWith('{') && imageUrls.endsWith('}')) {
            imageUrls = imageUrls.slice(1, -1).split(',').map(u => u.trim().replace(/^"|"$/g, ''));
        } else {
            try {
                imageUrls = JSON.parse(imageUrls);
            } catch(e) {
                imageUrls = [imageUrls];
            }
        }
    }

    let imgHtml = '';
    if(imageUrls && Array.isArray(imageUrls) && imageUrls.length > 0 && imageUrls[0] !== "") {
        const valid = imageUrls.filter(Boolean);
        imgHtml = `<div class="mb-3"><div class="flex img-slider gap-1 rounded-lg overflow-x-auto" onscroll="handleImgSliderScroll(this)">`;
        valid.forEach(url => {
            imgHtml += `<div class="img-snap w-full flex-shrink-0 img-skeleton rounded-lg overflow-hidden" style="min-height:180px"><img src="${url}" loading="lazy" onload="this.classList.add('loaded');this.parentElement.classList.remove('img-skeleton');this.parentElement.style.minHeight=0" onclick="openLightbox('${url}')" class="post-img w-full h-auto cursor-pointer" style="max-height:75vh;object-fit:contain"></div>`;
        });
        imgHtml += `</div>`;
        if (valid.length > 1) imgHtml += `<div class="flex justify-center gap-1.5 mt-2">${valid.map((_, i) => `<span class="img-dot ${i === 0 ? 'active' : ''}"></span>`).join('')}</div>`;
        imgHtml += `</div>`;
    }

    const isRich = post.rich && post.rich.blocks && post.rich.blocks.length;
    const captionHtml = animateEmojis(formatCaption(post.text, post.author_level || 1, post.entities));
    const hasLiked = post.likes_users && currentUser && post.likes_users.includes(currentUser.tg_id);
    const myReaction = currentUser && post.reactions ? (post.reactions[currentUser.tg_id] || '') : '';
    const likeCount = (post.likes_count || 0) + Object.keys(post.reactions || {}).length;
    const verifiedIcon = (post.author_verified ? ' <i class="fas fa-check-circle verified-badge"></i>' : '') + (post.author_founder ? ' <i class="fas fa-crown founder-mini" title="Founder"></i>' : '');
    const pinnedBadge = post.is_pinned ? '<span class="text-[9px] px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800 font-bold ml-1"><i class="fas fa-thumbtack"></i> Pinned</span>' : '';

    // FIXED: Dynamic Level Badge with [Channel] or [User] labels
    const labelBadge = post.type === 'channel'
        ? '<span class="text-[9px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-bold">Channel</span>'
        : `<span class="text-[9px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-800 font-bold">Level ${post.author_level || 1} [User]</span>`;

    return `
        <div class="post-card bg-white p-4 rounded-xl shadow-sm border mb-4 fade-in" ${(currentUser && String(post.author_id) === String(currentUser.tg_id)) ? '' : `data-view-post="${post.id}"`}>
            <div class="flex justify-between items-center mb-3">
                <div class="flex items-center space-x-3 cursor-pointer" onclick="openProfile('${post.author_id}')">
                    <img src="${post.author_photo}" class="w-10 h-10 rounded-full object-cover">
                    <div>
                        <h3 class="font-bold text-sm text-gray-900">${post.author_name}${verifiedIcon}</h3>
                        ${labelBadge}${pinnedBadge}<span class="text-[10px] text-gray-400 ml-1.5"><i class="fas fa-eye"></i> ${post.views || 0}</span>
                    </div>
                </div>
                <button onclick="openPostOptions('${post.id}', '${post.author_id}', '${post.type}')" class="text-gray-400 hover:text-gray-600 p-2"><i class="fas fa-ellipsis-v"></i></button>
            </div>
            ${isRich ? `<div class="mb-3">${renderRich(post.rich)}</div>` : `<p class="mb-1 text-sm whitespace-pre-wrap text-gray-800 caption-clamp">${captionHtml}</p>
            <button onclick="toggleCaption(this)" class="hidden see-more-btn text-xs font-bold text-blue-500 mb-3">${t('see_more')}</button>
            <div class="mb-3 see-more-spacer"></div>
            ${imgHtml}`}
            <div class="react-row flex flex-wrap gap-1.5 mb-2" data-react-row="post:${post.id}">${buildReactionRowHtml('post', post.id, post.likes_count || 0, post.reactions || {}, hasLiked)}</div>
            <div class="flex justify-between text-gray-500 text-sm pt-3 border-t">
                <button onclick="likePost(this, '${post.id}')" data-react="post" data-id="${post.id}" class="react-btn ${hasLiked || myReaction ? 'text-red-500 font-bold' : ''} hover:text-red-500 flex items-center gap-1">
                    <span class="react-emoji ${myReaction ? '' : 'hidden'}">${myReaction}</span><i class="${myReaction ? 'hidden ' : ''}${hasLiked ? 'fas fa-heart text-red-500' : 'far fa-heart'}"></i> ${t('like')} (<span class="like-count">${likeCount}</span>)
                </button>
                <button onclick="openComments('${post.id}')" class="hover:text-blue-500 flex items-center gap-1"><i class="fas fa-comment"></i> ${t('comment')}</button>
                <button onclick="sharePostDirectly('${post.id}')" class="hover:text-green-500 flex items-center gap-1"><i class="fas fa-share"></i> ${t('share')}</button>
            </div>
        </div>`;
}

// Register window scroll listener for infinite scroll mechanism
window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 100) {
        if (!isLoadingFeed && hasMorePosts) {
            currentPage++;
            loadPosts(currentPage, false);
        }
    }
});

// ================= Feed tabs (For You / Following) =================
window.setFeedMode = (mode) => {
    if (feedMode === mode) return;
    feedMode = mode;
    document.getElementById('feedTabAll').classList.toggle('active', mode === 'all');
    document.getElementById('feedTabFollowing').classList.toggle('active', mode === 'following');
    try { tg.HapticFeedback.selectionChanged(); } catch (e) {}
    loadPosts(1, true);
};


// ---------- Ads (created in Admin panel → Ads) ----------
let feedAds = null, adCursor = 0;
async function ensureAds() {
    if (feedAds) return;
    feedAds = [];
    try { const r = await fetch('/api/getAds'); const d = await r.json(); if (Array.isArray(d)) feedAds = d; } catch (e) {}
}
function buildAdHtml() {
    const ad = feedAds[adCursor++ % feedAds.length];
    if (!ad) return '';
    const img = ad.image_url ? `<img src="${ad.image_url}" class="ad-img" loading="lazy" alt="">` : '';
    return `<div class="post-card ad-card bg-white fade-in ${ad.image_url ? '' : 'ad-noimg'}" data-ad="${ad.id}">
        <div class="ad-tag">Sponsored</div>${img}
        <div class="ad-body"><h4>${escapeHtml(ad.title)}</h4>${ad.body ? `<p>${escapeHtml(ad.body)}</p>` : ''}
        ${ad.link_url ? `<button class="ad-btn" onclick="adClick(${ad.id}, '${escapeHtml(ad.link_url)}')">${escapeHtml(ad.button_text || 'Learn more')}</button>` : ''}</div></div>`;
}
window.adClick = (id, url) => {
    try { fetch('/api/adEvent', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, type: 'click' }), keepalive: true }); } catch (e) {}
    /t\.me\//.test(url) ? tg.openTelegramLink(url) : tg.openLink(url);
};
// count an impression once when an ad scrolls into view
const adObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((es) => es.forEach(e => {
    if (!e.isIntersecting) return;
    adObserver.unobserve(e.target);
    try { fetch('/api/adEvent', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id: e.target.dataset.ad, type: 'view' }), keepalive: true }); } catch (x) {}
}), { threshold: 0.6 }) : null;
if (adObserver) new MutationObserver(() => document.querySelectorAll('.ad-card:not([data-obs])').forEach(el => { el.dataset.obs = 1; adObserver.observe(el); }))
    .observe(document.getElementById('feed'), { childList: true });
