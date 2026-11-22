'use strict';
window.sharePostDirectly = (id) => {
    trackShare('post', id);
    const forwardLink = `https://t.me/SnapPagesBot/app?startapp=post_${id}${refSuffix()}`;
    const text = "Check out this amazing post on SnapPages!";
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(forwardLink)}&text=${encodeURIComponent(text)}`);
}

// Like count dynamic incrementer API handler
window.likePost = async (btn, postId) => {
    btn.disabled = true;
    try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
    try {
        const res = await fetch('/api/likePost', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tgAuth(), postId })
        });
        const data = await res.json();
        
        if (data && data.success) {
            const countEl = btn.querySelector('.like-count');
            if (countEl) countEl.innerText = data.likesCount;

            btn.classList.toggle('text-red-500', data.hasLiked);
            btn.classList.toggle('font-bold', data.hasLiked);
            const emo = btn.querySelector('.react-emoji'); if (emo) emo.classList.add('hidden');
            const icon = btn.querySelector('i');
            syncReactionUI('post', postId, data);
            if (icon) { icon.classList.remove('icon-pop'); void icon.offsetWidth; icon.classList.add('icon-pop'); }
            if (data.hasLiked) {
                icon.className = 'fas fa-heart text-red-500';
            } else {
                icon.className = 'far fa-heart';
            }
        }
    } catch(e) {
        console.error("Liking failed:", e);
    } finally {
        btn.disabled = false;
    }
}

// ================= Three-dot Options Logic sheet (FIXED: Supports own-channel post modifications + Report) =================
window.openPostOptions = async (postId, authorId, postType) => {
    const content = document.getElementById('optionsContent');
    openSheet('optionsModalBg', 'optionsSheet');

    // Validates own-channel post modification privileges
    let isMine = false;
    if (currentUser) {
        if (postType === 'channel') {
            isMine = currentUser.channels && Array.isArray(currentUser.channels) && 
                     currentUser.channels.some(c => String(c.id) === String(authorId));
        } else {
            isMine = String(authorId) === String(currentUser.tg_id);
        }
    }

    const copyBtn = `<button onclick="copyContentLink('post', '${postId}')" class="opt-item opt-blue"><span class="opt-icon"><i class="fas fa-link"></i></span><span>Copy Link<small>Share it anywhere</small></span><i class="fas fa-chevron-right opt-chev"></i></button>`;
    if (isMine) {
        content.innerHTML = copyBtn + `
            <button onclick="triggerEditPost('${postId}')" class="opt-item opt-blue"><span class="opt-icon"><i class="fas fa-pen"></i></span><span>Edit Post<small>Change caption or images</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
            <button onclick="triggerRemovePost('${postId}')" class="opt-item opt-red"><span class="opt-icon"><i class="fas fa-trash-alt"></i></span><span>Delete Post<small>Cannot be undone</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
        `;
    } else {
        content.innerHTML = copyBtn + `
            <button onclick="openReportSheet('${postId}')" class="opt-item opt-orange"><span class="opt-icon"><i class="fas fa-flag"></i></span><span>Report Post<small>Tell us what is wrong</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
        `;
    }
}

window.copyContentLink = (kind, id) => {
    closeSheet('optionsModalBg', 'optionsSheet');
    const link = `https://t.me/SnapPagesBot/app?startapp=${kind}_${id}${refSuffix()}`;
    const done = () => { try { tg.HapticFeedback.notificationOccurred('success'); } catch (e) {} tg.showAlert('Link copied!'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => fallbackCopy(link, done));
    else fallbackCopy(link, done);
};

window.triggerEditPost = async (postId) => {
    closeSheet('optionsModalBg', 'optionsSheet');
    let post = null;
    try {
        const r = await fetch('/api/getPostById', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ postId }) });
        post = await r.json();
    } catch (e) {}
    if (post && post.id) {
        editModePostId = postId;
        document.getElementById('postModalTitle').innerText = "Edit Post";
        document.getElementById('postText').value = post.text;
        
        let imageUrls = post.image_urls;
        if (typeof imageUrls === 'string') {
            if (imageUrls.startsWith('{') && imageUrls.endsWith('}')) {
                imageUrls = imageUrls.slice(1, -1).split(',').map(u => u.trim().replace(/^"|"$/g, ''));
            } else {
                try { imageUrls = JSON.parse(imageUrls); } catch(e) { imageUrls = [imageUrls]; }
            }
        }
        imagesArray = imageUrls || [];
        renderPreviews();
        openModal('postModal');
    }
}

