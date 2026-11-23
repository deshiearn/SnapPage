'use strict';
// ================= STARS: wallet, paid (premium) posts & reels, tips, deposits =================
const SX = { cfg: null, balance: null, earned: 0, pending: [], target: null, poll: null };
const sxPost = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tgAuth(), ...body }) });
    const d = await r.json().catch(() => ({})); d._status = r.status; return d;
};
const sxStar = (cls) => `<svg class="sx-star ${cls || ''}"><use href="#sxStar"/></svg>`;
const sxNum = (n) => Number(n || 0).toLocaleString('en-US');
const sxHaptic = (k) => { try { k === 'ok' ? tg.HapticFeedback.notificationOccurred('success') : tg.HapticFeedback.impactOccurred(k || 'light'); } catch (e) {} };

function sxToast(msg) {
    let t = document.getElementById('sxToast');
    if (!t) { t = document.createElement('div'); t.id = 'sxToast'; t.className = 'sx-toast'; document.body.appendChild(t); }
    t.innerHTML = msg; t.classList.add('on'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('on'), 2400);
}
window.sxToast = sxToast;

async function sxConfig() { if (!SX.cfg) { try { SX.cfg = await (await fetch('/api/stars/config')).json(); } catch (e) { SX.cfg = { enabled: true, packs: [50, 100, 250, 500, 1000], per_unit: 50, currency: 'USDT', fee: 10, min_price: 1, max_price: 5000, min_deposit: 10 }; } } return SX.cfg; }
async function sxRefresh() {
    if (!isRealTgUser()) return null;
    const d = await sxPost('/api/stars/wallet', {});
    if (d && d.balance !== undefined) { SX.balance = d.balance; SX.earned = d.earned; SX.pending = d.pending || []; SX.cfg = d.config || SX.cfg; sxPaintBalance(); }
    return d;
}
function isRealTgUser() {
    if (window.IS_GUEST) return false;
    let id = currentUser && (currentUser.tg_id || currentUser.id);
    if (!id) { try { id = tg.initDataUnsafe.user.id; } catch (e) {} }
    return /^\d+$/.test(String(id || ''));
}
function sxPaintBalance() {
    const m = document.getElementById('meStarsVal'); if (m) m.innerHTML = SX.balance === null ? '' : `${sxStar('sx-inl')} ${sxNum(SX.balance)}`;
    const b = document.getElementById('sxBalance'); if (b) sxCount(b, SX.balance || 0);
    const e = document.getElementById('sxEarned'); if (e) e.textContent = SX.earned ? `Earned from your content: ${sxNum(SX.earned)} Stars` : '';
}
function sxCount(el, to) {
    const from = Number(el.dataset.v || 0); el.dataset.v = to;
    if (from === to) { el.textContent = sxNum(to); return; }
    const t0 = performance.now(), dur = 700;
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = sxNum(Math.round(from + (to - from) * e)); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
}
// sparkle burst around an element (Telegram-Stars style)
function sxBurst(anchor, n) {
    const r = anchor.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let i = 0; i < (n || 14); i++) {
        const p = document.createElement('i'); p.className = 'sx-fly'; p.innerHTML = sxStar();
        const a = Math.random() * Math.PI * 2, d = 50 + Math.random() * 90;
        p.style.cssText = `left:${cx}px;top:${cy}px;--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 30}px;--s:${0.5 + Math.random() * 0.9};animation-delay:${Math.random() * 120}ms`;
        document.body.appendChild(p); setTimeout(() => p.remove(), 1100);
    }
}

