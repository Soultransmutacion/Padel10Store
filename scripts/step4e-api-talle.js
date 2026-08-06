const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'api', 'create-payment-preference.js');
let src = fs.readFileSync(p, 'utf8');
function mustReplace(s, anchor, replacer, label) {
  const count = s.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return s.replace(anchor, replacer);
}

const anchor1 = 'const productResult = getPurchasableProduct(validation.productId);';
const insert1 = 'const productResult = getPurchasableProduct(validation.productId, validation.talle);';
src = mustReplace(src, anchor1, insert1, 'GET_PURCHASABLE_PRODUCT_TALLE');

const anchor2 = [
"      const preferencePayload = buildPreferencePayload({",
"            product: productResult.product,",
"            backUrls,",
"      });",
].join('\n');
const insert2 = [
"      const preferencePayload = buildPreferencePayload({",
"            product: productResult.product,",
"            backUrls,",
"            talle: productResult.talle,",
"      });",
].join('\n');
if (src.split(anchor2).length - 1 !== 1) {
  console.error('ANCHOR2_NOT_FOUND_TRYING_LOOSE_MATCH');
  process.exit(1);
}
src = src.replace(anchor2, insert2);

fs.writeFileSync(p, src, 'utf8');
console.log('STEP4E_OK');
