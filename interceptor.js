// interceptor.js — Motor de intercepción propio de NetPulse AI
// Proxy MITM embebido (sobre http-mitm-proxy, JS puro) que descifra el tráfico
// HTTPS de ESTE equipo y lo traduce: cada petición, con su URL completa, y las
// imágenes y videos reales que circulan quedan guardados para el dashboard.
//
// No depende de mitmproxy ni de Wireshark: todo el código vive en tu herramienta.
// No modifica el sistema: de eso se encarga el control de proxy/certificado aparte.

const { Proxy } = require('http-mitm-proxy');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const cfg = require('./config');

// Las rutas viven fuera del árbol del proyecto (ver config.js): la clave de la
// autoridad certificadora nunca debe quedar al alcance del servidor de archivos.
const CA_DIR = cfg.CA_DIR;
const MEDIA = cfg.MEDIA_DIR;
const FLOWS = cfg.FLOWS_FILE;
const CA_CERT = path.join(CA_DIR, 'certs', 'ca.pem');
const PUERTO = cfg.PUERTO_PROXY;

const MAX_MEDIA_BYTES = 6 * 1024 * 1024;   // no guardar medios > 6 MB
const MAX_MEDIA_FILES = 500;
const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

let proxy = null;
let estado = { activo: false, desde: null, peticiones: 0, medios: 0, error: null };
let mediaCount = 0;

function appendFlow(rec) {
  try { fs.appendFileSync(FLOWS, JSON.stringify(rec) + '\n'); } catch {}
}

function categoria(ctype) {
  const c = (ctype || '').toLowerCase();
  if (c.startsWith('image/')) return 'imagen';
  if (c.startsWith('video/') || c.includes('mpegurl') || c.includes('mp2t')) return 'video';
  if (c.startsWith('audio/')) return 'audio';
  if (c.includes('json') || c.startsWith('application/')) return 'datos/api';
  if (c.startsWith('text/html')) return 'página';
  if (c.startsWith('text/css')) return 'estilo';
  if (c.includes('javascript')) return 'script';
  if (c.startsWith('text/')) return 'texto';
  return 'otro';
}

function descomprimir(buf, encoding) {
  try {
    if (!encoding) return buf;
    if (/gzip/.test(encoding)) return zlib.gunzipSync(buf);
    if (/deflate/.test(encoding)) return zlib.inflateSync(buf);
    if (/br/.test(encoding)) return zlib.brotliDecompressSync(buf);
  } catch {}
  return buf;
}

function iniciar() {
  if (estado.activo) return Promise.resolve({ ok: true, yaActivo: true });
  return new Promise((resolve) => {
    try { fs.writeFileSync(FLOWS, ''); } catch {}
    proxy = new Proxy();

    proxy.onError((ctx, err) => {
      // errores de conexión puntuales no deben tumbar el proxy
      if (err && !/ECONNRESET|EPIPE|socket hang up|ETIMEDOUT/i.test(err.message || '')) {
        estado.error = (err.message || '').slice(0, 200);
      }
    });

    proxy.onRequest((ctx, cb) => {
      const req = ctx.clientToProxyRequest;
      const host = req.headers.host || '';
      const https = !!ctx.isSSL;
      ctx._np = {
        ts: Date.now(),
        metodo: req.method,
        host,
        ruta: (req.url || '').slice(0, 300),
        url: (https ? 'https://' : 'http://') + host + (req.url || ''),
        chunks: [],
        recibidos: 0,
        reqChunks: [],
        reqRecibidos: 0,
      };
      // acumular cuerpo de la petición (mensajes/formularios) hasta 8 KB
      ctx.onRequestData((ctx2, chunk, cb2) => {
        if (ctx._np.reqRecibidos < 8192) {
          ctx._np.reqChunks.push(chunk);
          ctx._np.reqRecibidos += chunk.length;
        }
        return cb2(null, chunk);
      });
      return cb();
    });

    proxy.onResponse((ctx, cb) => {
      const np = ctx._np;
      if (!np) return cb();
      const resp = ctx.serverToProxyResponse;
      np.status = resp.statusCode;
      np.tipo = (resp.headers['content-type'] || '').split(';')[0].trim();
      np.cat = categoria(np.tipo);
      np.enc = resp.headers['content-encoding'] || '';
      np.esMedia = np.cat === 'imagen' || np.cat === 'video';
      np.esTexto = np.cat === 'datos/api' || np.cat === 'texto' || np.tipo === 'application/json';

      ctx.onResponseData((ctx2, chunk, cb2) => {
        // guardar bytes de medios (para imagen/video) y de texto pequeño (mensajes)
        if ((np.esMedia || np.esTexto) && np.recibidos <= MAX_MEDIA_BYTES) {
          np.chunks.push(chunk);
          np.recibidos += chunk.length;
        }
        return cb2(null, chunk);
      });

      ctx.onResponseEnd((ctx3, cb3) => {
        finalizar(np);
        return cb3();
      });
      return cb();
    });

    proxy.listen({ port: PUERTO, host: '127.0.0.1', sslCaDir: CA_DIR }, (err) => {
      if (err) { estado.error = err.message; return resolve({ ok: false, error: err.message }); }
      estado.activo = true;
      estado.desde = Date.now();
      estado.error = null;
      resolve({ ok: true, ca: CA_CERT, puerto: PUERTO });
    });
  });
}

