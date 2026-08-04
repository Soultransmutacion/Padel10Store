#!/usr/bin/env node
/**
 * scripts/descargar-imagenes-royal-padel.js
 *
 * Lee un JSON generado por el relevamiento del catalogo de Royal Padel
 * (por ejemplo: data/royal-padel-indumentaria-femenina.json) y descarga
 * las imagenes originales de cada producto a una carpeta local.
 *
 * Uso:
 *   node scripts/descargar-imagenes-royal-padel.js
 *   node scripts/descargar-imagenes-royal-padel.js data/royal-padel-indumentaria-femenina.json
 *   node scripts/descargar-imagenes-royal-padel.js data/royal-padel-indumentaria-femenina.json --force
 *
 * Requisitos: Node.js 18+ (usa fetch nativo). Recomendado Node.js 20.
 *
 * No reemplaza archivos ya descargados salvo que se pase --force.
 * No se detiene si falla una imagen: registra el error y continua con las demas.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_JSON = 'data/royal-padel-indumentaria-femenina.json';
const args = process.argv.slice(2);
const force = args.includes('--force');
const jsonPathArg = args.find(a => !a.startsWith('--'));
const jsonPath = path.resolve(process.cwd(), jsonPathArg || DEFAULT_JSON);

function leerCatalogo(rutaJson) {
  if (!fs.existsSync(rutaJson)) {
    throw new Error(`No se encontro el archivo JSON: ${rutaJson}`);
  }
  const contenido = fs.readFileSync(rutaJson, 'utf8');
  return JSON.parse(contenido);
}

function asegurarCarpeta(carpeta) {
  fs.mkdirSync(carpeta, { recursive: true });
}

async function descargarImagen(url, destino) {
  const respuesta = await fetch(url, { redirect: 'follow' });
  if (!respuesta.ok) {
    throw new Error(`HTTP ${respuesta.status} ${respuesta.statusText}`);
  }
  const buffer = Buffer.from(await respuesta.arrayBuffer());
  fs.writeFileSync(destino, buffer);
  return buffer.length;
}

async function main() {
  console.log(`Leyendo catalogo: ${jsonPath}`);
  const catalogo = leerCatalogo(jsonPath);
  const productos = catalogo.productos || [];
  const carpetaBase = path.resolve(process.cwd(), catalogo.carpeta_imagenes_local || 'assets/productos/royal-padel/');
  asegurarCarpeta(carpetaBase);

  let totalImagenes = 0;
  let descargadas = 0;
  let omitidas = 0;
  let fallidas = 0;
  const errores = [];

  for (const producto of productos) {
    const imagenes = producto.imagenes || [];
    for (const imagen of imagenes) {
      totalImagenes++;
      const destino = path.join(carpetaBase, imagen.nombre_archivo_local);

      if (!force && fs.existsSync(destino)) {
        omitidas++;
        console.log(`OMITIDA (ya existe): ${imagen.nombre_archivo_local}`);
        continue;
      }

      try {
        const bytes = await descargarImagen(imagen.url_original, destino);
        descargadas++;
        console.log(`OK: ${imagen.nombre_archivo_local} (${bytes} bytes) <- ${producto.nombre}`);
      } catch (error) {
        fallidas++;
        const detalle = `${producto.nombre} / ${imagen.nombre_archivo_local}: ${error.message}`;
        errores.push(detalle);
        console.error(`ERROR: ${detalle}`);
      }
    }
  }

  console.log('---');
  console.log(`Productos procesados: ${productos.length}`);
  console.log(`Imagenes totales: ${totalImagenes}`);
  console.log(`Descargadas: ${descargadas}`);
  console.log(`Omitidas (ya existian): ${omitidas}`);
  console.log(`Fallidas: ${fallidas}`);
  if (errores.length) {
    console.log('Detalle de errores:');
    for (const e of errores) console.log(` - ${e}`);
  }

  if (fallidas > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exitCode = 1;
});
