'use strict';
// ================= Reactions: long-press the Like button =================
const REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👍', '🎉', '🥰', '💎', '🤯'];
const REACTION_LEVEL = { '🎉': 2, '🥰': 2, '💎': 3, '🤯': 3 };   // premium reactions unlock by levelling up
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
    p.innerHTML = REACTIONS.map((e, i) => {
        const need = REACTION_LEVEL[e] || 1;
        return need > lv
            ? `<button class="react-opt locked" style="animation-delay:${i * 40}ms" onclick="tg.showAlert('Unlocks at Level ${need} — invite friends to level up!')">${e}<i class="fas fa-lock"></i></button>`
            : `<button class="react-opt" style="animation-delay:${i * 40}ms" onclick="pickReaction('${e}')">${e}</button>`;
    }).join('');
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

function buildReactionRowHtml(kind, id, hearts, reactions, hasHearted) {
    const mine = currentUser && reactions ? reactions[currentUser.tg_id] : '';
    const chips = reactionTotals(hearts, reactions);
    if (kind === 'video') {
        // compact stack for the Shorts side column
        return chips.slice(0, 3).map(([e]) => e).join('');
    }
    return chips.map(([e, n]) => {
        const isMine = e === '❤️' ? hasHearted : e === mine;
        return `<button class="react-chip ${isMine ? 'mine' : ''}" onclick="chipReact('${kind}','${id}','${e}')"><span>${e}</span><b>${n}</b></button>`;
    }).join('');
}

// Called after every like / react response so all copies of the card (feed, profile, search) stay in sync
function syncReactionUI(kind, id, data) {
    if (!data) return;
    document.querySelectorAll(`[data-react-row="${kind}:${id}"]`).forEach(row => {
        row.innerHTML = buildReactionRowHtml(kind, id, data.hearts || 0, data.reactions || {}, !!data.hasLiked);
    });
    document.querySelectorAll(`[data-react="${kind}"][data-id="${id}"]`).forEach(btn => {
        const countEl = btn.querySelector('.like-count'); if (countEl) countEl.innerText = data.likesCount;
        const emo = btn.querySelector('.react-emoji'), icon = btn.querySelector('i');
        const mine = currentUser && data.reactions ? data.reactions[currentUser.tg_id] : '';
        const big = kind === 'video' ? ' text-2xl' : '';
        if (mine) {
            emo.textContent = mine; emo.classList.remove('hidden'); icon.classList.add('hidden');
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
