const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');
const aChar = String.fromCharCode(0xe1);
const broken = "Seleccion00e1 un talle";
const fixed = "Seleccion" + aChar + " un talle";
const count = html.split(broken).length - 1;
if (count !== 1) { console.error('BROKEN_TEXT_COUNT_' + count); process.exit(1); }
html = html.split(broken).join(fixed);
fs.writeFileSync(p, html, 'utf8');
console.log('FIXED_TALLE_MESSAGE');
