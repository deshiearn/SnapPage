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
            body: JSON.stringify({ initData: tgAuth(), authorId })
        });
        const p = await res.json();
        if (!p || !p.id) throw new Error(p && p.error || 'Profile not found');
        currentProfile = p;
        renderProfile(p);
        showProfileTab('posts');
    } catch (e) {
        body.innerHTML = `<div class="text-center text-gray-400 py-16 px-6"><i class="fas fa-user-slash text-4xl mb-3 opacity-60"></i><p class="font-bold">Profile not available</p></div>`;
    }
};

function renderProfile(p) {
    const isChannel = p.type === 'channel';
    const verified = (p.verified || p.founder) ? ' <i class="fas fa-check-circle text-blue-500 text-base"></i>' : '';
    const handle = p.handle || p.username;
    const followBtn = p.isSelf
        ? `<button onclick="closeSheet('profileModalBg','profileSheet');openEditProfile()" class="follow-btn following"><i class="fas fa-pen"></i> ${t('edit_profile')}</button>`
        : `<button id="profileFollowBtn" onclick="toggleFollow()" class="follow-btn ${p.isFollowing ? 'following' : ''}">${p.isFollowing ? t('following') : t('follow')}</button>`;
    const canTg = !String(p.id).startsWith('g') && !p.isSelf && (p.username || !isChannel);
    const tgBtn = canTg
        ? `<button onclick="openProfileLink('${p.type}', '${p.id}', '${p.username || ''}')" class="pf-tg-btn"><i class="fas fa-paper-plane"></i> ${isChannel ? t('visit_tg') : t('chat_tg')}</button>` : '';
    const founder = p.founder
        ? `<div class="founder-pill"><i class="fas fa-crown founder-star"></i> ${t('founder')}</div>` : '';
    document.getElementById('profileBody').innerHTML = `
        <div class="pf-hero ${p.founder ? 'pf-founder' : ''}" style="${heroStyle(p.id)}">
            <button onclick="closeSheet('profileModalBg','profileSheet')" class="tgme-circle" style="left:14px;top:18px" aria-label="Close"><i class="fas fa-times"></i></button>
            <button onclick="shareProfileLink()" class="tgme-circle" style="right:14px;top:18px" aria-label="Share"><i class="fas fa-share"></i></button>
            <img src="${p.photo}" class="pf-avatar" onerror="this.src='https://ui-avatars.com/api/?name=U'">
            <h2 class="pf-name">${escapeHtml(p.name || 'User')}${verified}</h2>
            ${founder}
            <p class="pf-handle">${isChannel ? 'Channel' : 'Level ' + (p.level || 1)}${handle ? ' · @' + escapeHtml(handle) : ''}</p>
        </div>
        <div class="px-4 pb-2">
            <div class="pf-stats">
                <div class="profile-stat"><b>${p.posts}</b><span>${t('posts')}</span></div>
                <div class="profile-stat"><b>${p.reels || 0}</b><span>${t('reels')}</span></div>
                <div class="profile-stat"><b id="profileFollowers">${p.followers}</b><span>${t('followers')}</span></div>
                ${!isChannel ? `<div class="profile-stat"><b>${p.following}</b><span>${t('following_n')}</span></div>` : ''}
            </div>
            <div class="pf-actions">${followBtn}</div>
            <div class="pf-sub">
                <button onclick="copyProfileLink()"><i class="fas fa-link"></i> ${t('copy_link')}</button>
                ${tgBtn}
            </div>
        </div>
        <div class="flex border-b mx-4">
            <button id="ptab-posts" onclick="showProfileTab('posts')" class="profile-tab flex-1 py-2.5 text-sm font-bold"><i class="fas fa-image"></i> ${t('posts')}</button>
            <button id="ptab-reels" onclick="showProfileTab('reels')" class="profile-tab flex-1 py-2.5 text-sm font-bold"><i class="fas fa-film"></i> ${t('reels')}</button>
        </div>
        <div id="profilePosts" class="pt-4 space-y-4 px-4 pb-10"></div>`;
}