// ---------- Wallet ----------
let sxTx = [], sxTxFilter = 'all';
const SX_TX = { deposit: ['Bought Stars', '#34c759'], unlock: ['Unlocked content', '#ff9500'], earn: ['Content unlocked', '#007aff'], tip: ['Star reaction sent', '#af52de'], tip_in: ['Star reaction received', '#ff2d55'], admin: ['Adjustment', '#8e8e93'], payout: ['Withdrawal', '#8e8e93'] };
function sxRenderTx() {
    const list = sxTx.filter(x => sxTxFilter === 'all' || (sxTxFilter === 'in' ? x.amount > 0 : x.amount < 0));
    document.getElementById('sxHistory').innerHTML = list.length ? list.map(x => { const n = SX_TX[x.kind] || [x.kind, '#8e8e93']; return `<div class="tgi-row sx-tx"><span class="sx-txic" style="background:${n[1]}">${sxStar()}</span><span class="tgi-label">${n[0]}<small>${timeAgo(x.created_at)}</small></span><b class="${x.amount > 0 ? 'sx-pos' : 'sx-neg'}">${x.amount > 0 ? '+' : '\u2212'}${sxNum(Math.abs(x.amount))} ${sxStar('sx-inl')}</b></div>`; }).join('') : '<div class="sx-empty">No transactions</div>';
}
window.sxFilter = (k) => { sxTxFilter = k; document.querySelectorAll('#sxSeg button').forEach((b, i) => b.classList.toggle('on', ['all', 'in', 'out'][i] === k)); sxRenderTx(); sxHaptic('light'); };
window.openWallet = async () => {
    if (!isRealTgUser()) return tg.showAlert('Open SnapPages inside Telegram to use Stars.');
    openSheet('walletBg', 'walletSheet');
    sxPaintBalance();
    const d = await sxRefresh();
    if (!d || d.error) { tg.showAlert((d && d.error) || 'Could not load your wallet. Check your connection.'); document.getElementById('sxHistory').innerHTML = `<div class="sx-empty">${escapeHtml((d && d.error) || 'Could not load your wallet.')}</div>`; return; }
    document.getElementById('sxPending').innerHTML = (d.pending || []).map(p => `<div class="tgi-card"><button class="tgi-row" onclick="sxResume(${p.id})"><span class="tg-ic" style="background:#ff9500"><i class="fas fa-hourglass-half"></i></span><span class="tgi-label">Unpaid invoice \u00b7 ${sxNum(p.stars)} Stars</span><span class="tgi-val">Check</span></button></div>`).join('');
    sxTx = d.txns || []; sxRenderTx();
};
window.sxResume = async (id) => { const d = await sxPost('/api/stars/checkDeposit', { id }); if (d.status === 'paid') { sxPaid(); } else sxToast(d.status === 'expired' ? 'Invoice expired' : 'Not paid yet'); };

