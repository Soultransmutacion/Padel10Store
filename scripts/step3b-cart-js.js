const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'index.html');
let html = fs.readFileSync(p, 'utf8');
function mustReplace(src, anchor, replacer, label) {
  const count = src.split(anchor).length - 1;
  if (count !== 1) { console.error('ANCHOR_ISSUE(' + count + '): ' + label); process.exit(1); }
  return src.replace(anchor, replacer);
}

// 1) Add cart state + functions right after setupTalles function definition
const anchorFns = "talleButtonsEl.appendChild(b);});}}";
const cartFns = [
"var cartLines=[];",
"var cartDrawerOverlay=document.getElementById('cartDrawerOverlay');",
"var cartDrawerEl=document.getElementById('cartDrawer');",
"var cartDrawerBody=document.getElementById('cartDrawerBody');",
"var cartDrawerTotalEl=document.getElementById('cartDrawerTotal');",
"var cartDrawerCloseBtn=document.getElementById('cartDrawerClose');",
"var cartDrawerCheckoutBtn=document.getElementById('cartDrawerCheckoutBtn');",
"function findCartLine(productId,talle){for(var i=0;i<cartLines.length;i++){if(cartLines[i].productId===productId&&cartLines[i].talle===talle)return i;}return -1;}",
"function addLineToCart(product,talle,cantidad){if(!product||!talle)return;var q=cantidad&&cantidad>0?cantidad:1;var idx=findCartLine(product.id,talle);if(idx>-1){cartLines[idx].cantidad+=q;}else{cartLines.push({productId:product.id,talle:talle,nombre:product.nombre,precio:product.precio,imagen:(product.imagenes&&product.imagenes[0])||product.imagen||'',cantidad:q});}renderCartDrawer();}",
"function changeLineQty(idx,delta){if(!cartLines[idx])return;cartLines[idx].cantidad+=delta;if(cartLines[idx].cantidad<1){cartLines.splice(idx,1);}renderCartDrawer();updateCartBadge();}",
"function removeCartLine(idx){if(!cartLines[idx])return;cartLines.splice(idx,1);renderCartDrawer();updateCartBadge();}",
"function cartLinesQty(){return cartLines.reduce(function(sum,l){return sum+l.cantidad;},0);}",
"function cartLinesTotal(){return cartLines.reduce(function(sum,l){return sum+(l.precio*l.cantidad);},0);}",
"function updateCartBadge(){var badge=document.querySelector('.cart-badge');if(!badge)return;var total=cartCount+cartLinesQty();if(total>0){badge.style.display='inline';badge.textContent=total;}else{badge.style.display='none';badge.textContent='';}}",
"function renderCartDrawer(){if(!cartDrawerBody)return;if(!cartLines.length){cartDrawerBody.innerHTML='<div class=\"empty\" id=\"cartDrawerEmpty\"><div class=\"empty-ico\">&#128722;</div><div class=\"empty-txt\">Tu carrito esta vacio</div></div>';}else{cartDrawerBody.innerHTML=cartLines.map(function(l,idx){return '<div class=\"ci\"><div class=\"ci-ico\"><img src=\"'+l.imagen+'\" alt=\"\" style=\"width:100%;height:100%;object-fit:contain;border-radius:8px;\"></div><div class=\"ci-info\"><div class=\"ci-name\">'+l.nombre+' (Talle '+l.talle+')</div><div class=\"ci-price\">'+formatPrice(l.precio)+'</div><div class=\"ci-qty\"><button class=\"qb\" data-idx=\"'+idx+'\" data-action=\"dec\">&#8722;</button><span class=\"qn\">'+l.cantidad+'</span><button class=\"qb\" data-idx=\"'+idx+'\" data-action=\"inc\">+</button></div></div><button class=\"ci-del\" data-idx=\"'+idx+'\" aria-label=\"Eliminar\">&#128465;</button></div>';}).join('');}if(cartDrawerTotalEl)cartDrawerTotalEl.textContent=formatPrice(cartLinesTotal());}",
"if(cartDrawerBody)cartDrawerBody.addEventListener('click',function(e){var btn=e.target.closest?e.target.closest('button[data-idx]'):null;if(!btn)return;var idx=parseInt(btn.dataset.idx,10);if(btn.dataset.action==='inc')changeLineQty(idx,1);else if(btn.dataset.action==='dec')changeLineQty(idx,-1);else if(btn.classList.contains('ci-del'))removeCartLine(idx);});",
"function openCartDrawer(){renderCartDrawer();if(cartDrawerOverlay)cartDrawerOverlay.classList.add('open');if(cartDrawerEl)cartDrawerEl.classList.add('open');document.body.style.overflow='hidden';}",
"function closeCartDrawer(){if(cartDrawerOverlay)cartDrawerOverlay.classList.remove('open');if(cartDrawerEl)cartDrawerEl.classList.remove('open');document.body.style.overflow='';}",
"if(cartDrawerCloseBtn)cartDrawerCloseBtn.addEventListener('click',closeCartDrawer);",
"if(cartDrawerOverlay)cartDrawerOverlay.addEventListener('click',function(e){if(e.target===cartDrawerOverlay)closeCartDrawer();});",
"if(cartDrawerCheckoutBtn)cartDrawerCheckoutBtn.addEventListener('click',function(){if(!cartLines.length)return;var lines=cartLines.map(function(l){return '- '+l.nombre+' (Talle '+l.talle+') x'+l.cantidad+': '+formatPrice(l.precio*l.cantidad);}).join('%0A');var msg='Hola! Quiero confirmar stock y coordinar el pago de mi carrito:%0A'+lines+'%0A%0ATotal: '+formatPrice(cartLinesTotal());window.open('https://wa.me/5493413637355?text='+msg,'_blank');});",
"var cartBtnEl=document.getElementById('cartBtn');",
"if(cartBtnEl)cartBtnEl.addEventListener('click',openCartDrawer);",
].join("\n");
html = mustReplace(html, anchorFns, anchorFns + "\n" + cartFns, 'CART_FUNCTIONS_INSERTION');

// 2) Update buyBtn handler to use the real cart for talle products, and route badge updates through updateCartBadge()
const anchorBuy = "return;}cartCount++;var badge=document.querySelector('.cart-badge');if(badge){badge.style.display='inline';badge.textContent=cartCount;}buyBtn.textContent='Agregado al carrito!';buyBtn.classList.add('added');";
const insertBuy = "return;}if(currentProduct&&Array.isArray(currentProduct.talles)&&currentProduct.talles.length){addLineToCart(currentProduct,window.__selectedTalle,qty);}else{cartCount++;}updateCartBadge();buyBtn.textContent='Agregado al carrito!';buyBtn.classList.add('added');";
html = mustReplace(html, anchorBuy, insertBuy, 'BUYBTN_CART_INTEGRATION');

fs.writeFileSync(p, html, 'utf8');
console.log('STEP3B_OK');
