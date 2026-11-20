'use strict';
// ================= Reactions: long-press the Like button =================
const REACTIONS = ['❤️', '😂', '😮', '😢', '🔥', '👍'];
let pressTimer = null, longPressed = false, pickerTarget = null;

function hideReactionPicker() {
    const p = document.getElementById('reactionPicker');
    p.classList.add('hidden');
    pickerTarget = null;
}

function showReactionPicker(btn) {
    pickerTarget = btn;
    const p = document.getElementById('reactionPicker');
    p.innerHTML = REACTIONS.map((e, i) => `<button class="react-opt" style="animation-delay:${i * 40}ms" onclick="pickReaction('${e}')">${e}</button>`).join('');
    p.classList.remove('hidden');
    const r = btn.getBoundingClientRect();
    const w = p.offsetWidth || 260;
    p.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    p.style.top = Math.max(8, r.top - 58) + 'px';
    try { tg.HapticFeedback.impactOccurred('medium'); } catch (e) {}
}

window.pickReaction = async (emoji) => {
    const btn = pickerTarget;
    hideReactionPicker();
    if (!btn) return;
    const kind = btn.dataset.react, id = btn.dataset.id;
    const hearted = (btn.querySelector('i') || {}).className && btn.querySelector('i').className.includes('fas fa-heart') && !btn.querySelector('i').classList.contains('hidden');
    if (emoji === '❤️') {
        // classic like: only needs a tap if the heart isn't already on
        if (!hearted) { kind === 'video' ? likeVideo(btn, id) : likePost(btn, id); }
        return;
    }
    try {
        const res = await fetch('/api/react', {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tg.initData, contentType: kind, id, emoji })
        });
        const data = await res.json();
        if (!data || !data.success) { tg.showAlert((data && data.error) || 'Could not react'); return; }
        const countEl = btn.querySelector('.like-count'); if (countEl) countEl.innerText = data.likesCount;
        const emo = btn.querySelector('.react-emoji'), icon = btn.querySelector('i');
        if (data.myReaction) {
            emo.textContent = data.myReaction; emo.classList.remove('hidden'); icon.classList.add('hidden');
            emo.classList.remove('icon-pop'); void emo.offsetWidth; emo.classList.add('icon-pop');
            btn.classList.add('text-red-500', 'font-bold');
        } else {
            emo.classList.add('hidden'); icon.classList.remove('hidden');
            icon.className = (kind === 'video' ? 'far fa-heart text-2xl' : 'far fa-heart');
            btn.classList.remove('text-red-500', 'font-bold');
        }
        try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
    } catch (e) { tg.showAlert('Could not react. Check your connection.'); }
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
