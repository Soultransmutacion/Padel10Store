const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');
function mustReplace(src, anchor, replacer, label) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return src.replace(anchor, replacer);
}
const anchor = '4.9 calificacion</span></div>\n</div>\n</div>\n</div>\n';
const drawerHtml = [
'<!-- CARRITO -->',
'<div class="drw-ov" id="cartDrawerOverlay">',
'<div class="drw" id="cartDrawer" role="dialog" aria-modal="true">',
'<div class="drw-h">',
'<span class="drw-title">Carrito</span>',
'<button class="drw-close" id="cartDrawerClose" aria-label="Cerrar">&#x2715;</button>',
'</div>',
'<div class="drw-body" id="cartDrawerBody">',
'<div class="empty" id="cartDrawerEmpty">',
'<div class="empty-ico">&#128722;</div>',
'<div class="empty-txt">Tu carrito esta vacio</div>',
'</div>',
'</div>',
'<div class="drw-f">',
'<div class="total-row">',
'<span class="total-lbl">Total</span>',
'<span class="total-v" id="cartDrawerTotal">$0</span>',
'</div>',
'<button class="chk-btn" id="cartDrawerCheckoutBtn">Consultar por WhatsApp</button>',
'</div>',
'</div>',
'</div>',
].join('\n') + '\n';
html = mustReplace(html, anchor, anchor + drawerHtml, 'CART_DRAWER_INSERTION_POINT');
fs.writeFileSync(p, html, 'utf8');
console.log('STEP3_HTML_OK');
