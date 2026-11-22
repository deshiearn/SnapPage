'use strict';
function escapeHtml(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Converts Telegram's message/caption entities (bold, italic, links, text-links, etc.)
// into HTML, so a channel post shows in the app exactly as it looked in Telegram.
// Link privileges follow the referral level system:
//   Level 1: no clickable links at all
//   Level 2+: plain typed URLs are clickable
//   Level 3+ (or a verified blue-badge account): bold/styled "text link" entities are also clickable
// Bot mentions (@SomethingBot / @something_bot) are always clickable and bold, regardless
// of level — they link straight to the bot's chat (the @ is stripped from the URL only).
const ENTITY_TAG_MAP = { bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', code: 'code', pre: 'pre', spoiler: 'span' };
const BOT_MENTION_REGEX = /@([A-Za-z0-9_]{3,}[Bb]ot)\b/g;

function linkifyBotMentions(escapedText) {
    return escapedText.replace(BOT_MENTION_REGEX, (match, username) =>
        `<a href="https://t.me/${username}" target="_blank" class="text-blue-500 underline font-bold">@${username}</a>`
    );
}

function entitiesToHtml(text, entities, level) {
    if (!entities || !Array.isArray(entities) || entities.length === 0) return null;
    const supported = entities.filter(e => ENTITY_TAG_MAP[e.type] || e.type === 'url' || e.type === 'text_link');
    if (supported.length === 0) return null;

    const points = new Set([0, text.length]);
    supported.forEach(e => { points.add(e.offset); points.add(e.offset + e.length); });
    const sorted = Array.from(points).sort((a, b) => a - b);

    let html = '';
    for (let i = 0; i < sorted.length - 1; i++) {
        const start = sorted[i], end = sorted[i + 1];
        if (start >= end) continue;
        const segment = text.slice(start, end);
        let escaped = escapeHtml(segment);
        const covering = supported.filter(e => e.offset <= start && (e.offset + e.length) >= end);

        let opening = '', closing = '';
        let didWrapLink = false;
        const linkEntity = covering.find(e => e.type === 'url' || e.type === 'text_link');
        if (linkEntity) {
            const allowPlainUrl = linkEntity.type === 'url' && level >= 2;
            const allowTextLink = linkEntity.type === 'text_link' && level >= 3;
            if (allowPlainUrl || allowTextLink) {
                const href = linkEntity.type === 'text_link' ? linkEntity.url : segment;
                opening += `<a href="${href}" target="_blank" class="text-blue-500 underline">`;
                closing = '</a>' + closing;
                didWrapLink = true;
            }
        }
        // Only auto-link bot mentions in segments not already wrapped as a link (avoids nested <a> tags)
        if (!didWrapLink) escaped = linkifyBotMentions(escaped);

        covering.forEach(e => {
            const tag = ENTITY_TAG_MAP[e.type];
            if (tag) { opening += `<${tag}>`; closing = `</${tag}>` + closing; }
        });
        html += opening + escaped + closing;
    }
    return html;
}

// Turn #hashtags (any language) into tappable links that search the feed. Skips text already inside <a>.
function linkifyHashtags(html) {
    let depth = 0;
    return html.split(/(<[^>]*>)/).map(part => {
        if (part.startsWith('<')) {
            if (/^<a[\s>]/i.test(part)) depth++;
            else if (/^<\/a>/i.test(part)) depth = Math.max(0, depth - 1);
            return part;
        }
        if (depth > 0) return part;
        return part.replace(/(^|[\s(])#([\p{L}\p{M}\p{N}_]{2,30})/gu, (m, pre, tag) =>
            `${pre}<a href="#" onclick="event.preventDefault();searchHashtag('${tag}')" class="text-blue-500 font-semibold">#${tag}</a>`);
    }).join('');
}

function formatCaption(text, level, entities) {
    return linkifyHashtags(formatCaptionBase(text, level, entities));
}

function formatCaptionBase(text, level, entities) {
    if (!text) return '';
    const richHtml = entitiesToHtml(text, entities, level);
    if (richHtml !== null) return richHtml;

    // Fallback for plain text with no Telegram entities: auto-detect URLs and bot mentions together
    const escaped = escapeHtml(text);
    const combinedRegex = /(https?:\/\/[^\s]+)|(@[A-Za-z0-9_]{3,}[Bb]ot\b)/g;
    return escaped.replace(combinedRegex, (match, url, mention) => {
        if (url) {
            return level >= 2 ? `<a href="${url}" target="_blank" class="text-blue-500 underline">${url}</a>` : `<span>${url}</span>`;
        }
        const username = mention.slice(1);
        return `<a href="https://t.me/${username}" target="_blank" class="text-blue-500 underline font-bold">@${username}</a>`;
    });
}

// Dynamic Post Previews uploads
document.getElementById('imageUpload').addEventListener('change', function(e) {
    const files = Array.from(e.target.files);
    const maxImgs = maxPhotosForMe();
    if (imagesArray.length + files.length > maxImgs) return tg.showAlert(`Your level allows up to ${maxImgs} photos per post.` + (maxImgs < 8 ? ' Reach Level 3 for 8!' : ''));
    
    files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            // Downscale to max 1280px JPEG: smaller upload = the post goes live much faster
            const img = new Image();
            img.onload = () => {
                const k = Math.min(1, 1280 / Math.max(img.width, img.height));
                const c = document.createElement('canvas');
                c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
                c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
                imagesArray.push(c.toDataURL('image/jpeg', 0.85));
                renderPreviews();
            };
            img.onerror = () => { imagesArray.push(ev.target.result); renderPreviews(); };
            img.src = ev.target.result;
        };
        reader.readAsDataURL(file);
    });
    e.target.value = '';
});

