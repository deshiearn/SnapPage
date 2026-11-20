'use strict';
// ================= Referral System Levels Setup =================
window.openReferSheet = async () => {
    openSheet('referModalBg', 'referSheet');
    
    const link = `https://t.me/SnapPagesBot?start=ref_${currentUser.tg_id}`;
    document.getElementById('referInputLink').value = link;

    const list = document.getElementById('referHistoryList');
    list.innerHTML = '<p class="text-xs text-gray-400 text-center py-4">Loading stats...</p>';

    try {
        const res = await fetch('/api/getReferStats', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tg.initData })
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

        list.innerHTML = '';
        const renderRow = (user, level) => {
            const color = level === 1 ? 'blue' : (level === 2 ? 'purple' : 'pink');
            const tierLabel = level === 1 ? 'Direct' : (level === 2 ? '2nd Tier' : '3rd Tier');
            const avatar = user.photo_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || 'U')}`;
            const handle = user.username ? `@${user.username}` : 'No username';
            return `
            <div class="flex justify-between items-center bg-gray-50 p-2.5 rounded-xl border text-xs">
                <div class="flex items-center gap-2.5">
                    <img src="${avatar}" class="w-8 h-8 rounded-full object-cover">
                    <div>
                        <p class="font-bold text-gray-800">${escapeHtml(user.name || 'User')}</p>
                        <p class="text-[10px] text-gray-400">${escapeHtml(handle)}</p>
                    </div>
                </div>
                <span class="bg-${color}-100 text-${color}-600 text-[10px] px-2 py-0.5 rounded-full font-bold">${tierLabel}</span>
            </div>`;
        };

        level1Users.forEach(u => list.innerHTML += renderRow(u, 1));
        level2Users.forEach(u => list.innerHTML += renderRow(u, 2));
        level3Users.forEach(u => list.innerHTML += renderRow(u, 3));

        if(list.innerHTML === '') {
            list.innerHTML = '<p class="text-xs text-gray-400 text-center py-4">Zero invites yet.</p>';
        }

    } catch (err) {
        console.error(err);
    }
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
                initData: tg.initData, 
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
    const res = await fetch('/api/removeChannel', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tg.initData, channelId: id }) });
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
        const res = await fetch('/api/searchPosts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ query }) });
        const results = await res.json();
        if (!results || results.length === 0) {
            feed.innerHTML = '<div class="text-center text-gray-400 py-10">No matching posts or videos found.</div>';
            return;
        }
        feed.innerHTML = results.map(r => r.content_type === 'video' ? buildVideoResultCardHtml(r) : buildPostCardHtml(r)).join('');
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
