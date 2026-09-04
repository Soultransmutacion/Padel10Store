const fs = require('fs');
const path = require('path');
const htmlPath = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const data = require('../products.json');
const productos = data.productos;

const talleIds = productos.filter(function(p){return Array.isArray(p.talles) && p.talles.length;}).map(function(p){return p.id;});
if (talleIds.length !== 12) { console.error('EXPECTED_12_TALLE_IDS_GOT_' + talleIds.length); process.exit(1); }

const marker = '<div class="card"';
const parts = html.split(marker);
let changed = 0;
let output = parts[0];
for (let i = 1; i < parts.length; i++) {
  const idx = i - 1;
  const product = productos[idx];
  let segment = parts[i];
  if (talleIds.indexOf(product.id) > -1) {
    const oldBtn = '>Consultar</button>';
    const count = segment.split(oldBtn).length - 1;
    if (count !== 1) { console.error('BUTTON_NOT_FOUND_FOR_' + product.id + '_count_' + count); process.exit(1); }
    segment = segment.replace(oldBtn, '>ELEGIR TALLE</button>');
    changed++;
  }
  output += marker + segment;
}
if (changed !== 12) { console.error('CHANGED_COUNT_MISMATCH_' + changed); process.exit(1); }
fs.writeFileSync(htmlPath, output, 'utf8');
console.log('BUTTON_TEXT_CHANGED: ' + changed);
