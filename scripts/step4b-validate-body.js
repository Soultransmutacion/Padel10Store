const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'lib', 'mercadopago-preference.js');
let src = fs.readFileSync(p, 'utf8');
const anchor = fs.readFileSync('/tmp/anchor.txt', 'utf8');
const count = src.split(anchor).length - 1;
if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + ')'); process.exit(1); }

const replacement = [
"const MAX_TALLE_LENGTH = 10;",
"const ALLOWED_BODY_KEY_SETS = [",
"  ['productId'],",
"  ['productId', 'talle'],",
"];",
"function keysMatchAllowedSet(keys) {",
"  const sorted = keys.slice().sort();",
"  return ALLOWED_BODY_KEY_SETS.some(function (set) {",
"    const sortedSet = set.slice().sort();",
"    return sorted.length === sortedSet.length && sorted.every(function (k, i) { return k === sortedSet[i]; });",
"  });",
"}",
"function validateRequestBody(body) {",
"  if (!isPlainObject(body)) {",
"    return { ok: false, reason: 'invalid_body' };",
"  }",
"",
"  const keys = Object.keys(body);",
"  if (!keysMatchAllowedSet(keys)) {",
"    return { ok: false, reason: 'unexpected_fields' };",
"  }",
"",
"  const { productId, talle } = body;",
"  if (typeof productId !== 'string') {",
"    return { ok: false, reason: 'invalid_product_id' };",
"  }",
"",
"  const trimmed = productId.trim();",
"  if (!trimmed || trimmed.length > MAX_PRODUCT_ID_LENGTH) {",
"    return { ok: false, reason: 'invalid_product_id' };",
"  }",
"",
"  if (keys.indexOf('talle') > -1) {",
"    if (typeof talle !== 'string') {",
"      return { ok: false, reason: 'invalid_talle' };",
"    }",
"    const trimmedTalle = talle.trim();",
"    if (!trimmedTalle || trimmedTalle.length > MAX_TALLE_LENGTH) {",
"      return { ok: false, reason: 'invalid_talle' };",
"    }",
"    return { ok: true, productId: trimmed, talle: trimmedTalle };",
"  }",
"",
"  return { ok: true, productId: trimmed, talle: null };",
"}",
].join('\n');

src = src.replace(anchor, replacement);
fs.writeFileSync(p, src, 'utf8');
console.log('STEP4B_OK');
