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
window.openComments = async (postId, contentType = 'post') => {
    currentPostIdForComment = postId;
    currentCommentContentType = contentType;
    openSheet('commentModalBg', 'commentSheet');
    fetchComments();
}
window.closeComment = () => closeSheet('commentModalBg', 'commentSheet');

let replyTarget = null;      // { id (top-level comment id), name }
let commentIndex = {};       // id -> comment, so Reply can show the author's name

function commentHtml(c, isReply) {
    const isMine = currentUser && String(c.author_id) === String(currentUser.tg_id);
    const hasLiked = c.likes_users && currentUser && c.likes_users.includes(currentUser.tg_id);
    const safe = escapeHtml(c.text || '').replace(/(^|\s)@([A-Za-z0-9_]{4,32})/g, '$1<span class="text-blue-500 font-semibold">@$2</span>');
    const likeCount = c.likes_count || 0;
    return `<div data-comment-id="${c.id}" class="${isReply ? 'ml-6 border-l-2 border-blue-200 pl-3 ' : ''}bg-gray-50 p-3 rounded-lg text-sm relative">
        <span class="font-bold text-gray-900">${escapeHtml(c.author_name || 'User')}</span>
        <p class="mt-1 text-gray-800 whitespace-pre-wrap">${safe}</p>
        <div class="mt-2 flex gap-4 text-xs text-gray-500">
            <button onclick="likeComment(this, '${c.id}')" class="${hasLiked ? 'text-red-500 font-bold' : ''} hover:text-red-500 flex items-center gap-1"><i class="${hasLiked ? 'fas' : 'far'} fa-heart"></i> <span class="comment-like-count">${likeCount}</span></button>
            <button onclick="startReply('${c.id}')" class="hover:text-blue-500 flex items-center gap-1"><i class="fas fa-reply"></i> Reply</button>
            ${isMine ? `<button onclick="removeCommentDirect('${c.id}')" class="text-red-400 hover:text-red-600 flex items-center gap-1"><i class="fas fa-trash-alt"></i> Delete</button>` : ''}
        </div>
    </div>`;
}

async function fetchComments() {
    const list = document.getElementById('commentList');
    list.innerHTML = '<p class="text-center text-gray-400 text-sm">Loading comments...</p>';
    cancelReply();

    try {
        const res = await fetch('/api/getComments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ postId: currentPostIdForComment, contentType: currentCommentContentType }) });
        const comments = await res.json();

        if (!comments || comments.length === 0) {
            list.innerHTML = '<p class="text-center text-gray-400 text-sm py-6">No Comments</p>';
            return;
        }

        commentIndex = {};
        comments.forEach(c => { commentIndex[c.id] = c; });
        const replies = {};
        const top = [];
        comments.forEach(c => {
            if (c.parent_id && commentIndex[c.parent_id]) (replies[c.parent_id] = replies[c.parent_id] || []).push(c);
            else top.push(c);
        });
        list.innerHTML = top.map(c => commentHtml(c, false) + (replies[c.id] || []).map(r => commentHtml(r, true)).join('')).join('');
        // Coming from a notification: scroll to + flash the comment
        if (window.focusCommentId) {
            const el = list.querySelector(`[data-comment-id="${window.focusCommentId}"]`);
            window.focusCommentId = null;
            if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash-hl'); setTimeout(() => el.classList.remove('flash-hl'), 2200); }
        }
    } catch(e) {
        list.innerHTML = '<p class="text-center text-red-400 text-sm">Error loading comments.</p>';
    }
}

// Replying to a reply attaches to the same top-level comment (one level of threading, like Instagram)
window.startReply = (commentId) => {
    const c = commentIndex[commentId];
    if (!c) return;
    replyTarget = { id: c.parent_id && commentIndex[c.parent_id] ? c.parent_id : c.id, name: c.author_name || 'User' };
    document.getElementById('replyBarName').innerText = replyTarget.name;
    document.getElementById('replyBar').classList.remove('hidden');
    document.getElementById('commentInput').focus();
};
window.cancelReply = () => {
    replyTarget = null;
    const bar = document.getElementById('replyBar');
    if (bar) bar.classList.add('hidden');
};

// Keep the comment input row visible above the on-screen keyboard: as the keyboard
// opens, the visual viewport shrinks — push the input row up by that difference.
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        const row = document.getElementById('commentInputRow');
        if (!row) return;
        const keyboardGap = window.innerHeight - window.visualViewport.height;
        row.style.transform = keyboardGap > 80 ? `translateY(-${keyboardGap}px)` : '';
    });
}
document.getElementById('commentInput').addEventListener('focus', () => {
    setTimeout(() => document.getElementById('commentInputRow').scrollIntoView({ behavior: 'smooth', block: 'end' }), 250);
});

document.getElementById('sendCommentBtn').onclick = async () => {
    const text = document.getElementById('commentInput').value.trim();
    if(!text) return;
    const res = await fetch('/api/addComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), postId: currentPostIdForComment, text, contentType: currentCommentContentType, parentId: replyTarget ? replyTarget.id : undefined }) });
    const data = await res.json();
    if (data && data.success) {
        document.getElementById('commentInput').value = '';
        cancelReply();
        fetchComments();
    } else {
        tg.showAlert(`Failed to comment: ${data.error || 'Server error'}`);
    }
};

window.likeComment = async (btn, commentId) => {
    btn.disabled = true;
    try {
        const res = await fetch('/api/likeComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), commentId }) });
        const data = await res.json();
        if (data && data.success) {
            btn.querySelector('.comment-like-count').innerText = data.likesCount;
            btn.classList.toggle('text-red-500', data.hasLiked);
            btn.classList.toggle('font-bold', data.hasLiked);
            const icon = btn.querySelector('i');
            icon.className = data.hasLiked ? 'fas fa-heart' : 'far fa-heart';
        }
    } catch(e) { console.error("Comment like failed:", e); }
    finally { btn.disabled = false; }
}

window.removeCommentDirect = async (id) => {
    await fetch('/api/deleteComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tgAuth(), commentId: id }) });
    fetchComments();
}