window.triggerRemovePost = async (postId) => {
    closeSheet('optionsModalBg', 'optionsSheet');
    tg.showConfirm("Are you sure you want to delete this post?", async (ok) => {
        if (ok) {
            const res = await fetch('/api/deletePost', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ initData: tgAuth(), postId })
            });
            const data = await res.json();
            if (data && data.success) {
                loadPosts(1, true);
            }
        }
    });
}

// ================= Report Post/Video Logic =================
const REPORT_REASONS = ["Spam", "Nudity or sexual content", "Hate speech or symbols", "Violence", "False information", "Something else"];
window.openReportSheet = (postId, contentType = 'post') => {
    closeSheet('optionsModalBg', 'optionsSheet');
    const list = document.getElementById('reportReasonsList');
    list.innerHTML = REPORT_REASONS.map(r => `<button onclick="submitReport('${postId}', '${r}', '${contentType}')" class="opt-item opt-orange" style="font-weight:600"><span class="opt-icon" style="width:30px;height:30px;font-size:13px"><i class="fas fa-flag"></i></span><span>${r}</span></button>`).join('');
    openSheet('reportModalBg', 'reportSheet');
}
window.submitReport = async (postId, reason, contentType = 'post') => {
    closeSheet('reportModalBg', 'reportSheet');
    try {
        const endpoint = contentType === 'video' ? '/api/reportVideo' : '/api/reportPost';
        const bodyKey = contentType === 'video' ? 'videoId' : 'postId';
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ initData: tgAuth(), [bodyKey]: postId, reason })
        });
        const data = await res.json();
        if (data && data.success) tg.showAlert("Thanks — this has been reported to our team.");
        else tg.showAlert("Could not send the report: " + ((data && data.error && (data.error.message || data.error)) || 'please try again'));
    } catch(e) { console.error("Report failed:", e); tg.showAlert("Could not send the report. Please check your connection and try again."); }
}

// ================= Comments Logic =================
let currentCommentContentType = 'post';
let replyTarget = null;      // { id (top-level comment id), name }
let commentIndex = {};       // id -> comment, so Reply can show the author's name

window.openComments = async (postId, contentType = 'post') => {
    currentPostIdForComment = postId;
    currentCommentContentType = contentType;
    const me = currentUser || {};
    document.getElementById('cmMeAv').src = me.photo_url || 'https://ui-avatars.com/api/?name=' + encodeURIComponent(me.name || 'U');
    document.getElementById('commentInput').value = '';
    updateCommentComposer();
    openSheet('commentModalBg', 'commentSheet');
    fetchComments();
}
window.closeComment = () => { try { document.getElementById('commentInput').blur(); } catch (e) {} closeSheet('commentModalBg', 'commentSheet'); };

const avColor = (name) => { let h = 0; for (const ch of String(name || 'U')) h = (h * 31 + ch.charCodeAt(0)) % 360; return `hsl(${h},55%,52%)`; };
function cmAvatar(c) {
    const initial = escapeHtml(String(c.author_name || 'U').trim().charAt(0).toUpperCase() || 'U');
    if (c.author_photo) return `<img class="cm-av" src="${c.author_photo}" loading="lazy" alt="" onerror="this.outerHTML='<span class=\\'cm-av\\' style=\\'background:${avColor(c.author_name)}\\'>${initial}</span>'">`;
    return `<span class="cm-av" style="background:${avColor(c.author_name)}">${initial}</span>`;
}

