const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'lib', 'mercadopago-preference.js');
let src = fs.readFileSync(p, 'utf8');
function mustReplace(s, anchor, replacer, label) {
  const count = s.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return s.replace(anchor, replacer);
}

// 1) requires + purchasable ids: derive the talle-product ids from the catalog itself (single source of truth)
const anchor1 = "const { getProductById } = require('./padel-catalog');";
const insert1 = [
"const { getProductById, loadCatalog } = require('./padel-catalog');",
].join('\n');
src = mustReplace(src, anchor1, insert1, 'REQUIRE_LOADCATALOG');

const anchor2 = "const PURCHASABLE_PRODUCT_IDS = ['royal-padel-cross-black-26'];";
const insert2 = [
"const BASE_PURCHASABLE_PRODUCT_IDS = ['royal-padel-cross-black-26'];",
"function computePurchasableProductIds() {",
"  var talleIds = loadCatalog()",
"    .filter(function (p) { return Array.isArray(p.talles) && p.talles.length > 0; })",
"    .map(function (p) { return p.id; });",
"  return BASE_PURCHASABLE_PRODUCT_IDS.concat(talleIds);",
"}",
"const PURCHASABLE_PRODUCT_IDS = computePurchasableProductIds();",
].join('\n');
src = mustReplace(src, anchor2, insert2, 'PURCHASABLE_PRODUCT_IDS_DYNAMIC');

fs.writeFileSync(p, src, 'utf8');
console.log('STEP4A_OK');
