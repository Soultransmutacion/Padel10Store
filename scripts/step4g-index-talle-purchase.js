const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');
function mustReplace(s, anchor, replacer, label) {
  const count = s.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return s.replace(anchor, replacer);
}

// 1) Purchasability: base whitelist OR product has talles (mirrors server-side logic, single criterion, not mere dataset presence)
const anchor1 = "var buyNowProductId=(product&&PURCHASABLE_PRODUCT_IDS.indexOf(product.id)>-1)?product.id:'';";
const insert1 = "var buyNowProductId=(product&&(PURCHASABLE_PRODUCT_IDS.indexOf(product.id)>-1||(Array.isArray(product.talles)&&product.talles.length>0)))?product.id:'';";
html = mustReplace(html, anchor1, insert1, 'BUYNOW_PRODUCTID_TALLE_AWARE');

// 2) Reset dataset.talle when the modal is (re)configured for the current product
const anchor2 = "buyNowBtn.dataset.mpBusy='';";
const insert2 = "buyNowBtn.dataset.mpBusy='';\nbuyNowBtn.dataset.talle=window.__selectedTalle||'';";
html = mustReplace(html, anchor2, insert2, 'RESET_BUYNOW_TALLE_DATASET');

// 3) Keep buyNowBtn.dataset.talle in sync when the user picks a talle
const anchor3 = "window.__selectedTalle=t;window.__talleGuardActive=false;";
const insert3 = "window.__selectedTalle=t;window.__talleGuardActive=false;if(buyNowBtn)buyNowBtn.dataset.talle=t;";
html = mustReplace(html, anchor3, insert3, 'SYNC_BUYNOW_TALLE_ON_SELECT');

fs.writeFileSync(p, html, 'utf8');
console.log('STEP4G_OK');
