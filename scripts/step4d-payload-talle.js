const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'lib', 'mercadopago-preference.js');
let src = fs.readFileSync(p, 'utf8');
const anchor = fs.readFileSync('/tmp/anchor3.txt', 'utf8');
const count = src.split(anchor).length - 1;
if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + ')'); process.exit(1); }

const replacement = [
"function buildPreferencePayload({ product, backUrls, talle }) {",
"  const title = talle ? `${product.nombre} - Talle ${talle}` : product.nombre;",
"  return {",
"    items: [",
"      {",
"        id: product.id,",
"        title: title,",
"        quantity: FIXED_QUANTITY,",
"        currency_id: 'ARS',",
"        unit_price: product.precio,",
"      },",
"    ],",
"    back_urls: backUrls,",
"    auto_return: 'approved',",
"    statement_descriptor: 'PADEL10STORE TEST',",
"  };",
"}",
].join('\n');

src = src.replace(anchor, replacement);
fs.writeFileSync(p, src, 'utf8');
console.log('STEP4D_OK');
