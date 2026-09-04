const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');
function mustReplace(src, anchor, replacer, label) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return src.replace(anchor, replacer);
}
const anchor = "buyBtn.addEventListener('click',function(){cartCount++;";
const guard = "if(window.__talleGuardActive&&!window.__selectedTalle){if(talleMsgEl)talleMsgEl.textContent='Seleccion" + String.fromCharCode(0xe1) + " un talle';return;}";
const insert = "buyBtn.addEventListener('click',function(){" + guard + "cartCount++;";
html = mustReplace(html, anchor, insert, 'BUYBTN_CLICK_HANDLER');
fs.writeFileSync(p, html, 'utf8');
console.log('STEP2F_OK');