// Feed-style card for the post being written (live preview + optimistic "instant" post)
function draftPost(extra) {
    const u = currentUser || {};
    return Object.assign({
        id: 'draft', author_id: u.tg_id, author_name: escapeHtml(u.name || 'You'), author_photo: u.photo_url || '',
        author_level: u.level || 1, author_verified: !!u.is_verified, type: 'user',
        text: document.getElementById('postText').value, image_urls: imagesArray.slice(),
        likes_count: 0, likes_users: [], reactions: {}, views: 0
    }, extra || {});
}
function renderLivePreview() {
    const wrap = document.getElementById('postLivePreviewWrap');
    if (!wrap) return;
    if (!postReady()) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    document.getElementById('postLivePreview').innerHTML = buildPostCardHtml(draftPost()).replace('fade-in', '');
}

const maxPhotosForMe = () => ((currentUser && currentUser.level) || 1) >= 3 ? 8 : 4;
function renderPreviews() {
    if (typeof syncPostMB === 'function') syncPostMB();
    const c = document.getElementById('imgPreviewContainer');
    const max = maxPhotosForMe();
    c.innerHTML = imagesArray.map((src, idx) => `<div class="cmp-th"><img src="${src}" alt=""><button onclick="removeImg(${idx})" aria-label="Remove"><i class="fas fa-times"></i></button></div>`).join('')
        + (imagesArray.length && imagesArray.length < max ? `<button class="cmp-add" onclick="document.getElementById('imageUpload').click()" aria-label="Add photo"><i class="fas fa-plus"></i></button>` : '');
    const badge = document.getElementById('cmpPhotoBadge'); if (badge) badge.textContent = imagesArray.length + '/' + max;
    updateComposerMeta();
}
function updateComposerMeta() {
    const ta = document.getElementById('postText'); if (!ta) return;
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px';        // grows with the text
    const n = ta.value.length, cnt = document.getElementById('cmpCount');
    cnt.textContent = n + '/1000'; cnt.classList.toggle('warn', n > 900);
    const u = currentUser || {};
    document.getElementById('cmpAvatar').src = u.photo_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(u.name || 'U');
    document.getElementById('cmpName').textContent = u.name || 'You';
    document.getElementById('cmpMeta').innerHTML = '<i class="fas fa-earth-americas"></i> Public · Level ' + (u.level || 1);
    const go = document.getElementById('submitPostBtn'); if (go) { go.disabled = !postReady(); go.textContent = editModePostId ? 'Save' : 'Post'; }
}
window.cmpInsert = (ch) => {
    const ta = document.getElementById('postText'), a = ta.selectionStart || ta.value.length, b = ta.selectionEnd || ta.value.length;
    const pre = ta.value.slice(0, a), needSpace = pre && !/\s$/.test(pre);
    ta.value = pre + (needSpace ? ' ' : '') + ch + ta.value.slice(b);
    ta.focus(); const pos = pre.length + (needSpace ? 1 : 0) + ch.length; ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input'));
};
const CMP_EMOJIS = ['😀','😂','🥰','😍','😎','🤩','🥳','😢','😡','🙏','👍','👏','🔥','❤️','💯','🎉','✨','🌟','🌸','☕','🍕','⚽','🎵','🇧🇩'];
window.cmpToggleEmoji = () => {
    const box = document.getElementById('cmpEmojis');
    if (!box.innerHTML) box.innerHTML = CMP_EMOJIS.map(e => `<button onclick="cmpInsert('${e}')">${e}</button>`).join('');
    box.classList.toggle('hidden');
};
window.removeImg = (idx) => { imagesArray.splice(idx, 1); renderPreviews(); }

