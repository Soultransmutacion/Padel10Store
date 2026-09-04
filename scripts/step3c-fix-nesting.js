const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');
function mustReplace(src, anchor, replacer, label) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return src.replace(anchor, replacer);
}
const anchor = '<!-- CARRITO -->';
html = mustReplace(html, anchor, '</div>\n' + anchor, 'ADD_MISSING_PRODUCTMODAL_CLOSE');
fs.writeFileSync(p, html, 'utf8');
console.log('STEP3C_OK');
