'use strict';
// ================= Reactions: long-press the Like button =================
const REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👍', '🎉', '🥰', '💎', '🤯'];
const REACTION_LEVEL = { '🎉': 2, '🥰': 2, '💎': 3, '🤯': 3 };   // premium reactions unlock by levelling up
// Premium custom-emoji reactions (pack loaded from the server); key "ce:<id>"
let PREMIUM = [];
const PREMIUM_MAP = {};
const rg = (e) => (e && e.startsWith('ce:') && PREMIUM_MAP[e]) ? `<img class="ce" src="${PREMIUM_MAP[e].img}" alt="${PREMIUM_MAP[e].emoji}">` : (e && e.startsWith('ce:') ? '⭐' : (e || ''));
const rgText = (e) => (e && e.startsWith('ce:')) ? ((PREMIUM_MAP[e] && PREMIUM_MAP[e].emoji) || '⭐') : e;
const canPremiumReact = () => { const u = (window.tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || {}; return !!u.is_premium || ((currentUser && currentUser.level) || 1) >= 3; };
async function loadPremiumEmoji() {
    try { PREMIUM = await (await fetch('/api/premiumEmoji')).json(); if (!Array.isArray(PREMIUM)) PREMIUM = []; PREMIUM.forEach(x => PREMIUM_MAP[x.key] = x); } catch (e) { PREMIUM = []; }
}
loadPremiumEmoji();
let pressTimer = null, longPressed = false, pickerTarget = null;

function hideReactionPicker() {
    const p = document.getElementById('reactionPicker');
    p.classList.add('hidden');
    pickerTarget = null;
}

function showReactionPicker(btn) {
    pickerTarget = btn;
    const p = document.getElementById('reactionPicker');
    const lv = (currentUser && currentUser.level) || 1;
    const mine = btn.dataset.react === 'video' ? (btn.closest('.rl-item') && currentUser && String(btn.closest('.rl-item').dataset.author) === String(currentUser.tg_id)) : !btn.closest('[data-view-post]');
    const starOpt = mine || typeof sxStar !== 'function' ? '' : `<button class="react-opt sx-react" onclick="pickStarReaction()" aria-label="Send Stars">${sxStar()}<small>Stars</small></button><i class="react-sep"></i>`;
    p.innerHTML = starOpt + REACTIONS.map((e, i) => {
        const need = REACTION_LEVEL[e] || 1;
        return need > lv
            ? `<button class="react-opt locked" style="animation-delay:${i * 40}ms" onclick="tg.showAlert('Unlocks at Level ${need} — invite friends to level up!')">${e}<i class="fas fa-lock"></i></button>`
            : `<button class="react-opt" style="animation-delay:${i * 40}ms" onclick="pickReaction('${e}')">${e}</button>`;
    }).join('') + (PREMIUM.length ? '<i class="react-sep"></i>' + PREMIUM.map((x, i) => canPremiumReact()
        ? `<button class="react-opt ce-opt" style="animation-delay:${(i + 10) * 40}ms" onclick="pickReaction('${x.key}')"><img class="ce" src="${x.img}" alt="${x.emoji}"></button>`
        : `<button class="react-opt ce-opt locked" style="animation-delay:${(i + 10) * 40}ms" onclick="tg.showAlert('Premium reactions are for Telegram Premium users or Level 3.')"><img class="ce" src="${x.img}" alt=""><i class="fas fa-lock"></i></button>`).join('') : '');
    p.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    const w = p.offsetWidth || 260;
    p.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    p.style.top = Math.max(8, r.top - 58) + 'px';
    try { tg.HapticFeedback.impactOccurred('medium'); } catch (e) {}
}

// ---- Reaction summary row (like Telegram: ❤️ 3  😂 2  🔥 1 — your own reaction is highlighted) ----
function reactionTotals(hearts, reactions) {
    const counts = {};
    if (hearts > 0) counts['❤️'] = hearts;
    Object.values(reactions || {}).forEach(e => { counts[e] = (counts[e] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function buildReactionRowHtml(kind, id, hearts, reactions, hasHearted, tips) {
    const mine = currentUser && reactions ? reactions[currentUser.tg_id] : '';
    const chips = reactionTotals(hearts, reactions);
    tips = Number(tips) || 0;
    if (kind === 'video') {
        // compact stack for the Shorts side column (Stars always first)
        return (tips > 0 ? '⭐' : '') + chips.slice(0, tips > 0 ? 2 : 3).map(([e]) => rgText(e)).join('');
    }
    const star = tips > 0 ? `<button class="react-chip sx-tipchip" onclick="sxChipTip(this,'${kind}','${id}')">${sxStar('sx-inl')}<b>${sxNum(tips)}</b></button>` : '';
    return star + chips.map(([e, n]) => {
        const isMine = e === '❤️' ? hasHearted : e === mine;
        return `<button class="react-chip ${isMine ? 'mine' : ''}" onclick="chipReact('${kind}','${id}','${e}')"><span>${rg(e)}</span><b>${n}</b></button>`;
    }).join('');
}

// Called after every like / react response so all copies of the card (feed, profile, search) stay in sync
function syncReactionUI(kind, id, data) {
    if (!data) return;
    document.querySelectorAll(`[data-react-row="${kind}:${id}"]`).forEach(row => {
        row.innerHTML = buildReactionRowHtml(kind, id, data.hearts || 0, data.reactions || {}, !!data.hasLiked, row.dataset.tips);
    });
    document.querySelectorAll(`[data-react="${kind}"][data-id="${id}"]`).forEach(btn => {
        const countEl = btn.querySelector('.like-count'); if (countEl) countEl.innerText = data.likesCount;
        const emo = btn.querySelector('.react-emoji'), icon = btn.querySelector('i');
        const mine = currentUser && data.reactions ? data.reactions[currentUser.tg_id] : '';
        const big = kind === 'video' ? ' text-2xl' : '';
        if (mine) {
            emo.innerHTML = rg(mine); emo.classList.remove('hidden'); icon.classList.add('hidden');
        } else {
            emo.classList.add('hidden'); icon.classList.remove('hidden');
            icon.className = (data.hasLiked ? 'fas fa-heart text-red-500' : 'far fa-heart') + big;
        }
        if (kind === 'post') {
            btn.classList.toggle('text-red-500', !!(mine || data.hasLiked));
            btn.classList.toggle('font-bold', !!(mine || data.hasLiked));
        }
    });
}

async function sendReaction(kind, id, emoji) {
    try {
        const res = await fetch('/api/react', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth(), contentType: kind, id, emoji })
        });
        const data = await res.json();
        if (!data || !data.success) { tg.showAlert((data && data.error) || 'Could not react'); return; }
        syncReactionUI(kind, id, data);
        try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
    } catch (e) { tg.showAlert('Could not react. Check your connection.'); }
}

// Tapping a chip toggles that reaction for you
window.chipReact = (kind, id, emoji) => {
    if (emoji === '❤️') {
        const btn = document.querySelector(`[data-react="${kind}"][data-id="${id}"]`);
        if (btn) (kind === 'video' ? likeVideo(btn, id) : likePost(btn, id));
        return;
    }
    sendReaction(kind, id, emoji);
};

window.pickStarReaction = () => {
    const btn = pickerTarget; hideReactionPicker();
    if (btn) sxOpenTip(btn.dataset.react, btn.dataset.id, sxAuthorName(btn));
};

window.pickReaction = async (emoji) => {
    const btn = pickerTarget;
    hideReactionPicker();
    if (!btn) return;
    const kind = btn.dataset.react, id = btn.dataset.id;
    if (emoji === '❤️') {
        const icon = btn.querySelector('i');
        const hearted = icon && icon.className.includes('fas fa-heart') && !icon.classList.contains('hidden');
        if (!hearted) { kind === 'video' ? likeVideo(btn, id) : likePost(btn, id); }
        return;
    }
    sendReaction(kind, id, emoji);
};

document.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('[data-react]');
    if (!b) { if (!e.target.closest('#reactionPicker')) hideReactionPicker(); return; }
    longPressed = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { longPressed = true; showReactionPicker(b); }, 450);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => document.addEventListener(ev, () => clearTimeout(pressTimer)));
document.addEventListener('scroll', () => { clearTimeout(pressTimer); }, true);
// After a long-press, swallow the click that follows so it doesn't also toggle the heart
document.addEventListener('click', (e) => {
    if (longPressed && e.target.closest('[data-react]')) { e.stopPropagation(); e.preventDefault(); }
    longPressed = false;
}, true);
document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-react]')) e.preventDefault(); });
