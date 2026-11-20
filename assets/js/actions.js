'use strict';
window.sharePostDirectly = (id) => {
    const forwardLink = `https://t.me/SnapPagesBot/app?startapp=post_${id}`;
    const text = "Check out this amazing post on SnapPages!";
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(forwardLink)}&text=${encodeURIComponent(text)}`);
}

// Like count dynamic incrementer API handler
window.likePost = async (btn, postId) => {
    btn.disabled = true;
    try {
        const res = await fetch('/api/likePost', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ initData: tg.initData, postId })
        });
        const data = await res.json();
        
        if (data && data.success) {
            const countEl = btn.querySelector('.like-count');
            if (countEl) countEl.innerText = data.likesCount;

            btn.classList.toggle('text-red-500', data.hasLiked);
            btn.classList.toggle('font-bold', data.hasLiked);
            const icon = btn.querySelector('i');
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

    if (isMine) {
        content.innerHTML = `
            <button onclick="triggerEditPost('${postId}')" class="opt-item opt-blue"><span class="opt-icon"><i class="fas fa-pen"></i></span><span>Edit Post<small>Change caption or images</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
            <button onclick="triggerRemovePost('${postId}')" class="opt-item opt-red"><span class="opt-icon"><i class="fas fa-trash-alt"></i></span><span>Delete Post<small>Cannot be undone</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
        `;
    } else {
        content.innerHTML = `
            <button onclick="openReportSheet('${postId}')" class="opt-item opt-orange"><span class="opt-icon"><i class="fas fa-flag"></i></span><span>Report Post<small>Tell us what is wrong</small></span><i class="fas fa-chevron-right opt-chev"></i></button>
        `;
    }
}

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
                body: JSON.stringify({ initData: tg.initData, postId })
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
            body: JSON.stringify({ initData: tg.initData, [bodyKey]: postId, reason })
        });
        const data = await res.json();
        if (data && data.success) tg.showAlert("Thanks — this has been reported to our team.");
    } catch(e) { console.error("Report failed:", e); }
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

async function fetchComments() {
    const list = document.getElementById('commentList');
    list.innerHTML = '<p class="text-center text-gray-400 text-sm">Loading comments...</p>';
    
    try {
        const res = await fetch('/api/getComments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ postId: currentPostIdForComment, contentType: currentCommentContentType }) });
        const comments = await res.json();

        if (!comments || comments.length === 0) {
            list.innerHTML = '<p class="text-center text-gray-400 text-sm py-6">No Comments</p>';
            return;
        }

        list.innerHTML = '';
        comments.forEach(c => {
            const isMine = currentUser && String(c.author_id) === String(currentUser.tg_id);
            const hasLiked = c.likes_users && currentUser && c.likes_users.includes(currentUser.tg_id);
            const safeCommentText = (c.text || '').replace(/</g, "&lt;").replace(/>/g, "&gt;");
            const likeCount = c.likes_count || 0;

            list.innerHTML += `<div class="bg-gray-50 p-3 rounded-lg text-sm relative">
                <span class="font-bold text-gray-900">${c.author_name}</span>
                <p class="mt-1 text-gray-800">${safeCommentText}</p>
                <div class="mt-2 flex gap-4 text-xs text-gray-500">
                    <button onclick="likeComment(this, '${c.id}')" class="${hasLiked ? 'text-red-500 font-bold' : ''} hover:text-red-500 flex items-center gap-1"><i class="${hasLiked ? 'fas' : 'far'} fa-heart"></i> <span class="comment-like-count">${likeCount}</span> Like</button>
                    ${isMine ? `<button onclick="removeCommentDirect('${c.id}')" class="text-red-400 hover:text-red-600 flex items-center gap-1"><i class="fas fa-trash-alt"></i> Delete</button>` : ''}
                </div>
            </div>`;
        });
    } catch(e) {
        list.innerHTML = '<p class="text-center text-red-400 text-sm">Error loading comments.</p>';
    }
}

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
    const res = await fetch('/api/addComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tg.initData, postId: currentPostIdForComment, text, contentType: currentCommentContentType }) });
    const data = await res.json();
    if (data && data.success) {
        document.getElementById('commentInput').value = '';
        fetchComments();
    } else {
        tg.showAlert(`Failed to comment: ${data.error || 'Server error'}`);
    }
};

window.likeComment = async (btn, commentId) => {
    btn.disabled = true;
    try {
        const res = await fetch('/api/likeComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tg.initData, commentId }) });
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
    await fetch('/api/deleteComment', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ initData: tg.initData, commentId: id }) });
    fetchComments();
}
