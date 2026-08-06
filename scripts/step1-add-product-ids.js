const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const data = require('../products.json');
const productos = data.productos;

const marker = '<div class="card"';
const parts = html.split(marker);

if (parts.length - 1 !== productos.length) {
  console.error('MISMATCH: cards=' + (parts.length - 1) + ' products=' + productos.length);
  process.exit(1);
}

let changed = 0;
let alreadyOk = 0;
let output = parts[0];
for (let i = 1; i < parts.length; i++) {
  const idx = i - 1;
  const product = productos[idx];
  const segment = parts[i];
  const tagEndIdx = segment.indexOf('>');
  const openTagRest = segment.slice(0, tagEndIdx);
  const rest = segment.slice(tagEndIdx);
  const m = openTagRest.match(/data-product-id="([^"]*)"/);
  if (m) {
    if (m[1] !== product.id) {
      console.error('ID MISMATCH at card ' + idx + ': found=' + m[1] + ' expected=' + product.id);
      process.exit(1);
    }
    output += marker + segment;
    alreadyOk++;
  } else {
    const newOpenTagRest = openTagRest + ' data-product-id="' + product.id + '"';
    output += marker + newOpenTagRest + rest;
    changed++;
  }
}

fs.writeFileSync(htmlPath, output, 'utf8');
console.log('Cards total: ' + productos.length + ' | newly tagged: ' + changed + ' | already tagged: ' + alreadyOk);