function finalizar(np) {
  estado.peticiones++;
  const rec = {
    ts: np.ts,
    metodo: np.metodo,
    host: np.host,
    ruta: np.ruta,
    url: np.url.slice(0, 500),
    status: np.status,
    tipo: np.tipo,
    categoria: np.cat,
    bytes: np.recibidos,
  };
  // cuerpo de la petición (mensajes enviados, búsquedas, formularios)
  if (np.reqChunks.length) {
    try {
      const t = Buffer.concat(np.reqChunks).toString('utf8');
      if (/[\x20-\x7e]/.test(t) && !/[\x00-\x08]/.test(t.slice(0, 50))) rec.envio = t.slice(0, 1500);
    } catch {}
  }
  const body = np.chunks.length ? Buffer.concat(np.chunks) : null;

  // guardar imagen / video real
  if (np.esMedia && body && body.length > 0 && body.length <= MAX_MEDIA_BYTES && mediaCount < MAX_MEDIA_FILES && EXT[np.tipo]) {
    try {
      const crypto = require('crypto');
      const h = crypto.createHash('md5').update(body).digest('hex').slice(0, 16);
      const fname = h + '.' + EXT[np.tipo];
      const fpath = path.join(MEDIA, fname);
      if (!fs.existsSync(fpath)) { fs.writeFileSync(fpath, body); mediaCount++; estado.medios++; }
      rec.media = '/media/' + fname;
      rec.mtipo = np.cat;
    } catch {}
  }
  // cuerpo de texto legible (respuestas JSON: mensajes, datos)
  if (np.esTexto && body && body.length && body.length < 200000) {
    try {
      const t = descomprimir(body, np.enc).toString('utf8');
      if (t && /[\x20-\x7e]/.test(t)) rec.contenido = t.slice(0, 1500);
    } catch {}
  }
  appendFlow(rec);
}

async function detener() {
  if (proxy) { try { proxy.close(); } catch {} proxy = null; }
  estado.activo = false;
  return { ok: true };
}

function flujos(since = 0, limite = 300) {
  let data = '';
  try {
    const fd = fs.openSync(FLOWS, 'r');
    const size = fs.fstatSync(fd).size;
    const leer = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(leer);
    fs.readSync(fd, buf, 0, leer, size - leer);
    fs.closeSync(fd);
    data = buf.toString('utf8');
  } catch { return { flujos: [], total: 0 }; }
  const lineas = data.split('\n').filter(Boolean);
  const out = [];
  for (let i = lineas.length - 1; i >= 0 && out.length < limite; i--) {
    try { const r = JSON.parse(lineas[i]); if (r.ts > since) out.push(r); } catch {}
  }
  return { flujos: out, total: lineas.length };
}

function medios(limite = 200) {
  try {
    return fs.readdirSync(MEDIA)
      .map((f) => ({ f, t: fs.statSync(path.join(MEDIA, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t).slice(0, limite)
      .map((x) => '/media/' + x.f);
  } catch { return []; }
}

function status() {
  return { ...estado, puerto: PUERTO, caPath: CA_CERT, caExiste: fs.existsSync(CA_CERT) };
}

module.exports = { iniciar, detener, flujos, medios, status, CA_CERT, CA_DIR, MEDIA };
