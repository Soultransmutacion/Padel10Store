const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'validate-catalog.js');
let src = fs.readFileSync(p, 'utf8');

const anchor1 = "    img: extractField(chunk, /<img src=\"([^\"]*)\"/),\n";
if (!src.includes(anchor1)) { console.error('ANCHOR1_NOT_FOUND'); process.exit(1); }
const insert1 = anchor1 + "    productId: extractField(chunk, /data-product-id=\"([^\"]*)\"/),\n";
src = src.replace(anchor1, insert1);

const anchor2 = "  if (issues.length === 0) {\n";
if (!src.includes(anchor2)) { console.error('ANCHOR2_NOT_FOUND'); process.exit(1); }
const insert2 = [
"  const cardIds = cards.map((c) => c.productId);\n",
"  const missingIds = cardIds.filter((id) => !id).length;\n",
"  if (missingIds > 0) issues.push('Tarjetas sin data-product-id: ' + missingIds);\n",
"  const cardIdCounts = {};\n",
"  cardIds.forEach((id) => { if (id) cardIdCounts[id] = (cardIdCounts[id] || 0) + 1; });\n",
"  const dupCardIds = Object.entries(cardIdCounts).filter(([, c]) => c > 1);\n",
"  if (dupCardIds.length) issues.push('data-product-id duplicados en index.html: ' + JSON.stringify(dupCardIds));\n",
"  const catalogIdSet = new Set(ids);\n",
"  cardIds.forEach((id, i) => {\n",
"    if (!id) return;\n",
"    if (!catalogIdSet.has(id)) issues.push('data-product-id \"' + id + '\" (tarjeta ' + i + ') no existe en products.json');\n",
"    const expected = productos[i] ? productos[i].id : undefined;\n",
"    if (expected && id !== expected) issues.push('data-product-id distinto en la posicion ' + i + ': HTML=\"' + id + '\" JSON=\"' + expected + '\"');\n",
"  });\n",
"  if (missingIds === 0 && dupCardIds.length === 0) {\n",
"    console.log('\u2713 Las 92 tarjetas tienen data-product-id unico y coincide con products.json');\n",
"  }\n",
"\n",
].join('');
src = src.replace(anchor2, insert2 + anchor2);

fs.writeFileSync(p, src, 'utf8');
console.log('PATCH_OK');