// Create / Edit Post Submission
const postBtn = document.getElementById('submitPostBtn');
const postReady = () => !!(document.getElementById('postText').value.trim() || imagesArray.length);
function syncPostMB() {
    renderLivePreview(); if (window.MB) MB.update('postModal', { active: postReady(), text: editModePostId ? 'Save' : 'Post' }); }
window.MB_SCREENS.postModal = () => MB.show('postModal', { text: editModePostId ? 'Save' : 'Post', active: postReady(), onClick: () => submitPost(), inPage: postBtn });
document.getElementById('postText').addEventListener('input', () => {
    syncPostMB(); updateComposerMeta();
    if (!editModePostId) { try { localStorage.setItem('snap_draft', document.getElementById('postText').value); } catch (e) {} }   // autosave unsent text
});

postBtn.addEventListener('click', () => submitPost());

// Instant posting: the composer closes at once and the post shows up in the feed right away
// (dimmed, "Posting…") while the upload runs in the background.
async function submitPost() {
    const text = document.getElementById('postText').value;
    if (!text.trim() && imagesArray.length === 0) return;
    const images = imagesArray.slice();
    const editId = editModePostId;
    const tempId = 'tmp' + Date.now();

    if (!editId) {
        const feed = document.getElementById('feed');
        const card = document.createElement('div');
        card.id = tempId; card.className = 'opacity-60 pointer-events-none';
        card.innerHTML = `<div class="text-[11px] font-bold text-blue-500 mb-1 px-1"><i class="fas fa-spinner fa-spin"></i> Posting…</div>` + buildPostCardHtml(draftPost());
        feed.prepend(card);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Reset + close the composer immediately
    document.getElementById('postText').value = '';
    try { localStorage.removeItem('snap_draft'); } catch (e) {}
    imagesArray = []; editModePostId = null;
    renderPreviews();
    closeModal('postModal');
    try { tg.HapticFeedback.impactOccurred('medium'); } catch (e) {}

    try {
        const url = editId ? '/api/editPost' : '/api/createPost';
        const payload = editId
            ? { initData: tgAuth(), postId: editId, text, imageUrls: images }
            : { initData: tgAuth(), text, imagesBase64: images };
        const res = await fetch(url, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!(data && data.success)) throw new Error((data && data.error) || (editId ? 'Update failed' : 'Creation failed'));
        if (data.warning) tg.showAlert(data.warning);
        try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {}
    } catch (e) {
        console.error('Submission failed:', e);
        const t = document.getElementById(tempId); if (t) t.remove();
        // Give the draft back so nothing is lost
        document.getElementById('postText').value = text; imagesArray = images; editModePostId = editId;
        renderPreviews();
        tg.showAlert(`Failed to publish: ${e.message || e}`);
        openModal('postModal');
        return;
    }
    loadPosts(1, true);
}