function commentHtml(c, isReply, pending) {
    const isMine = currentUser && String(c.author_id) === String(currentUser.tg_id);
    const hasLiked = c.likes_users && currentUser && c.likes_users.includes(currentUser.tg_id);
    const safe = escapeHtml(c.text || '').replace(/(^|\s)@([A-Za-z0-9_]{4,32})/g, '$1<span style="color:var(--app-link,#007aff);font-weight:600">@$2</span>');
    const likeCount = c.likes_count || 0;
    return `<div data-comment-id="${c.id}" class="cm-item${isReply ? ' cm-reply' : ''}${pending ? ' pending' : ''}">
        ${cmAvatar(c)}
        <div class="cm-main">
            <div class="cm-name">${escapeHtml(c.author_name || 'User')}${c.author_verified ? ' <i class="fas fa-check-circle"></i>' : ''}</div>
            <div class="cm-text">${safe}</div>
            <div class="cm-meta"><span>${typeof timeAgo === 'function' ? timeAgo(c.created_at) : ''}</span>
                <button onclick="startReply('${c.id}')">Reply</button>
                ${isMine ? `<button onclick="removeCommentDirect('${c.id}')" style="color:#ff3b30">Delete</button>` : ''}
            </div>
        </div>
        <button onclick="likeComment(this, '${c.id}')" class="cm-like ${hasLiked ? 'on' : ''}" aria-label="Like"><i class="${hasLiked ? 'fas' : 'far'} fa-heart"></i><small class="comment-like-count">${likeCount || ''}</small></button>
    </div>`;
}

function renderCommentThread(top, replies, expandId) {
    return top.map(c => {
        const rs = replies[c.id] || [];
        const open = rs.some(r => String(r.id) === String(expandId));
        return commentHtml(c, false) + (rs.length
            ? `<button class="cm-more" onclick="toggleReplies(this)" data-n="${rs.length}">${open ? 'Hide replies' : (rs.length === 1 ? 'View 1 reply' : 'View ' + rs.length + ' replies')}</button><div class="cm-replies${open ? '' : ' hidden'}">${rs.map(r => commentHtml(r, true)).join('')}</div>`
            : '<div class="cm-replies hidden"></div>');
    }).join('');
}
window.toggleReplies = (btn) => {
    const box = btn.nextElementSibling, open = box.classList.toggle('hidden') === false, n = +btn.dataset.n;
    btn.textContent = open ? 'Hide replies' : (n === 1 ? 'View 1 reply' : `View ${n} replies`);
};

