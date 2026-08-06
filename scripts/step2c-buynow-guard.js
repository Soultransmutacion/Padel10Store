const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');

function mustReplace(src, anchor, replacer, label) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return src.replace(anchor, replacer);
}

// Capturing-phase guard registered before the deferred widget scripts run,
// so it always intercepts clicks on #modalBuyNowBtn before widget/mercadopago-buy.js's own listener.
const anchor = "document.addEventListener('DOMContentLoaded',function(){";
const guard = [
"document.addEventListener('click',function(e){",
"  var t=e.target&&e.target.closest?e.target.closest('#modalBuyNowBtn'):null;",
"  if(!t)return;",
"  if(window.__talleGuardActive&&!window.__selectedTalle){",
"    e.preventDefault();e.stopPropagation();",
"    var msg=document.getElementById('modalTalleMsg');",
"    if(msg)msg.textContent='Seleccion00e1 un talle';",
"  }",
"},true);\n",
].join("\n") + anchor;
html = mustReplace(html, anchor, guard, 'DOMCONTENTLOADED_OPEN');

fs.writeFileSync(p, html, 'utf8');
console.log('STEP2C_GUARD_OK');
