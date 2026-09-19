// config.js — Configuración central de NetPulse AI.
//
// Un único sitio donde viven el enlace de red, el puerto, el testigo de sesión
// y las rutas de datos. Los datos NO viven ya dentro del árbol del proyecto:
// se guardan en %APPDATA%\NetPulse, de modo que el servidor de archivos no
// pueda entregar por error la clave privada de la autoridad certificadora.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Solo se escucha en la interfaz de bucle local: la herramienta descifra el
// tráfico del propio equipo y no debe quedar expuesta al resto de la red.
const BIND = '127.0.0.1';
const PORT = parseInt(process.env.NETPULSE_PORT, 10) || 3001;
const PUERTO_PROXY = parseInt(process.env.NETPULSE_PROXY_PORT, 10) || 8080;

// Testigo nuevo en cada arranque. Viaja al navegador incrustado en el HTML que
// sirve este mismo servidor, así que una página ajena no puede leerlo.
const TOKEN = crypto.randomBytes(24).toString('hex');

const DATA_DIR = process.env.NETPULSE_DATA_DIR
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'NetPulse');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const CA_DIR = path.join(DATA_DIR, 'ca');
const FLOWS_FILE = path.join(DATA_DIR, 'flujos.jsonl');
const HIST_FILE = path.join(DATA_DIR, 'telemetria_db.json');
const DEVICES_FILE = path.join(DATA_DIR, 'dispositivos_db.json');

for (const d of [DATA_DIR, MEDIA_DIR, CA_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

// Nombre del emisor de la autoridad que crea http-mitm-proxy. Se usa tal cual
// para buscar y retirar el certificado del almacén de confianza de Windows.
const CA_ISSUER = 'NodeMITMProxyCA';

// Archivos que el servidor puede entregar. Todo lo demás se rechaza; los medios
// capturados tienen su propia ruta, /media/<archivo>, con validación de nombre.
const ARCHIVOS_PUBLICOS = new Set([
  '/index.html',
  '/radar.html',
]);

// Nombre de medio válido: el hash de 16 caracteres que genera el interceptor.
const RE_MEDIA = /^[a-f0-9]{16}\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|mov)$/;

// Dirección IPv4 real, sin margen para colar órdenes al intérprete de comandos.
function esIPv4(s) {
  if (typeof s !== 'string' || s.length > 15) return false;
  const p = s.split('.');
  if (p.length !== 4) return false;
  return p.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255);
}

module.exports = {
  BIND, PORT, PUERTO_PROXY, TOKEN,
  DATA_DIR, MEDIA_DIR, CA_DIR, FLOWS_FILE, HIST_FILE, DEVICES_FILE,
  CA_ISSUER, ARCHIVOS_PUBLICOS, RE_MEDIA, esIPv4,
};
