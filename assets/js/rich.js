'use strict';
// Renders Telegram "rich messages" (tables, slideshows, collages, lists, quotes …) that the server
// already converted into a sanitised block tree (see richToApp in server.js).
(function () {
    const photo = (u, extra) => `<img src="${u}" loading="lazy" decoding="async" onclick="openLightbox('${u}')" class="rich-img ${extra || ''}">`;
    const cap = (c) => c && (c.x || c.c) ? `<figcaption class="rich-cap">${c.x || ''}${c.c ? `<span class="rich-credit">${c.c}</span>` : ''}</figcaption>` : '';

    function block(b) {
        switch (b.t) {
            case 'p': return `<p class="rich-p">${b.x}</p>`;
            case 'h': return `<h${Math.min(b.n + 1, 6)} class="rich-h rich-h${b.n}">${b.x}</h${Math.min(b.n + 1, 6)}>`;
            case 'table': {
                const rows = b.rows.map(r => `<tr>${r.map(c => `<${c.h ? 'th' : 'td'} colspan="${c.cs}" rowspan="${c.rs}" style="text-align:${c.al}">${c.x}</${c.h ? 'th' : 'td'}>`).join('')}</tr>`).join('');
                return `<figure class="rich-fig"><div class="rich-table-wrap"><table class="rich-table ${b.bordered ? 'bordered' : ''} ${b.striped ? 'striped' : ''} ${b.compact ? 'compact' : ''}">${rows}</table></div>${b.cap ? `<figcaption class="rich-cap">${b.cap}</figcaption>` : ''}</figure>`;
            }
            case 'photo': return `<figure class="rich-fig">${photo(b.u)}${cap(b.cap)}</figure>`;
            case 'slide': {
                const items = b.items.filter(i => i.t === 'photo');
                if (!items.length) return '';
                return `<figure class="rich-fig"><div class="flex img-slider gap-1 rounded-lg overflow-x-auto">${items.map(i => `<div class="img-snap w-full flex-shrink-0">${photo(i.u)}</div>`).join('')}</div>${items.length > 1 ? `<p class="rich-cap text-center">1 – ${items.length} ›</p>` : ''}${cap(b.cap)}</figure>`;
            }
            case 'collage': {
                const items = b.items.filter(i => i.t === 'photo');
                const n = Math.min(items.length, 4);
                return `<figure class="rich-fig"><div class="rich-collage c${n}">${items.slice(0, 4).map(i => photo(i.u)).join('')}</div>${cap(b.cap)}</figure>`;
            }
            case 'video': return `<div class="rich-video"><i class="fas fa-play-circle"></i> Video — watch it in the Telegram channel</div>`;
            case 'list': return `<ul class="rich-list">${b.items.map(i => `<li>${i.chk ? `<i class="far ${i.done ? 'fa-check-square' : 'fa-square'}"></i> ` : `<span class="rich-lbl">${i.l}</span> `}${i.b.map(block).join('')}</li>`).join('')}</ul>`;
            case 'pre': return `<pre class="rich-pre"><code>${b.x}</code></pre>`;
            case 'quote': return `<blockquote class="rich-quote">${b.b.map(block).join('')}${b.c ? `<cite>${b.c}</cite>` : ''}</blockquote>`;
            case 'hr': return '<hr class="rich-hr">';
            case 'foot': return `<p class="rich-foot">${b.x}</p>`;
            default: return '';
        }
    }
    window.renderRich = (rich) => `<div class="rich" ${rich.rtl ? 'dir="rtl"' : ''}>${(rich.blocks || []).map(block).join('')}</div>`;
})();
document.addEventListener('click', (e) => { const s = e.target.closest && e.target.closest('.spoiler'); if (s) s.classList.toggle('show'); });
