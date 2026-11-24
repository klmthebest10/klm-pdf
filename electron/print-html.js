// Susun HTML lembar cetak (dipakai main.js; bisa diuji terpisah)
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
module.exports = function printHtml(files, W, H, title) {
  W = +W; H = +H;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title || 'KLM PDF')}</title><style>
@page{size:${W}pt ${H}pt;margin:0}
html,body{margin:0;padding:0;background:#fff}
.s{width:${W}pt;height:${(H - 0.75).toFixed(2)}pt;overflow:hidden;break-after:page;page-break-after:always}
.s:last-child{break-after:auto;page-break-after:auto}
.s img{width:100%;height:100%;object-fit:contain;display:block}
</style></head><body>${files.map(f => `<div class="s"><img src="${esc(f)}"></div>`).join('')}</body></html>`;
};
