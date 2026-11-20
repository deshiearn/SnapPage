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

function formatCaption(text, level, entities) {
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
    if (imagesArray.length + files.length > 4) return tg.showAlert("Maximum 4 images allowed!");
    
    files.forEach(file => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            imagesArray.push(ev.target.result);
            renderPreviews();
        };
        reader.readAsDataURL(file);
    });
});

function renderPreviews() {
    const c = document.getElementById('imgPreviewContainer');
    c.innerHTML = '';
    imagesArray.forEach((src, idx) => {
        c.innerHTML += `<div class="relative min-w-[80px] h-20 rounded-lg overflow-hidden border">
            <img src="${src}" class="w-full h-full object-cover">
            <button onclick="removeImg(${idx})" class="absolute top-1 right-1 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs"><i class="fas fa-times"></i></button>
        </div>`;
    });
}
window.removeImg = (idx) => { imagesArray.splice(idx, 1); renderPreviews(); }

// Create / Edit Post Submission
document.getElementById('submitPostBtn').addEventListener('click', async () => {
    const text = document.getElementById('postText').value;
    if(!text && imagesArray.length === 0) return;
    const btn = document.getElementById('submitPostBtn');
    btn.innerText = "Processing..."; btn.disabled = true;

    try {
        if (editModePostId) {
            const res = await fetch('/api/editPost', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    initData: tg.initData,
                    postId: editModePostId,
                    text: text,
                    imageUrls: imagesArray
                })
            });
            const data = await res.json();
            if (data && data.success) {
                tg.showAlert(data.warning || "Post edited successfully!");
            } else {
                throw new Error(data.error || "Update failed");
            }
        } else {
            // Route insert through secure Service Role backend API first to bypass DB RLS Blocks
            const apiRes = await fetch('/api/createPost', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    initData: tg.initData,
                    text: text,
                    imagesBase64: imagesArray
                })
            });
            
            const apiData = await apiRes.json();
            if (apiData && apiData.success) {
                tg.showAlert(apiData.warning || "Post published successfully!");
            } else {
                throw new Error(apiData.error || "Creation failed");
            }
        }
    } catch(e) {
        console.error("Submission failed:", e);
        tg.showAlert(`Failed to publish: ${e.message || e}`);
    }
    
    closeModal('postModal');
    document.getElementById('postText').value = '';
    imagesArray = []; 
    renderPreviews();
    btn.innerText = "Post"; btn.disabled = false;
    editModePostId = null;
    loadPosts(1, true);
});
