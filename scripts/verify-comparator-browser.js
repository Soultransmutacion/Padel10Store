'use strict';

// Fase 2 - Etapa 3: verificacion manual en navegador real del comparador
// visual PRO.
//
// Este script NO forma parte de `npm test` ni de la CI (el workflow de
// GitHub Actions, .github/workflows/ci-mercadopago.yml, solo instala
// dependencias de npm y corre los tests de Node puro: no instala un
// navegador). Playwright esta disponible en este sandbox unicamente como
// herramienta global de verificacion manual, no como dependencia del
// proyecto - por eso este archivo vive en scripts/ y se corre a mano:
//
//   node scripts/verify-comparator-browser.js
//
// Que hace: sirve el repo tal cual (estatico) en un puerto local, intercepta
// la unica llamada de red que necesita mockearse (POST /api/padel-assistant,
// porque este sandbox no tiene AI_GATEWAY_API_KEY) y responde con una
// "comparison" REAL, generada contra el catalogo real via
// lib/padel-advisor-tools.js#executeTool('comparar_productos', ...) - nunca
// datos inventados a mano. Todo lo demas (findStoreCard, window.openModal,
// window.PadelCart, el drawer del carrito) es el codigo real de produccion
// corriendo en un Chromium real, sin mockear nada mas.
//
// Escenario (pedido explicito del cliente):
//   1. abrir el asistente
//   2. inyectar una comparacion valida
//   3. comprobar que el comparador se ve correctamente
//   4. verificar ambos productos
//   5. abrir uno con "Ver producto"
//   6. volver al chat
//   7. agregar el otro al carrito
//   8. abrir el carrito normal
//   9. comprobar que aparece ahi
// + verificacion en viewport mobile (mismo flujo completo).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const tools = require('../lib/padel-advisor-tools');
const catalog = require('../lib/padel-catalog');

const ROOT_DIR = path.join(__dirname, '..');
const PORT = 4173;
const SCREENSHOT_DIR = path.join(__dirname, '..', '.verify-screenshots');

