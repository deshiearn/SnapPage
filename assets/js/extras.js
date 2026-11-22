'use strict';
// ================= Referral System Levels Setup =================
window.openReferSheet = async () => {
    openSheet('referModalBg', 'referSheet');
    
    const link = `https://t.me/SnapPagesBot?start=ref_${currentUser.tg_id}`;
    document.getElementById('referInputLink').value = link;

    const list = document.getElementById('referHistoryList');
    list.innerHTML = '<p class="rf-empty">Loading…</p>';

    try {
        const res = await fetch('/api/getReferStats', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth() })
        });
        
        const stats = await res.json();
        
        const level1Users = stats.level1 || [];
        const level2Users = stats.level2 || [];
        const level3Users = stats.level3 || [];

        document.getElementById('lvl1Count').innerText = level1Users.length;
        document.getElementById('lvl2Count').innerText = level2Users.length;
        document.getElementById('lvl3Count').innerText = level3Users.length;

        const direct = level1Users.length;
        const lvl = direct >= 3 ? 3 : (direct >= 2 ? 2 : 1);
        const lvlLabel = (currentUser && currentUser.is_verified) ? 'Level 3 · Verified' : 'Level ' + lvl;
        document.getElementById('referLevelLabel').innerText = lvlLabel;
        const need = direct >= 3 ? 0 : (direct >= 2 ? 3 - direct : 2 - direct);
        document.getElementById('referProgressBar').style.width = Math.min(100, Math.round(direct / 3 * 100)) + '%';
        document.getElementById('referProgressLabel').innerText = need > 0 ? `${direct}/${direct >= 2 ? 3 : 2} direct referrals — invite ${need} more to reach Level ${lvl + 1}` : 'Max level reached 🎉';

        const tier = { 1: ['Direct', '#3b82f6'], 2: ['2nd tier', '#8b5cf6'], 3: ['3rd tier', '#ec4899'] };
        const renderRow = (user, level) => {
            const avatar = user.photo_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || 'U')}`;
            const handle = user.username ? `@${user.username}` : 'No username';
            return `<div class="rf-row"><img src="${avatar}" loading="lazy" onerror="this.src='https://ui-avatars.com/api/?name=U'">
                <span class="rf-pt">${escapeHtml(user.name || 'User')}<small>${escapeHtml(handle)}</small></span>
                <em style="background:${tier[level][1]}1f;color:${tier[level][1]}">${tier[level][0]}</em></div>`;
        };
        const rows = level1Users.map(u => renderRow(u, 1)).concat(level2Users.map(u => renderRow(u, 2)), level3Users.map(u => renderRow(u, 3)));
        list.innerHTML = rows.length ? rows.join('') : '<p class="rf-empty">No invites yet — share your link to get started.</p>';

    } catch (err) {
        console.error(err);
    }
};

// Native "Invite Friends" button → Telegram's share sheet
window.MB_SCREENS.referModalBg = () => MB.show('referModalBg', { text: 'Invite Friends', onClick: () => {
    const link = document.getElementById('referInputLink').value;
    if (!link) return;
    tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Join me on SnapPages!'));
} });

window.shareReferLink = () => {
    const link = document.getElementById('referInputLink').value;
    if (link) tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent('Join me on SnapPages!'));
};
window.copyReferLinkDirect = () => {
    const input = document.getElementById('referInputLink');
    input.select();
    input.setSelectionRange(0, 99999); 
    try {
        navigator.clipboard.writeText(input.value);
    } catch (err) {
        document.execCommand('copy');
    }
    tg.showAlert("Referral link copied!");
}

// ================= Auto Posting Channel Admin Check setup =================
document.getElementById('setupChannelBtn').onclick = async () => {
    const input = document.getElementById('channelInput').value.trim();
    if(!input) return;

    const btn = document.getElementById('setupChannelBtn');
    btn.innerText = "...";
    btn.disabled = true;

    try {
        const res = await fetch('/api/addChannel', { 
            method: 'POST', 
            headers: {'Content-Type':'application/json'}, 
            body: JSON.stringify({ 
                initData: tgAuth(), 
                channelInput: input 
            }) 
        });
        
        const data = await res.json();
        
        if(data.error) {
            tg.showAlert(`Admin Verification Failed: ${data.error}`);
        } else {
            currentUser.channels = data.channels; 
            renderChannels(); 
            document.getElementById('channelInput').value = '';
        }
    } catch(e) {
        tg.showAlert("Verification payload processing failed.");
    } finally {
        btn.innerText = "SetUp";
        btn.disabled = false;
    }
};

function renderChannels() {
    const list = document.getElementById('channelList');
    list.innerHTML = '';
    (currentUser.channels || []).forEach(c => {
        const isVerified = c.verified || (currentUser && currentUser.is_verified);
        const badge = isVerified ? ' <i class="fas fa-check-circle verified-badge"></i>' : '';
        list.innerHTML += `<div class="flex items-center justify-between bg-gray-50 p-2 rounded-lg border text-gray-900 animate-none">
            <div class="flex items-center gap-2 cursor-pointer" onclick="openProfileLink('channel', '${c.id}', '${c.username || ''}')">
                <img src="${c.photo}" class="w-8 h-8 rounded-full">
                <span class="font-bold text-sm">${c.name}${badge}</span>
            </div>
            <button onclick="removeChannel('${c.id}')" class="text-red-500 bg-red-100 p-2 rounded-full"><i class="fas fa-trash"></i></button>
        </div>`;
    });
}

window.removeChannel = async (id) => {
    const res = await fetch('/api/removeChannel', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), channelId: id }) });
    const data = await res.json();
    currentUser.channels = data.channels; renderChannels();
};

// ================= Search Setup =================
// ================= Home Page Top Search Bar =================
let homeSearchTimeout = null;
document.getElementById('homeSearchInput').addEventListener('input', function() {
    clearTimeout(homeSearchTimeout);
    const val = this.value.trim();
    document.getElementById('homeSearchClearBtn').classList.toggle('hidden', !val);
    if (!val) { clearHomeSearch(); return; }
    homeSearchTimeout = setTimeout(() => performHomeSearch(val), 350);
});

async function performHomeSearch(query) {
    const feed = document.getElementById('feed');
    feed.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fas fa-spinner fa-spin text-3xl"></i></div>';
    try {
        const res = await fetch('/api/searchAll', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ query }) });
        const r = await res.json();
        const people = r.people || [], videos = r.videos || [], posts = r.posts || [];
        if (!people.length && !videos.length && !posts.length) {
            feed.innerHTML = '<div class="text-center text-gray-400 py-10"><i class="fas fa-search text-3xl mb-2 opacity-50"></i><p>Nothing found. Try another name, @username or word.</p></div>';
            return;
        }
        let html = '';
        if (people.length) {
            html += '<div class="srch-sec"><div class="srch-h">People & Channels</div>' + people.map(p => `
                <button class="srch-person" onclick="openProfile('${p.id}')">
                    <img src="${p.photo || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(p.name || 'U')}" class="srch-av" loading="lazy" onerror="this.src='https://ui-avatars.com/api/?name=U'">
                    <span class="srch-meta"><b>${escapeHtml(p.name || 'User')}${p.verified ? ' <i class="fas fa-check-circle" style="color:#3b82f6"></i>' : ''}</b><small>${p.username ? '@' + escapeHtml(p.username) : (p.type === 'channel' ? 'Channel' : 'User')}</small></span>
                    <i class="fas fa-chevron-right opacity-40"></i>
                </button>`).join('') + '</div>';
        }
        if (videos.length) {
            html += '<div class="srch-sec"><div class="srch-h">Related Reels</div><div class="srch-reels">' + videos.map(v => `
                <button class="srch-reel" onclick="openVideoInShorts('${v.id}')">
                    <video src="${v.stream_url}#t=0.3" preload="metadata" muted playsinline></video>
                    <span class="srch-play"><i class="fas fa-play"></i></span>
                    <span class="srch-cap">${escapeHtml((v.caption || '').slice(0, 40))}</span>
                </button>`).join('') + '</div></div>';
        }
        if (posts.length) html += '<div class="srch-h" style="padding:6px 4px">Posts</div>' + posts.map(p => buildPostCardHtml(p)).join('');
        feed.innerHTML = html;
    } catch (e) {
        feed.innerHTML = '<div class="text-center text-red-500 py-10">Search failed. Check your connection.</div>';
    }
}

window.clearHomeSearch = () => {
    document.getElementById('homeSearchInput').value = '';
    document.getElementById('homeSearchClearBtn').classList.add('hidden');
    loadPosts(1, true);
};

function buildVideoResultCardHtml(v) {
    const captionHtml = animateEmojis(formatCaption(v.caption || v.text, v.author_level || 1, v.entities));
    return `
        <div class="bg-white p-4 rounded-xl shadow-sm border mb-4 fade-in">
            <div class="flex items-center gap-3 mb-3 cursor-pointer" onclick="openProfileLink('${v.type}', '${v.author_id}', '${v.author_username || ''}')">
                <img src="${v.author_photo}" class="w-10 h-10 rounded-full object-cover">
                <div>
                    <h3 class="font-bold text-sm text-gray-900">${v.author_name}</h3>
                    <span class="text-[9px] px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 font-bold"><i class="fas fa-video"></i> Short</span>
                </div>
            </div>
            <p class="mb-3 text-sm text-gray-800">${captionHtml}</p>
            <button onclick="openVideoInShorts('${v.id}')" class="w-full bg-purple-600 text-white py-2 rounded-lg text-sm font-bold"><i class="fas fa-play"></i> Watch in Shorts</button>
        </div>`;
}

window.openVideoInShorts = async (videoId) => {
    switchTab('shorts');
    try {
        const res = await fetch('/api/getVideoById', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ videoId }) });
        const video = await res.json();
        if (video && video.id) {
            const feed = document.getElementById('shortsFeed');
            feed.insertAdjacentHTML('afterbegin', renderShortItem(video));
            document.getElementById('shortsEmptyState').classList.add('hidden');
            observeShorts();
            feed.firstElementChild.scrollIntoView();
        }
    } catch (e) { console.error(e); }
};

// ================= Hashtags + trending =================
window.searchHashtag = (tag) => {
    // Close any open sheet (profile, comments...) so the results are visible
    while (openModalsStack.length) {
        const last = openModalsStack[openModalsStack.length - 1];
        if (SHEET_MAP[last]) closeSheet(last, SHEET_MAP[last]); else closeModal(last);
        if (openModalsStack[openModalsStack.length - 1] === last) openModalsStack.pop();
    }
    switchTab('home');
    const input = document.getElementById('homeSearchInput');
    input.value = '#' + tag;
    performHomeSearch('#' + tag);
    try { tg.HapticFeedback.selectionChanged(); } catch (e) {}
};

async function loadTrendingTags() {
    try {
        const res = await fetch('/api/trendingTags');
        const tags = await res.json();
        const box = document.getElementById('trendingTags');
        if (!box || !tags || !tags.length) return;
        box.innerHTML = '<span class="text-[11px] font-bold text-gray-400 flex-shrink-0 self-center">Trending</span>' +
            tags.map(t => `<button onclick="searchHashtag('${t.tag.slice(1)}')" class="trend-chip">${escapeHtml(t.tag)}</button>`).join('');
        box.classList.remove('hidden');
    } catch (e) {}
}