// ---------- Add Stars (xRocket) ----------
window.openAddStars = async () => {
    const cfg = await sxConfig();
    const need = SX.target && SX.balance !== null ? Math.max(0, SX.target - SX.balance) : 0;
    const body = document.getElementById('addStarsBody');
    if (!cfg.deposits_ready) { body.innerHTML = '<div class="sx-wait"><div class="sx-bigstar sm">' + sxStar() + '</div><p class="sx-h">Coming soon</p><p class="sx-p">Buying Stars will be available shortly.</p></div>'; }
    else {
        const packs = (cfg.packs || []).slice();
        if (need >= cfg.min_deposit && !packs.includes(need)) packs.unshift(need);
        const row = (n) => `<button class="tgi-row sx-pack" onclick="sxBuy(${n})"><span class="sx-stack">${sxStar()}${n >= 100 ? sxStar() : ''}${n >= 500 ? sxStar() : ''}</span><span class="tgi-label"><b>${sxNum(n)}</b></span><span class="sx-price-tag">${(n / cfg.per_unit).toFixed(2)} ${cfg.currency}</span></button>`;
        body.innerHTML = `<div class="sx-field"><i class="sx-dust"></i><div class="sx-bigstar">${sxStar()}</div></div>
        <h3 class="sx-h" style="margin-top:0">Get More Stars</h3>
        <p class="sx-p">${need ? `You need <b>${sxNum(need)}</b> more Stars to continue.` : 'Choose the amount of Stars you would like to buy.'}</p>
        <div class="tgi-card" id="sxPacks">${packs.slice(0, 3).map(row).join('')}${packs.length > 3 ? `<button class="tgi-row sx-more" onclick="sxMorePacks()"><span class="tgi-label" style="color:var(--app-link,#007aff);text-align:center">Show More Options <i class="fas fa-chevron-down" style="font-size:11px"></i></span></button>` : ''}</div>
        <p class="tgi-head">Custom amount</p>
        <div class="tgi-card sx-custom"><input id="sxCustom" type="number" inputmode="numeric" min="${cfg.min_deposit}" placeholder="Minimum ${cfg.min_deposit}"><button onclick="sxBuy(parseInt(document.getElementById('sxCustom').value)||0)">Buy</button></div>
        <p class="tgi-foot"><span>Pay with crypto through xRocket in Telegram. Stars are added automatically.</span></p>`;
        SX.packRows = packs.map(row);
    }
    openSheet('addStarsBg', 'addStarsSheet');
};
window.sxMorePacks = () => { document.getElementById('sxPacks').innerHTML = SX.packRows.join(''); sxHaptic('light'); };
window.closeAddStars = () => { clearInterval(SX.poll); SX.poll = null; closeSheet('addStarsBg', 'addStarsSheet'); };
window.sxBuy = async (stars) => {
    const cfg = await sxConfig();
    if (!(stars >= cfg.min_deposit)) return tg.showAlert(`Minimum is ${cfg.min_deposit} Stars.`);
    const body = document.getElementById('addStarsBody');
    body.innerHTML = `<div class="sx-wait"><div class="sx-bigstar">${sxStar()}<i class="sx-sp s1"></i><i class="sx-sp s2"></i><i class="sx-sp s3"></i></div><p class="sx-h">Creating invoice…</p></div>`;
    const d = await sxPost('/api/stars/createDeposit', { stars });
    if (!d.success) { tg.showAlert(d.error || 'Could not start the payment.'); return openAddStars(); }
    body.innerHTML = `<div class="sx-wait"><div class="sx-bigstar">${sxStar()}<i class="sx-sp s1"></i><i class="sx-sp s2"></i><i class="sx-sp s3"></i></div>
        <p class="sx-h">${sxNum(stars)} Stars</p><p class="sx-p">${d.amount} ${d.currency}</p>
        <button class="sx-cta" onclick="sxOpenPay('${encodeURIComponent(d.url)}')">Pay with xRocket</button>
        <p class="sx-small"><i class="fas fa-circle-notch fa-spin"></i> Waiting for payment… Stars are added automatically.</p></div>`;
    sxOpenPay(encodeURIComponent(d.url));
    clearInterval(SX.poll); let n = 0;
    const check = async () => { if (++n > 200) return clearInterval(SX.poll); const c = await sxPost('/api/stars/checkDeposit', { id: d.id }); if (c.status === 'paid') { clearInterval(SX.poll); sxPaid(c.balance); } else if (c.status === 'expired') { clearInterval(SX.poll); tg.showAlert('This invoice expired.'); openAddStars(); } };
    SX.poll = setInterval(check, 4000);
    SX.checkNow = check;
};
window.sxOpenPay = (u) => { const url = decodeURIComponent(u); try { /^https:\/\/t\.me\//.test(url) ? tg.openTelegramLink(url) : tg.openLink(url); } catch (e) { window.open(url, '_blank'); } };
document.addEventListener('visibilitychange', () => { if (!document.hidden && SX.poll && SX.checkNow) SX.checkNow(); });
async function sxPaid(bal) {
    if (bal === undefined) { await sxRefresh(); } else { SX.balance = bal; sxPaintBalance(); }
    const body = document.getElementById('addStarsBody');
    body.innerHTML = `<div class="sx-wait"><div class="sx-bigstar done">${sxStar()}<i class="sx-sp s1"></i><i class="sx-sp s2"></i><i class="sx-sp s3"></i></div><p class="sx-h">Stars added!</p><p class="sx-p">Your balance is ${sxNum(SX.balance)} Stars.</p><button class="sx-cta" onclick="closeAddStars()">Done</button></div>`;
    sxHaptic('ok'); setTimeout(() => { const s = body.querySelector('.sx-bigstar'); if (s) sxBurst(s, 22); }, 150);
}

// ---------- Unlock ----------
function sxFindItem(kind, id) { return document.querySelector(kind === 'video' ? `.rl-item[data-video-id="${id}"]` : `.post-card[data-pid="${id}"]`); }
window.sxAskUnlock = async (kind, id, price) => {
    if (!isRealTgUser()) return tg.showAlert('Open SnapPages inside Telegram to unlock paid content.');
    SX.target = price; SX.unlock = { kind, id, price };
    document.getElementById('unlockTitle').textContent = kind === 'video' ? 'Unlock Paid Reel' : 'Unlock Paid Post';
    document.getElementById('unlockSub').textContent = kind === 'video' ? 'Pay with Stars to watch this reel. You will be able to watch it any time.' : 'Pay with Stars to see the photos in this post. You will be able to see them any time.';
    const go = document.getElementById('unlockGo'); go.innerHTML = `Unlock for ${sxStar('sx-inl')} ${sxNum(price)}`; go.disabled = false;
    document.getElementById('unlockBal').textContent = SX.balance === null ? '' : `Your balance is ${sxNum(SX.balance)} Stars`;
    openSheet('unlockBg', 'unlockSheet'); sxHaptic('light');
    sxRefresh().then(() => { document.getElementById('unlockBal').textContent = `Your balance is ${sxNum(SX.balance)} Stars`; });
};
window.sxDoUnlock = async () => {
    const u = SX.unlock; if (!u) return;
    const go = document.getElementById('unlockGo'); go.disabled = true; go.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
    const d = await sxPost('/api/stars/unlock', { type: u.kind, id: u.id });
    if (d._status === 402) { closeSheet('unlockBg', 'unlockSheet'); SX.balance = d.balance; sxPaintBalance(); setTimeout(() => { sxToast('Not enough Stars'); openAddStars(); }, 320); return; }
    if (!d.success) { go.disabled = false; go.innerHTML = 'Try again'; return tg.showAlert(d.error || 'Could not unlock.'); }
    SX.balance = d.balance; sxPaintBalance(); sxHaptic('ok');
    sxBurst(go, 20);
    setTimeout(() => closeSheet('unlockBg', 'unlockSheet'), 450);
    setTimeout(() => sxReveal(u.kind, u.id, d), 500);
};
function sxReveal(kind, id, d) {
    if (kind === 'video') {
        document.querySelectorAll(`.rl-item[data-video-id="${id}"]`).forEach(it => {
            const v = it.querySelector('video'); v.dataset.src = d.stream_url; it.classList.remove('sx-locked'); const lk = it.querySelector('.sx-lock'); if (lk) lk.remove();
            it.dataset.price = '0'; rlLoad(v); v.play().catch(() => {});
        });
    } else {
        document.querySelectorAll(`.post-card[data-pid="${id}"]`).forEach(card => {
            const box = card.querySelector('.sx-lockbox'); if (!box) return;
            const wrap = document.createElement('div'); wrap.className = 'mb-3 sx-reveal';
            wrap.innerHTML = postImagesHtml(d.image_urls || []);
            box.replaceWith(wrap);
            const badge = card.querySelector('.sx-pbadge'); if (badge) badge.classList.add('open');
        });
    }
}

// ---------- locked media UIs ----------
function sxLockedPostHtml(post) {
    const prev = post.preview_url ? `<img src="${post.preview_url}" class="sx-prev" alt="">` : '<div class="sx-prev sx-noprev"></div>';
    return `<div class="mb-3 sx-lockbox" onclick="sxAskUnlock('post','${post.id}',${post.price})">${prev}<i class="sx-dust"></i>
        <span class="sx-tag">${sxStar('sx-inl')} Paid</span>
        <span class="sx-pill">${sxStar('sx-inl')} Unlock for ${sxNum(post.price)}</span></div>`;
}
function sxLockedReelHtml(v) {
    return `<div class="sx-lock" onclick="sxAskUnlock('video','${v.id}',${v.price})">${v.preview_url ? `<img src="${v.preview_url}" class="sx-prev" alt="">` : ''}<i class="sx-dust"></i>
        <div class="sx-lockc"><span class="sx-tag" style="position:static">${sxStar('sx-inl')} Paid reel</span>
        <span class="sx-pill">${sxStar('sx-inl')} Unlock for ${sxNum(v.price)}</span></div></div>`;
}
const sxPriceBadge = (price) => price > 0 ? `<span class="sx-pbadge">${sxStar('sx-inl')} ${sxNum(price)}</span>` : '';

// ---------- Tips (Star reactions) ----------
const sxSliderAmt = (v) => { let a = Math.round(Math.exp(Math.log(2500) * v / 100)); if (a > 1000) a = Math.round(a / 100) * 100; else if (a > 100) a = Math.round(a / 10) * 10; else if (a > 20) a = Math.round(a / 5) * 5; return Math.max(1, Math.min(2500, a)); };
function sxAuthorName(btn) {
    const it = btn.closest('.rl-item'); if (it) { const n = it.querySelector('.rl-author b'); return n ? n.textContent.trim() : ''; }
    const c = btn.closest('.post-card'); const h = c && c.querySelector('h3'); return h ? h.childNodes[0].textContent.trim() : '';
}
window.sxOpenTip = async (kind, id, name) => {
    if (!isRealTgUser()) return tg.showAlert('Open SnapPages inside Telegram to send Stars.');
    SX.tip = { kind, id, amt: 10, show: true };
    document.getElementById('tipShow').classList.add('on');
    document.getElementById('tipRange').value = 29; sxSlide(29);
    document.getElementById('tipChoose').innerHTML = `Choose how many stars you want to send${name ? ` to <b>${escapeHtml(name)}</b>` : ''} to support this ${kind === 'video' ? 'reel' : 'post'}.`;
    document.getElementById('tipBalNum').textContent = SX.balance === null ? '–' : sxNum(SX.balance);
    document.getElementById('tipTop').classList.add('hidden');
    openSheet('tipBg', 'tipSheet'); sxHaptic('light');
    sxRefresh().then(() => { document.getElementById('tipBalNum').textContent = sxNum(SX.balance); });
    sxPost('/api/stars/topSenders', { type: kind, id }).then(list => {
        if (!Array.isArray(list) || !list.length) return;
        document.getElementById('tipTops').innerHTML = list.map(u => `<div class="sx-ts"><span class="sx-tsav">${u.anon ? '<i class="fas fa-user-secret"></i>' : `<img src="${u.photo || 'https://ui-avatars.com/api/?background=random&name=' + encodeURIComponent(u.name)}" onerror="this.src='https://ui-avatars.com/api/?name=U'" alt="">`}<em>${sxStar()}${sxNum(u.stars)}</em></span><span class="sx-tsn">${escapeHtml(u.name)}</span></div>`).join('');
        document.getElementById('tipTop').classList.remove('hidden');
    }).catch(() => {});
};
window.sxToggleShow = () => { SX.tip.show = !SX.tip.show; document.getElementById('tipShow').classList.toggle('on', SX.tip.show); sxHaptic('light'); };
window.sxSlide = (v) => {
    v = Number(v);
    const a = sxSliderAmt(v); if (SX.tip && SX.tip.amt !== a) sxHaptic('light');
    if (SX.tip) SX.tip.amt = a;
    document.getElementById('tipNum').textContent = sxNum(a);
    document.getElementById('tipGo').innerHTML = `Send ${sxStar('sx-inl')} ${sxNum(a)}`;
    const w = document.getElementById('tipWrap'); w.style.setProperty('--p', v / 100);
};
window.sxDoTip = async () => {
    const t = SX.tip; if (!t || !(t.amt > 0)) return;
    const go = document.getElementById('tipGo'); go.disabled = true; go.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i>';
    const d = await sxPost('/api/stars/tip', { type: t.kind, id: t.id, amount: t.amt, show: t.show });
    go.disabled = false;
    if (d._status === 402) { closeSheet('tipBg', 'tipSheet'); SX.balance = d.balance; SX.target = t.amt; sxPaintBalance(); setTimeout(() => { sxToast('Not enough Stars'); openAddStars(); }, 320); return; }
    if (!d.success) { go.innerHTML = 'Try again'; return tg.showAlert(d.error === 'self' ? "You can't tip yourself." : (d.error || 'Could not send.')); }
    SX.balance = d.balance; sxPaintBalance(); document.getElementById('tipBalNum').textContent = sxNum(d.balance); sxHaptic('ok'); sxBurst(go, 24);
    setTimeout(() => closeSheet('tipBg', 'tipSheet'), 450);
    setTimeout(() => sxToast(`${sxStar('sx-inl')} Sent ${sxNum(t.amt)} Stars`), 500);
};

// ---------- Composer: "Paid post / Paid reel" ----------
const SXP = { pp: 0, vp: 0 };
window.paidToggle = async (p) => {
    const on = document.getElementById(p + 'On').checked;
    if (on && !isRealTgUser()) { document.getElementById(p + 'On').checked = false; return tg.showAlert('Open SnapPages inside Telegram to create paid content.'); }
    document.getElementById(p + 'Box').classList.toggle('hidden', !on);
    if (on) { const cfg = await sxConfig(); const a = document.getElementById(p + 'Amt'); a.min = cfg.min_price; a.max = cfg.max_price; document.getElementById(p + 'Hint').textContent = `Viewers pay Stars to unlock it (${cfg.min_price}–${cfg.max_price}). You keep ${100 - Math.round(cfg.fee)}%.`; paidAmt(p); } else SXP[p] = 0;
    sxHaptic('light');
};
window.paidAmt = (p) => { const n = parseInt(document.getElementById(p + 'Amt').value) || 0; SXP[p] = n; const fee = (SX.cfg && SX.cfg.fee) || 10; const h = document.getElementById(p + 'Hint'); if (n > 0 && h) h.textContent = `Viewers pay ${sxNum(n)} Stars to unlock. You earn ${sxNum(n - Math.floor(n * fee / 100))} Stars each time.`; };
window.paidSet = (p, n) => { document.getElementById(p + 'Amt').value = n; paidAmt(p); sxHaptic('light'); };
function sxResetPaid(p) { const c = document.getElementById(p + 'On'); if (c) { c.checked = false; document.getElementById(p + 'Box').classList.add('hidden'); } SXP[p] = 0; }
// Tiny preview that gets blurred with CSS (never the real photo)
function sxTiny(src, isVideo) {
    return new Promise(res => {
        try {
            const draw = (w, h, el) => { const k = 36 / Math.max(w, h || 1), c = document.createElement('canvas'); c.width = Math.max(8, Math.round(w * k)); c.height = Math.max(8, Math.round(h * k)); c.getContext('2d').drawImage(el, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.5)); };
            if (isVideo) { const v = src; if (v.videoWidth) draw(v.videoWidth, v.videoHeight, v); else res(''); }
            else { const i = new Image(); i.onload = () => draw(i.naturalWidth, i.naturalHeight, i); i.onerror = () => res(''); i.src = src; }
        } catch (e) { res(''); }
    });
}
window.paidPostFields = async (images) => {
    if (!(SXP.pp > 0)) return {};
    return { price: SXP.pp, previewBase64: images && images[0] ? await sxTiny(images[0]) : '' };
};
window.paidVideoFields = async () => {
    if (!(SXP.vp > 0)) return {};
    return { price: SXP.vp, previewBase64: await sxTiny(document.getElementById('vuPreview'), true) };
};
window.sxResetPaid = sxResetPaid;

// Home "Premium" empty state + boot
document.addEventListener('DOMContentLoaded', () => { setTimeout(() => { if (isRealTgUser && typeof currentUser !== 'undefined') sxRefresh().catch(() => {}); }, 2500); });
