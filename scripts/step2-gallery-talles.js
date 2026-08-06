const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');

function mustReplace(src, anchor, replacer, label) {
  if (!src.includes(anchor)) { console.error('ANCHOR_NOT_FOUND: ' + label); process.exit(1); }
  return src.replace(anchor, replacer);
}

// 1) CSS: append gallery + talle styles before </style>
const cssAnchor = '</style>';
const newCss = [
'.gallery-nav{position:absolute;top:50%;transform:translateY(-50%);width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;border:1px solid rgba(255,255,255,.25);font-size:20px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:2}',
'.gallery-nav:hover{background:rgba(201,162,39,.85)}',
'.gallery-prev{left:10px}',
'.gallery-next{right:10px}',
'.gallery-dots{position:absolute;bottom:10px;left:0;right:0;display:flex;justify-content:center;gap:6px;z-index:2}',
'.gallery-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.4);cursor:pointer;transition:background .15s}',
'.gallery-dot.active{background:#C9A227}',
'.modal-talle-row{margin:10px 0}',
'.modal-talle-buttons{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}',
'.talle-btn{min-width:42px;padding:6px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.05);color:#fff;font-family:\'Barlow Condensed\',sans-serif;font-weight:700;cursor:pointer;transition:all .15s}',
'.talle-btn:hover{border-color:#C9A227}',
'.talle-btn.selected{background:#C9A227;color:#111;border-color:#C9A227}',
'.modal-talle-msg{color:#e05555;font-size:12px;margin-top:6px;min-height:14px}',
].join('\n') + '\n';
html = mustReplace(html, cssAnchor, newCss + cssAnchor, 'CSS_STYLE_CLOSE');

// 2) HTML: gallery controls inside modal-img-panel
const imgAnchor = '<img id="modalImg" src="" alt="">';
const galleryHtml = imgAnchor + '\n<button class="gallery-nav gallery-prev" id="galleryPrev" type="button" aria-label="Imagen anterior" hidden>&#8249;</button>\n<button class="gallery-nav gallery-next" id="galleryNext" type="button" aria-label="Imagen siguiente" hidden>&#8250;</button>\n<div class="gallery-dots" id="galleryDots"></div>';
html = mustReplace(html, imgAnchor, galleryHtml, 'MODAL_IMG_TAG');

// 3) HTML: talle selector inside modal-info, before the divider preceding qty row
const talleAnchor = '<div class="modal-cuotas" id="modalCuotas"></div>\n</div>\n<hr class="modal-divider">\n<div class="modal-qty-row" id="modalQtyRow">';
const talleHtml = '<div class="modal-cuotas" id="modalCuotas"></div>\n</div>\n<div class="modal-talle-row" id="modalTalleRow" hidden>\n<span class="modal-qty-label">Talle</span>\n<div class="modal-talle-buttons" id="modalTalleButtons"></div>\n<div class="modal-talle-msg" id="modalTalleMsg"></div>\n</div>\n<hr class="modal-divider">\n<div class="modal-qty-row" id="modalQtyRow">';
html = mustReplace(html, talleAnchor, talleHtml, 'TALLE_INSERTION_POINT');

fs.writeFileSync(p, html, 'utf8');
console.log('STEP2_HTML_CSS_OK');
