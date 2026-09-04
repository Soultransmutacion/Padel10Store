const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'validate-catalog.js');
let src = fs.readFileSync(p, 'utf8');
function mustReplace(s, anchor, replacer, label) {
  const count = s.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return s.replace(anchor, replacer);
}

const anchor1 = "    productId: extractField(chunk, /data-product-id=\"([^\"]*)\"/),\n";
const insert1 = anchor1 + "    btnText: extractField(chunk, /class=\"add-btn\"[^>]*>([^<]*)</),\n";
src = mustReplace(src, anchor1, insert1, 'BTNTEXT_FIELD');

const anchor2 = "  if (issues.length === 0) {\n";
const insert2 = [
"  const talleProductIds = productos.filter((p) => Array.isArray(p.talles) && p.talles.length > 0).map((p) => p.id);\n",
"  cards.forEach((c, i) => {\n",
"    const expectedId = productos[i] ? productos[i].id : undefined;\n",
"    const isTalleCard = expectedId && talleProductIds.indexOf(expectedId) > -1;\n",
"    if (isTalleCard && c.btnText !== 'ELEGIR TALLE') {\n",
"      issues.push('Tarjeta con talles \"' + expectedId + '\" deberia tener el boton ELEGIR TALLE, tiene: \"' + c.btnText + '\"');\n",
"    }\n",
"    if (!isTalleCard && c.btnText === 'ELEGIR TALLE') {\n",
"      issues.push('Tarjeta \"' + expectedId + '\" tiene el boton ELEGIR TALLE sin declarar talles en products.json');\n",
"    }\n",
"  });\n",
"  const crossBlackCard = cards.find((c) => c.productId === 'royal-padel-cross-black-26');\n",
"  if (!crossBlackCard || crossBlackCard.btnText !== 'Consultar') {\n",
"    issues.push('Cross Black 26 deberia conservar el boton Consultar en su tarjeta (comportamiento previo sin cambios)');\n",
"  }\n",
"  if (talleProductIds.length !== 12) {\n",
"    issues.push('Se esperaban 12 productos con talles en products.json, se encontraron ' + talleProductIds.length);\n",
"  }\n",
"  if (missingIds === 0 && dupCardIds.length === 0 && issues.length === 0) {\n",
"    console.log('\u2713 Los 12 productos con talles muestran ELEGIR TALLE y Cross Black 26 conserva Consultar');\n",
"  }\n",
"\n",
].join('');
src = mustReplace(src, anchor2, insert2 + anchor2, 'BTNTEXT_CHECKS');

fs.writeFileSync(p, src, 'utf8');
console.log('STEP5B_OK');
