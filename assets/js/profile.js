'use strict';
// ================= Profile sheet (users & channels) + Follow =================
let currentProfile = null;

window.openProfile = async (authorId) => {
    const body = document.getElementById('profileBody');
    body.innerHTML = '<div class="text-center text-gray-400 py-16"><i class="fas fa-spinner fa-spin text-3xl"></i></div>';
    // If another sheet (comments / options) is open on top of the feed, close it first
    openSheet('profileModalBg', 'profileSheet');
    try {
        const res = await fetch('/api/getProfile', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tg.initData, authorId })
        });
        const p = await res.json();
        if (!p || !p.id) throw new Error(p && p.error || 'Profile not found');
        currentProfile = p;
        renderProfile(p);
        loadProfilePosts(p.id);
    } catch (e) {
        body.innerHTML = `<div class="text-center text-gray-400 py-16 px-6"><i class="fas fa-user-slash text-4xl mb-3 opacity-60"></i><p class="font-bold">Profile not available</p></div>`;
    }
};

function renderProfile(p) {
    const verified = p.verified ? ' <i class="fas fa-check-circle text-blue-500 text-sm"></i>' : '';
    const kind = p.type === 'channel' ? 'Channel' : 'Level ' + (p.level || 1);
    const followBtn = p.isSelf
        ? '<span class="text-xs text-gray-400 font-semibold">This is you</span>'
        : `<button id="profileFollowBtn" onclick="toggleFollow()" class="follow-btn ${p.isFollowing ? 'following' : ''}">${p.isFollowing ? 'Following' : 'Follow'}</button>`;
    const tgBtn = (p.username || p.type === 'user')
        ? `<button onclick="openProfileLink('${p.type}', '${p.id}', '${p.username || ''}')" class="text-xs font-bold text-blue-500 mt-2"><i class="fas fa-paper-plane"></i> Open in Telegram</button>` : '';
    document.getElementById('profileBody').innerHTML = `
        <div class="flex flex-col items-center text-center pt-1 pb-4 border-b">
            <img src="${p.photo}" class="w-20 h-20 rounded-full object-cover shadow-md mb-2" onerror="this.src='https://ui-avatars.com/api/?name=U'">
            <h2 class="font-extrabold text-lg">${escapeHtml(p.name || 'User')}${verified}</h2>
            <p class="text-xs text-gray-400">${p.username ? '@' + escapeHtml(p.username) + ' · ' : ''}${kind}</p>
            <div class="flex gap-8 my-4">
                <div class="profile-stat"><b>${p.posts}</b><span>Posts</span></div>
                <div class="profile-stat"><b id="profileFollowers">${p.followers}</b><span>Followers</span></div>
                ${p.type === 'user' ? `<div class="profile-stat"><b>${p.following}</b><span>Following</span></div>` : ''}
            </div>
            ${followBtn}
            ${tgBtn}
        </div>
        <div id="profilePosts" class="pt-4 space-y-4"><div class="text-center text-gray-400 py-6"><i class="fas fa-spinner fa-spin"></i></div></div>`;
}

async function loadProfilePosts(authorId) {
    try {
        const res = await fetch('/api/getPosts', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tg.initData, page: 1, limit: 10, authorId })
        });
        const posts = await res.json();
        const box = document.getElementById('profilePosts');
        if (!box) return;
        box.innerHTML = (posts && posts.length)
            ? posts.map(p => buildPostCardHtml(p)).join('')
            : '<div class="text-center text-gray-400 py-8 text-sm">No posts yet.</div>';
    } catch (e) { /* leave spinner state */ }
}

window.toggleFollow = async () => {
    if (!currentProfile) return;
    const btn = document.getElementById('profileFollowBtn');
    btn.disabled = true;
    try {
        const res = await fetch('/api/toggleFollow', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tg.initData, targetId: currentProfile.id })
        });
        const data = await res.json();
        if (data && data.success) {
            currentProfile.isFollowing = data.following;
            btn.textContent = data.following ? 'Following' : 'Follow';
            btn.classList.toggle('following', data.following);
            btn.classList.add('icon-pop');
            setTimeout(() => btn.classList.remove('icon-pop'), 500);
            const fc = document.getElementById('profileFollowers');
            if (fc) fc.textContent = data.followers;
            try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
            if (feedMode === 'following') loadPosts(1, true);
        } else {
            tg.showAlert((data && data.error) || 'Could not update follow');
        }
    } catch (e) { tg.showAlert('Could not update follow. Check your connection.'); }
    btn.disabled = false;
};
