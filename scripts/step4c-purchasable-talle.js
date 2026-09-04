const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'lib', 'mercadopago-preference.js');
let src = fs.readFileSync(p, 'utf8');
const anchor = fs.readFileSync('/tmp/anchor2.txt', 'utf8');
const count = src.split(anchor).length - 1;
if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + ')'); process.exit(1); }

const replacement = [
"function getPurchasableProduct(productId, talle) {",
"  const product = getProductById(productId);",
"  if (!product) {",
"    return { ok: false, reason: 'not_found' };",
"  }",
"",
"  if (product.precioConsultar === true) {",
"    return { ok: false, reason: 'precio_consultar' };",
"  }",
"",
"  if (",
"    typeof product.precio !== 'number' ||",
"    !Number.isFinite(product.precio) ||",
"    product.precio <= 0",
"  ) {",
"    return { ok: false, reason: 'invalid_price' };",
"  }",
"",
"  if (!PURCHASABLE_PRODUCT_IDS.includes(product.id)) {",
"    return { ok: false, reason: 'not_enabled' };",
"  }",
"",
"  const requiresTalle = Array.isArray(product.talles) && product.talles.length > 0;",
"  if (requiresTalle) {",
"    if (!talle) {",
"      return { ok: false, reason: 'talle_required' };",
"    }",
"    if (!product.talles.includes(talle)) {",
"      return { ok: false, reason: 'talle_invalid' };",
"    }",
"  } else if (talle) {",
"    return { ok: false, reason: 'talle_not_applicable' };",
"  }",
"",
"  return { ok: true, product, talle: requiresTalle ? talle : null };",
"}",
].join('\n');

src = src.replace(anchor, replacement);
fs.writeFileSync(p, src, 'utf8');
console.log('STEP4C_OK');