const BARATA_ID = 'royal-padel-cross-black-26'; // sin talles
const CARA_ID = 'royal-padel-aniversario-36'; // sin talles

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function startStaticServer() {
  const server = http.createServer(function (req, res) {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT_DIR, urlPath);
    if (!filePath.startsWith(ROOT_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, function (err, data) {
      if (err) {
        res.writeHead(404);
        res.end('Not found: ' + urlPath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(function (resolve) {
    server.listen(PORT, function () {
      resolve(server);
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error('ASSERT FALLIDO: ' + message);
}

async function mockAssistantResponses(page, comparison, ofrecidos) {
  await page.route('**/api/padel-assistant', async function (route) {
    const payload = {
      reply: 'Te dejo la comparacion entre las dos palas.',
      cards: [],
      ofrecidos: ofrecidos,
      acciones: [],
      comparison: comparison,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

async function runScenario(browser, label, viewport) {
  console.log('\n=== Escenario: ' + label + ' (' + viewport.width + 'x' + viewport.height + ') ===');
  const context = await browser.newContext({ viewport: viewport });
  const page = await context.newPage();

  const compareOut = tools.executeTool('comparar_productos', { ids: [BARATA_ID, CARA_ID] });
  assert(compareOut.ok && compareOut.comparison, 'la comparacion real de catalogo debe armarse correctamente');
  await mockAssistantResponses(page, compareOut.comparison, [BARATA_ID, CARA_ID]);

  // 1) abrir el asistente
  await page.goto('http://localhost:' + PORT + '/index.html');
  await page.click('#paLauncher');
  await page.waitForSelector('#paPanel:not([hidden])');
  console.log('1) asistente abierto: OK');

  // 2) inyectar una comparacion valida (mock de /api/padel-assistant)
  await page.fill('#paInput', 'Compara estas dos palas');
  await page.click('#paSend');
  await page.waitForSelector('.pa-cmp', { timeout: 5000 });
  console.log('2) comparacion inyectada y renderizada: OK');

  // 3) comprobar que el comparador se ve correctamente (elementos clave presentes)
  const cmpBox = await page.$('.pa-cmp');
  const cmpVisible = await cmpBox.isVisible();
  assert(cmpVisible, 'el comparador debe estar visible');
  const headerCols = await page.$eval('.pa-cmp-header', function (el) { return getComputedStyle(el).display; });
  assert(headerCols === 'grid', 'la cabecera del comparador debe usar CSS grid');
  console.log('3) el comparador se ve correctamente (display:grid, visible): OK');

  // 4) verificar ambos productos
  const productCount = await page.$$eval('.pa-cmp-product', function (els) { return els.length; });
  assert(productCount === 2, 'deben mostrarse los 2 productos comparados');
  const nombreA = await page.$eval('.pa-cmp-product[data-product-id="' + BARATA_ID + '"] .pa-cmp-name', function (el) { return el.textContent; });
  const nombreB = await page.$eval('.pa-cmp-product[data-product-id="' + CARA_ID + '"] .pa-cmp-name', function (el) { return el.textContent; });
  assert(nombreA === catalog.getProductById(BARATA_ID).nombre, 'nombre real del producto A');
  assert(nombreB === catalog.getProductById(CARA_ID).nombre, 'nombre real del producto B');
  console.log('4) ambos productos verificados (' + nombreA + ' / ' + nombreB + '): OK');

  await fs.promises.mkdir(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, label + '-01-comparador.png'), fullPage: true });

  // 5) abrir uno con "Ver producto"
  await page.click('.pa-cmp-product[data-product-id="' + BARATA_ID + '"] button[data-cmp-action="ver"]');
  await page.waitForSelector('#productModal.open', { timeout: 5000 });
  const modalName = await page.$eval('#modalName', function (el) { return el.textContent; });
  assert(modalName === catalog.getProductById(BARATA_ID).nombre, 'el modal debe mostrar la ficha real del producto A');
  console.log('5) "Ver producto" abrio la ficha real (' + modalName + '): OK');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, label + '-02-modal-producto.png'), fullPage: true });

  // 6) volver al chat
  await page.click('#modalClose');
  await page.waitForSelector('#productModal:not(.open)', { timeout: 5000 });
  // Abrir la ficha activa document.body.style.overflow='hidden', lo que
  // minimiza el panel del asesor (mismo comportamiento ya existente de
  // Fase 1: bodyOverflowObserver). Se vuelve a abrir para "volver al chat".
  await page.click('#paLauncher');
  await page.waitForSelector('#paPanel:not([hidden])');
  await page.waitForSelector('.pa-cmp', { timeout: 5000 });
  console.log('6) de vuelta en el chat, el comparador sigue visible: OK');

  // 7) agregar el otro al carrito
  await page.click('.pa-cmp-product[data-product-id="' + CARA_ID + '"] button[data-cmp-action="agregar"]');
  await page.waitForFunction(
    function (id) {
      var btn = document.querySelector('.pa-cmp-product[data-product-id="' + id + '"] button[data-cmp-action="agregar"]');
      return btn && btn.textContent === 'Agregado!';
    },
    CARA_ID,
    { timeout: 5000 }
  );
  console.log('7) "Agregar al carrito" del producto B: OK');

  // 8) abrir el carrito normal
  await page.click('#cartBtn');
  await page.waitForSelector('#cartDrawer.open', { timeout: 5000 });
  console.log('8) carrito normal abierto: OK');

  // 9) comprobar que aparece ahi
  const cartText = await page.$eval('#cartDrawerBody', function (el) { return el.textContent; });
  assert(cartText.indexOf(catalog.getProductById(CARA_ID).nombre) > -1, 'el producto agregado desde el comparador debe verse en el carrito real');
  console.log('9) el producto agregado desde el comparador aparece en el carrito real: OK');
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, label + '-03-carrito.png'), fullPage: true });

  await context.close();
  console.log('=== Escenario "' + label + '" completo: TODO OK ===');
}

async function main() {
  const server = await startStaticServer();
  console.log('Servidor estatico local en http://localhost:' + PORT);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  try {
    await runScenario(browser, 'desktop', { width: 1280, height: 900 });
    await runScenario(browser, 'mobile', { width: 390, height: 844 });
    console.log('\nCapturas guardadas en: ' + SCREENSHOT_DIR);
    console.log('\nVERIFICACION COMPLETA: TODOS LOS PASOS OK (desktop + mobile)');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(function (err) {
  console.error('\nVERIFICACION FALLIDA:', err && err.message ? err.message : err);
  process.exitCode = 1;
});