async function fetchComments() {
    const list = document.getElementById('commentList');
    list.innerHTML = '<div class="cm-empty"><i class="fas fa-spinner fa-spin"></i></div>';
    cancelReply();
    try {
        const res = await fetch('/api/getComments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ postId: currentPostIdForComment, contentType: currentCommentContentType }) });
        const comments = await res.json();
        document.getElementById('cmCount').textContent = comments && comments.length ? '· ' + comments.length : '';
        if (!comments || comments.length === 0) {
            list.innerHTML = '<div class="cm-empty"><i class="far fa-comment-dots"></i><b>No comments yet</b><br><small>Be the first to comment</small></div>';
            return;
        }
        commentIndex = {};
        comments.forEach(c => { commentIndex[c.id] = c; });
        const replies = {}, top = [];
        comments.forEach(c => {
            if (c.parent_id && commentIndex[c.parent_id]) (replies[c.parent_id] = replies[c.parent_id] || []).push(c);
            else top.push(c);
        });
        list.innerHTML = renderCommentThread(top, replies, window.focusCommentId);
        // Coming from a notification: scroll to + flash the comment
        if (window.focusCommentId) {
            const el = list.querySelector(`[data-comment-id="${window.focusCommentId}"]`);
            window.focusCommentId = null;
            if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash-hl'); setTimeout(() => el.classList.remove('flash-hl'), 2200); }
        }
    } catch(e) {
        list.innerHTML = '<div class="cm-empty">Could not load comments.</div>';
    }
}

// Replying to a reply attaches to the same top-level comment (one level of threading, like Instagram)
window.startReply = (commentId) => {
    const c = commentIndex[commentId];
    if (!c) return;
    replyTarget = { id: c.parent_id && commentIndex[c.parent_id] ? c.parent_id : c.id, name: c.author_name || 'User' };
    document.getElementById('replyBarName').innerText = replyTarget.name;
    document.getElementById('replyBar').classList.remove('hidden');
    const inp = document.getElementById('commentInput');
    if (!inp.value) inp.value = '';
    inp.focus();
};
window.cancelReply = () => {
    replyTarget = null;
    const bar = document.getElementById('replyBar');
    if (bar) bar.classList.add('hidden');
};

// ---- Smart emoji suggestions + one-tap quick replies ----
const CM_DEFAULT_EMOJI = ['❤️', '🔥', '😂', '👏', '😮', '😍', '🙌', '💯', '🥰', '😢'];
const CM_PHRASES = ['Nice! 🔥', 'Love this ❤️', 'Congrats 🎉', 'Well said 👏'];
const CM_KEYS = [
    [/love|lovely|crush|ভালোবাস|ভালবাস|পছন্দ|প্রিয়/i, ['❤️', '😍', '🥰', '💕']],
    [/nice|good|great|awesome|super|amazing|cool|best|perfect|সুন্দর|দারুণ|দারুন|অসাধারণ|সেরা|ভালো|ভাল|চমৎকার/i, ['🔥', '👏', '💯', '🤩']],
    [/haha|hehe|lol|lmao|funny|joke|হাহা|হা হা|মজা|হাসি/i, ['😂', '🤣', '😆']],
    [/sad|sorry|miss|cry|pain|দুঃখ|কষ্ট|কান্না|মিস/i, ['😢', '🥺', '💔']],
    [/thank|thanks|thx|ধন্যবাদ|শুকরিয়া|থ্যাংক/i, ['🙏', '❤️', '😊']],
    [/congrat|birthday|happy|win|won|অভিনন্দন|শুভ|জন্মদিন|জিত/i, ['🎉', '🥳', '👏', '🎂']],
    [/wow|omg|shock|unbelievable|আশ্চর্য|ওয়াও/i, ['😮', '🤯', '😱']],
    [/food|pizza|burger|tasty|delicious|খাবার|মজার|বিরিয়ানি/i, ['😋', '🍕', '🤤']],
    [/eid|ramadan|mubarak|ঈদ|রমজান|মোবারক/i, ['🌙', '🕌', '🤲', '✨']],
    [/angry|hate|worst|bad|রাগ|বাজে|খারাপ/i, ['😡', '👎', '😤']]
];
function updateCommentComposer() {
    const inp = document.getElementById('commentInput'), v = inp.value;
    document.getElementById('sendCommentBtn').disabled = !v.trim();
    let list = [];
    CM_KEYS.forEach(([re, em]) => { if (v && re.test(v)) list.push(...em); });
    list = [...new Set([...list, ...CM_DEFAULT_EMOJI])].slice(0, 12);
    document.getElementById('cmSuggest').innerHTML =
        (v ? '' : CM_PHRASES.map(p => `<button class="cm-phrase" onclick="quickComment(this.textContent)">${p}</button>`).join('')) +
        list.map(e => `<button onclick="insertCommentEmoji('${e}')" aria-label="${e}">${e}</button>`).join('');
}
window.insertCommentEmoji = (e) => {
    const inp = document.getElementById('commentInput');
    const a = inp.selectionStart == null ? inp.value.length : inp.selectionStart, b = inp.selectionEnd == null ? a : inp.selectionEnd;
    inp.value = inp.value.slice(0, a) + e + inp.value.slice(b);
    const pos = a + e.length; inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (x) {}
    updateCommentComposer();
    try { tg.HapticFeedback.selectionChanged(); } catch (x) {}
};
window.quickComment = (text) => { document.getElementById('commentInput').value = text; sendComment(); };
document.getElementById('commentInput').addEventListener('input', updateCommentComposer);
document.getElementById('commentInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendComment(); } });

// Lift the whole sheet above the on-screen keyboard (iOS keeps the layout viewport; Android resizes it)
if (window.visualViewport) {
    const lift = () => {
        const sheet = document.getElementById('commentSheet');
        if (!sheet || !sheet.classList.contains('open')) return;
        const gap = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
        sheet.style.transform = gap > 80 ? `translateY(-${gap}px)` : '';
        sheet.style.height = gap > 80 ? `${Math.min(window.innerHeight * 0.8, window.visualViewport.height - 12)}px` : '';
    };
    window.visualViewport.addEventListener('resize', lift);
    window.visualViewport.addEventListener('scroll', lift);
}

// Instant comments: it appears in the thread immediately and is confirmed in the background
async function sendComment() {
    const inp = document.getElementById('commentInput');
    const text = inp.value.trim();
    if (!text) return;
    const me = currentUser || {}, tempId = 'tmp' + Date.now();
    const parent = replyTarget ? replyTarget.id : undefined;
    const temp = { id: tempId, author_id: me.tg_id, author_name: me.name || 'You', author_photo: me.photo_url || '', author_verified: !!me.is_verified, text, created_at: new Date().toISOString(), likes_count: 0, likes_users: [], parent_id: parent };
    const list = document.getElementById('commentList');
    if (!list.querySelector('.cm-item')) list.innerHTML = '';
    let el;
    if (parent) {
        const pEl = list.querySelector(`[data-comment-id="${parent}"]`);
        if (pEl) {
            let box = pEl.nextElementSibling; if (box && box.classList.contains('cm-more')) box = box.nextElementSibling;
            if (box && box.classList.contains('cm-replies')) {
                box.classList.remove('hidden'); box.insertAdjacentHTML('beforeend', commentHtml(temp, true, true)); el = box.lastElementChild;
                const m = box.previousElementSibling; if (m && m.classList.contains('cm-more')) m.textContent = 'Hide replies';
            }
        }
    }
    if (!el) { list.insertAdjacentHTML('beforeend', commentHtml(temp, !!parent, true)); el = list.lastElementChild; }
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    inp.value = ''; cancelReply(); updateCommentComposer();
    try { tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
    try {
        const res = await fetch('/api/addComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), postId: currentPostIdForComment, text, contentType: currentCommentContentType, parentId: parent }) });
        const data = await res.json();
        if (!(data && data.success)) throw new Error((data && data.error) || 'Server error');
        el.classList.remove('pending');
        if (data.id) { el.dataset.commentId = data.id; temp.id = data.id; commentIndex[data.id] = temp; el.querySelectorAll('[onclick*="' + tempId + '"]').forEach(b => b.setAttribute('onclick', b.getAttribute('onclick').split(tempId).join(data.id))); }
        const c = document.getElementById('cmCount'); c.textContent = '· ' + (parseInt((c.textContent || '').replace(/\D/g, '')) + 1 || 1);
    } catch (e) {
        el.remove(); inp.value = text; updateCommentComposer();       // nothing lost: the text goes back into the box
        tg.showAlert(`Failed to comment: ${e.message || e}`);
    }
}
document.getElementById('sendCommentBtn').onclick = sendComment;

window.likeComment = async (btn, commentId) => {
    if (String(commentId).startsWith('tmp')) return;
    const was = btn.classList.contains('on');
    btn.classList.toggle('on', !was); btn.classList.add('pop'); setTimeout(() => btn.classList.remove('pop'), 300);   // optimistic
    btn.querySelector('i').className = (!was ? 'fas' : 'far') + ' fa-heart';
    try {
        const res = await fetch('/api/likeComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), commentId }) });
        const data = await res.json();
        if (data && data.success) {
            btn.querySelector('.comment-like-count').innerText = data.likesCount || '';
            btn.classList.toggle('on', !!data.hasLiked);
            btn.querySelector('i').className = (data.hasLiked ? 'fas' : 'far') + ' fa-heart';
        } else throw new Error('x');
    } catch(e) {
        btn.classList.toggle('on', was); btn.querySelector('i').className = (was ? 'fas' : 'far') + ' fa-heart';
    }
}

window.removeCommentDirect = async (id) => {
    const el = document.querySelector(`[data-comment-id="${id}"]`);
    if (el) { el.style.transition = 'opacity .2s, height .2s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 200); }
    await fetch('/api/deleteComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), commentId: id }) });
}