// Profile link: opens the app straight on this profile; "_ref_<me>" makes new users count as my invites
function profileLink() {
    return `https://t.me/SnapPagesBot/app?startapp=profile_${currentProfile.id}${refSuffix()}`;
}
window.copyProfileLink = () => {
    if (!currentProfile) return;
    const link = profileLink();
    const done = () => { try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {} tg.showAlert('Profile link copied!'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => fallbackCopy(link, done));
    else fallbackCopy(link, done);
};
function fallbackCopy(text, cb) {
    const t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); } catch (e) {}
    t.remove(); cb();
}
window.shareProfileLink = () => {
    if (!currentProfile) return;
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(profileLink())}&text=${encodeURIComponent((currentProfile.name || 'Profile') + ' on SnapPages')}`);
};

window.showProfileTab = (tab) => {
    if (!currentProfile) return;
    ['posts', 'reels'].forEach(t => {
        const b = document.getElementById('ptab-' + t);
        if (b) b.classList.toggle('active', t === tab);
    });
    const box = document.getElementById('profilePosts');
    if (!box) return;
    box.innerHTML = '<div class="text-center text-gray-400 py-6"><i class="fas fa-spinner fa-spin"></i></div>';
    box.className = tab === 'reels' ? 'pt-3 px-4 pb-10' : 'pt-4 space-y-4 px-4 pb-10';
    (tab === 'reels' ? loadProfileReels : loadProfilePosts)(currentProfile.id);
};

async function loadProfileReels(authorId) {
    try {
        const res = await fetch('/api/getShorts', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ page: 1, limit: 12, authorId })
        });
        const vids = await res.json();
        const box = document.getElementById('profilePosts');
        if (!box || !currentProfile || currentProfile.id !== authorId) return;
        box.innerHTML = (vids && vids.length)
            ? `<div class="grid grid-cols-3 gap-1">${vids.map(v => `
                <button onclick="openReelFromProfile('${v.id}')" class="reel-thumb relative overflow-hidden bg-black" style="aspect-ratio:9/16">
                    <video src="${v.stream_url}#t=0.1" preload="metadata" muted playsinline class="w-full h-full object-cover pointer-events-none"></video>
                    <span class="absolute bottom-1 left-1 text-white text-[11px] font-bold drop-shadow"><i class="fas fa-play"></i> ${v.likes_count || 0}</span>
                </button>`).join('')}</div>`
            : '<div class="text-center text-gray-400 py-8 text-sm">No reels yet.</div>';
    } catch (e) { /* keep spinner */ }
}

// Tapping a thumbnail leaves the profile and opens the main Reels page on that reel
window.openReelFromProfile = (id) => {
    closeSheet('profileModalBg', 'profileSheet');
    openShortById(id);
};

async function loadProfilePosts(authorId) {
    try {
        const res = await fetch('/api/getPosts', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth(), page: 1, limit: 10, authorId })
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
            body: JSON.stringify({ initData: tgAuth(), targetId: currentProfile.id })
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


// ---------- Edit my name / @username ----------
window.openEditProfile = () => {
    if (!currentUser) return;
    document.getElementById('epName').value = currentUser.name || '';
    document.getElementById('epUser').value = currentUser.app_username || '';
    pendingPhoto = null;
    document.getElementById('epPhotoPreview').src = currentUser.photo_url || 'https://ui-avatars.com/api/?name=U';
    document.getElementById('epError').classList.add('hidden');
    openModal('editProfileModal');
};
window.MB_SCREENS.editProfileModal = () => MB.show('editProfileModal', { text: 'Save', onClick: () => saveProfileEdit(), inPage: document.getElementById('epSave') });

window.saveProfileEdit = async () => {
    const err = document.getElementById('epError');
    err.classList.add('hidden');
    if (window.MB) MB.update('editProfileModal', { busy: true });
    try {
        const res = await fetch('/api/setProfile', { method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth(), name: document.getElementById('epName').value, username: document.getElementById('epUser').value, photoBase64: pendingPhoto }) });
        const d = await res.json();
        if (!(d && d.success)) throw new Error((d && d.error) || 'Could not save');
        currentUser.name = d.name; currentUser.app_username = d.username || null;
        if (d.photo) currentUser.photo_url = d.photo;
        refreshProfileHeader();
        closeModal('editProfileModal');
        try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
    } catch (e) {
        err.textContent = e.message || 'Could not save'; err.classList.remove('hidden');
        try { tg.HapticFeedback.notificationOccurred('error'); } catch (x) {}
    }
    if (window.MB) MB.update('editProfileModal', { busy: false });
};


// ---------- Profile photo (in the Edit Profile sheet) ----------
let pendingPhoto = null;
window.pickProfilePhoto = (input) => {
    const f = input.files && input.files[0]; input.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = (e) => {
        const img = new Image();
        img.onload = () => {
            const k = Math.min(1, 640 / Math.min(img.width, img.height));     // square-ish 640px max keeps it light
            const c = document.createElement('canvas');
            const side = Math.min(img.width, img.height);                       // centre-crop to a square
            c.width = c.height = Math.round(side * k);
            c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, c.width, c.height);
            pendingPhoto = c.toDataURL('image/jpeg', 0.88);
            document.getElementById('epPhotoPreview').src = pendingPhoto;
        };
        img.src = e.target.result;
    };
    r.readAsDataURL(f);
};

// ---------- Settings: notifications switch + legal pages ----------
window.setNotifyPref = async (on) => {
    try {
        const r = await fetch('/api/setNotify', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ initData: tgAuth(), enabled: on }) });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'failed');
        if (currentUser) currentUser.notify_enabled = on;
    } catch (e) {
        document.getElementById('notifyToggle').checked = !on;
        tg.showAlert(String(e.message || e));
    }
};

const LEGAL = {
    privacy: {
        en: ['Privacy Policy', ['SnapPages is a Telegram Mini App. We only store what is needed to run the app: your Telegram ID, name, username, profile photo link, and the posts, comments, reactions and follows you create.', 'We do not sell your data and we do not show it to anyone except what you choose to post publicly (your name, photo and posts are visible to other users).', 'Photos and videos you upload are kept in a private Telegram storage channel and shown through this app.', 'Telegram bot messages (likes, comments, follows) are sent only if you leave Notifications switched on in Settings. You can turn them off at any time.', 'You can delete your posts at any time. To remove your account data, contact support from Settings.', 'We may update this policy; continued use means you accept the changes.']],
        bn: ['প্রাইভেসি পলিসি', ['SnapPages একটি Telegram Mini App। অ্যাপ চালাতে যতটুকু দরকার শুধু ততটুকুই আমরা সংরক্ষণ করি: আপনার Telegram ID, নাম, ইউজারনেম, প্রোফাইল ছবির লিংক এবং আপনার তৈরি পোস্ট, কমেন্ট, রিয়্যাকশন ও ফলো।', 'আমরা আপনার তথ্য বিক্রি করি না। আপনি যা পাবলিকলি পোস্ট করেন (নাম, ছবি, পোস্ট) শুধু সেটুকুই অন্য ব্যবহারকারীরা দেখতে পায়।', 'আপনার আপলোড করা ছবি ও ভিডিও একটি প্রাইভেট Telegram স্টোরেজ চ্যানেলে রাখা হয় এবং অ্যাপের মাধ্যমে দেখানো হয়।', 'সেটিংসে নোটিফিকেশন চালু থাকলেই শুধু Telegram বটে লাইক, কমেন্ট, ফলো ইত্যাদির মেসেজ যায়। যেকোনো সময় বন্ধ করা যায়।', 'আপনি যেকোনো সময় নিজের পোস্ট মুছতে পারেন। অ্যাকাউন্টের তথ্য মুছতে সেটিংস থেকে সাপোর্টে যোগাযোগ করুন।', 'এই পলিসি আপডেট হতে পারে; অ্যাপ ব্যবহার চালিয়ে গেলে পরিবর্তন মেনে নেওয়া হয়।']]
    },
    terms: {
        en: ['Terms of Use', ['Be respectful. Do not post illegal, hateful, sexual, violent or misleading content, and do not spam or impersonate others.', 'You are responsible for what you post and you must own or have the right to share it.', 'We may remove content or restrict accounts that break these rules. Use the Report option on any post or video to flag problems.', 'Channel posts shown in the app belong to their channel owners.', 'The service is provided as-is and may change or pause at any time.']],
        bn: ['ব্যবহারের শর্তাবলি', ['সবার প্রতি সম্মান বজায় রাখুন। অবৈধ, ঘৃণামূলক, যৌন, সহিংস বা বিভ্রান্তিকর কনটেন্ট দেবেন না; স্প্যাম বা অন্যের ছদ্মবেশ ধারণ করবেন না।', 'আপনি যা পোস্ট করেন তার দায় আপনার, এবং তা শেয়ার করার অধিকার আপনার থাকতে হবে।', 'নিয়ম ভাঙলে কনটেন্ট সরানো বা অ্যাকাউন্ট সীমিত করা হতে পারে। সমস্যা জানাতে যেকোনো পোস্ট বা ভিডিওর Report অপশন ব্যবহার করুন।', 'অ্যাপে দেখানো চ্যানেল পোস্টের মালিক সংশ্লিষ্ট চ্যানেল মালিক।', 'সেবাটি যেমন আছে তেমন দেওয়া হয় এবং যেকোনো সময় পরিবর্তন বা বন্ধ হতে পারে।']]
    }
};
window.openLegal = (kind) => {
    const d = LEGAL[kind][getLang()] || LEGAL[kind].en;
    document.getElementById('legalTitle').textContent = d[0];
    document.getElementById('legalBody').innerHTML = d[1].map(x => `<p>${escapeHtml(x)}</p>`).join('');
    openSheet('legalModalBg', 'legalSheet');
};

window.openMyProfile = () => { if (currentUser) openProfile(String(currentUser.tg_id)); };
window.shareMyProfile = () => {
    if (!currentUser) return;
    const link = `https://t.me/SnapPagesBot/app?startapp=profile_${currentUser.tg_id}${refSuffix()}`;
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent((currentUser.name || 'My profile') + ' on SnapPages')}`);
};

// Telegram-style per-person header colour (stable hue from the id)
window.heroStyle = (id) => {
    let h = 0; String(id).split('').forEach(c => { h = (h * 31 + c.charCodeAt(0)) % 360; });
    return `--hero1:hsl(${h} 72% 64%);--hero2:hsl(${(h + 28) % 360} 68% 46%)`;
};
