const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'widget', 'mercadopago-buy.js');
let src = fs.readFileSync(p, 'utf8');
function mustReplace(s, anchor, replacer, label) {
  const count = s.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return s.replace(anchor, replacer);
}

const anchor1 = "var productId = button.dataset.productId;\n  if (!productId) return;";
const insert1 = "var productId = button.dataset.productId;\n  if (!productId) return;\n  var talle = button.dataset.talle || '';";
src = mustReplace(src, anchor1, insert1, 'READ_TALLE_DATASET');

const anchor2 = "body: JSON.stringify({ productId: productId })";
const insert2 = "body: JSON.stringify(talle ? { productId: productId, talle: talle } : { productId: productId })";
src = mustReplace(src, anchor2, insert2, 'BODY_TALLE');

fs.writeFileSync(p, src, 'utf8');
console.log('STEP4F_OK');
