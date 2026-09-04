const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');

function mustReplace(src, anchor, replacer, label) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return src.replace(anchor, replacer);
}

// A) Insert new state vars + CATALOG fetch + gallery/talle functions right after qtyRowEl declaration
const anchorA = "var qtyRowEl=document.getElementById('modalQtyRow');";
const insertA = anchorA + "\n" + [
"var galleryPrevBtn=document.getElementById('galleryPrev');",
"var galleryNextBtn=document.getElementById('galleryNext');",
"var galleryDotsEl=document.getElementById('galleryDots');",
"var talleRowEl=document.getElementById('modalTalleRow');",
"var talleButtonsEl=document.getElementById('modalTalleButtons');",
"var talleMsgEl=document.getElementById('modalTalleMsg');",
"var galleryImages=[],galleryIndex=0,currentProduct=null;",
"var PURCHASABLE_PRODUCT_IDS=['royal-padel-cross-black-26'];",
"window.CATALOG=window.CATALOG||{};",
"fetch('products.json').then(function(r){return r.json();}).then(function(data){var list=(data&&data.productos)||[];list.forEach(function(p){if(p&&p.id)window.CATALOG[p.id]=p;});}).catch(function(){});",
"function renderGalleryImage(){if(!galleryImages.length)return;imgEl.src=galleryImages[galleryIndex];imgEl.alt=nameEl.textContent;if(galleryDotsEl){Array.prototype.forEach.call(galleryDotsEl.children,function(dot,idx){dot.classList.toggle('active',idx===galleryIndex);});}}",
"function setupGallery(product){var imagenes=(product&&Array.isArray(product.imagenes)&&product.imagenes.length)?product.imagenes.slice():((product&&product.imagen)?[product.imagen]:null);if(!imagenes||!imagenes.length){galleryImages=[];galleryIndex=0;if(galleryPrevBtn)galleryPrevBtn.hidden=true;if(galleryNextBtn)galleryNextBtn.hidden=true;if(galleryDotsEl)galleryDotsEl.innerHTML='';return;}galleryImages=imagenes;galleryIndex=0;renderGalleryImage();var multi=galleryImages.length>1;if(galleryPrevBtn)galleryPrevBtn.hidden=!multi;if(galleryNextBtn)galleryNextBtn.hidden=!multi;if(galleryDotsEl){galleryDotsEl.innerHTML='';if(multi){galleryImages.forEach(function(_,idx){var dot=document.createElement('span');dot.className='gallery-dot'+(idx===0?' active':'');dot.addEventListener('click',function(){galleryIndex=idx;renderGalleryImage();});galleryDotsEl.appendChild(dot);});}}}",
"if(galleryPrevBtn)galleryPrevBtn.addEventListener('click',function(){if(!galleryImages.length)return;galleryIndex=(galleryIndex-1+galleryImages.length)%galleryImages.length;renderGalleryImage();});",
"if(galleryNextBtn)galleryNextBtn.addEventListener('click',function(){if(!galleryImages.length)return;galleryIndex=(galleryIndex+1)%galleryImages.length;renderGalleryImage();});",
"function setupTalles(product){var talles=(product&&Array.isArray(product.talles)&&product.talles.length)?product.talles:[];window.__selectedTalle=null;if(!talleRowEl)return;if(!talles.length){talleRowEl.hidden=true;window.__talleGuardActive=false;if(talleButtonsEl)talleButtonsEl.innerHTML='';if(talleMsgEl)talleMsgEl.textContent='';return;}talleRowEl.hidden=false;window.__talleGuardActive=true;if(talleMsgEl)talleMsgEl.textContent='';if(talleButtonsEl){talleButtonsEl.innerHTML='';talles.forEach(function(t){var b=document.createElement('button');b.type='button';b.className='talle-btn';b.textContent=t;b.addEventListener('click',function(){window.__selectedTalle=t;window.__talleGuardActive=false;if(talleMsgEl)talleMsgEl.textContent='';Array.prototype.forEach.call(talleButtonsEl.children,function(btn){btn.classList.toggle('selected',btn===b);});});talleButtonsEl.appendChild(b);});}}",
].join("\n");
html = mustReplace(html, anchorA, insertA, 'STATE_VARS_AND_FUNCTIONS');

// B) resolve product + call setupGallery/setupTalles inside openModal, after cuotasEl is set
const anchorB = "cuotasEl.textContent=cq?cq.textContent.trim():'';";
const insertB = anchorB + "\n" + [
"var productId=card.dataset?card.dataset.productId:'';",
"var product=(productId&&window.CATALOG)?window.CATALOG[productId]:null;",
"currentProduct=product;",
"setupGallery(product);",
"setupTalles(product);",
].join("\n");
html = mustReplace(html, anchorB, insertB, 'PRODUCT_RESOLUTION_IN_OPENMODAL');

// C) replace buyNowProductId resolution to use explicit whitelist instead of mere dataset presence
const anchorC = "var buyNowProductId=card.dataset?card.dataset.productId:'';";
const insertC = "var buyNowProductId=(product&&PURCHASABLE_PRODUCT_IDS.indexOf(product.id)>-1)?product.id:'';";
html = mustReplace(html, anchorC, insertC, 'BUYNOW_WHITELIST');

fs.writeFileSync(p, html, 'utf8');
console.log('STEP2B_JS_OK');
