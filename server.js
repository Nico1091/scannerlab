const http = require('http');
const fs = require('fs');
const path = require('path');
const { obtenerDatos, obtenerDispositivos, obtenerInfoDetalladaDispositivo, lookupOUI, pingLive, obtenerWiFiLive } = require('./escaneo');
const tele = require('./telemetria');
const interceptor = require('./interceptor');
const sistema = require('./sistema');
const cfg = require('./config');

// El equipo nunca puede quedarse sin internet ni con un certificado ajeno
// confiado: toda salida del proceso revierte el proxy y retira el certificado.
process.on('SIGINT', () => { try { sistema.revertirSync(); } catch {} process.exit(0); });
process.on('SIGTERM', () => { try { sistema.revertirSync(); } catch {} process.exit(0); });
process.on('exit', () => { try { sistema.revertirSync(); } catch {} });

// Cache del ultimo escaneo de dispositivos para la auditoria de red
let lastDevicesCache = { data: [], datos: null, ts: 0 };

// Manejo de errores no capturados para evitar crash del servidor
process.on('uncaughtException', (err) => {
  console.error('[ERROR NO CAPTURADO]', err);
  try { sistema.revertirSync(); } catch {}
});
process.on('unhandledRejection', (reason) => {
  console.error('[PROMESA RECHAZADA]', reason);
  try { sistema.revertirSync(); } catch {}
});

let PORT = cfg.PORT;

// Cache del ultimo escaneo de dispositivos (para pasar MAC al endpoint de detalle)
let lastDeviceCache = {};

// Cache de velocidad de internet (30 segundos)
let speedCache = { mbps: null, timestamp: 0, testing: false };

async function measureInternetSpeed() {
  const now = Date.now();
  if (speedCache.mbps !== null && (now - speedCache.timestamp) < 30000) {
    return { ok: true, mbps: speedCache.mbps, cached: true };
  }
  if (speedCache.testing) {
    while (speedCache.testing) { await new Promise(r => setTimeout(r, 200)); }
    return { ok: speedCache.mbps !== null, mbps: speedCache.mbps, cached: true };
  }
  speedCache.testing = true;
  try {
    const https = require('https');
    const result = await new Promise((resolve) => {
      const start = Date.now();
      const req = https.get('https://speed.cloudflare.com/__down?bytes=200000', { timeout: 10000 }, (res) => {
        let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; });
        res.on('end', () => {
          const elapsedSec = (Date.now() - start) / 1000;
          if (elapsedSec < 0.1) { resolve(null); return; }
          const mbps = ((bytes * 8) / elapsedSec) / 1_000_000;
          resolve(mbps);
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
    });
    if (result !== null) {
      speedCache.mbps = Math.round(result * 10) / 10;
      speedCache.timestamp = Date.now();
      console.log('[SpeedTest] ' + speedCache.mbps + ' Mbps');
      return { ok: true, mbps: speedCache.mbps };
    }
    return { ok: false, mbps: null, error: 'Sin conexion a internet o timeout' };
  } finally {
    speedCache.testing = false;
  }
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

function startServer(port) {
  const srv = http.createServer(async (req, res) => {
    // Sin CORS abierto: ninguna página ajena debe poder leer lo que hay aquí.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.method === 'OPTIONS') {
      res.writeHead(405);
      res.end();
      return;
    }

    const jsend = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    // Solo se atiende a quien llega por el nombre local: corta el reenlace de DNS.
    const anfitrion = (req.headers.host || '').split(':')[0];
    if (anfitrion && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(anfitrion)) {
      return jsend({ ok: false, error: 'Anfitrión no permitido' }, 403);
    }

    // El testigo viaja incrustado en el HTML que sirve este mismo servidor, de
    // modo que una página de otro origen no puede leerlo ni suplantar al usuario.
    const esApi = req.url.startsWith('/api/');
    if (esApi) {
      const enviado = req.headers['x-netpulse-token']
        || (req.url.match(/[?&]token=([a-f0-9]{48})/) || [])[1] || '';
      if (enviado !== cfg.TOKEN) {
        return jsend({ ok: false, error: 'Testigo ausente o inválido' }, 401);
      }
    }

    // ===== Endpoints de telemetría (NetPulse Radar) =====

    if (req.url === '/api/tele/conexiones') {
      try { jsend({ ok: true, data: await tele.conexiones() }); }
      catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url === '/api/tele/throughput') {
      try {
        const tp = await tele.throughput();
        jsend({ ok: true, data: tp });
      } catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url === '/api/tele/redes') {
      try { jsend({ ok: true, data: await tele.redesCercanas() }); }
      catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url === '/api/tele/dns') {
      try { jsend({ ok: true, data: await tele.dnsCache() }); }
      catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url.startsWith('/api/tele/captura')) {
      try {
        const seg = parseInt((req.url.match(/seg=(\d+)/) || [])[1], 10) || 6;
        jsend({ ok: true, data: await tele.capturaProfunda(seg) });
      } catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url === '/api/tele/auditoria') {
      try {
        let disp = lastDevicesCache.data, datos = lastDevicesCache.datos;
        if (!datos || (Date.now() - lastDevicesCache.ts) > 120000) {
          datos = await obtenerDatos();
          disp = await obtenerDispositivos(datos.ip.gateway);
          lastDevicesCache = { data: disp, datos, ts: Date.now() };
        }
        jsend({ ok: true, data: tele.auditoria(datos, disp) });
      } catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url === '/api/tele/historial') {
      try { jsend({ ok: true, data: tele.cargarHist() }); }
      catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url === '/api/tele/resumen') {
      try {
        const [tp, cx] = await Promise.all([tele.throughput(), tele.conexiones()]);
        tele.registrarHistorial(tp, cx);
        jsend({ ok: true, data: { throughput: tp, conexiones: cx } });
      } catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }

    // ===== Interceptor (captura descifrada del propio equipo) =====
    if (req.url === '/api/interceptor/start' && req.method === 'POST') {
      try {
        const r = await interceptor.iniciar();
        if (!r.ok) return jsend({ ok: false, error: r.error }, 500);
        const cert = await sistema.confiarCert(interceptor.CA_CERT);
        const px = await sistema.activarProxy(8080);
        jsend({ ok: true, cert, proxy: px, estado: interceptor.status() });
      } catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url === '/api/interceptor/stop' && req.method === 'POST') {
      try {
        await sistema.desactivarProxy();
        // Retirar también la confianza: el certificado sin proxy detrás es un
        // riesgo abierto, y era lo que quedaba puesto al desactivar.
        await sistema.olvidarCert();
        await interceptor.detener();
        jsend({ ok: true, estado: interceptor.status(), certRetirado: true });
      } catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url === '/api/interceptor/status') {
      try {
        const st = interceptor.status();
        st.proxyActivo = await sistema.proxyActivo();
        st.certConfiado = await sistema.certConfiado();
        jsend({ ok: true, data: st });
      } catch (e) { jsend({ ok: false, error: e.message }, 500); }
      return;
    }
    if (req.url.startsWith('/api/interceptor/flujos')) {
      const since = parseInt((req.url.match(/since=(\d+)/) || [])[1], 10) || 0;
      jsend({ ok: true, data: interceptor.flujos(since) });
      return;
    }
    if (req.url === '/api/interceptor/medios') {
      jsend({ ok: true, data: interceptor.medios() });
      return;
    }

    if (req.url === '/api/scan') {
      try {
        const datos = await obtenerDatos();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: datos }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    if (req.url === '/api/devices') {
      try {
        const datos = await obtenerDatos();
        const gateway = datos.ip.gateway;
        const dispositivos = await obtenerDispositivos(gateway);
        // Guardar MACs en cache para el endpoint de detalle
        lastDeviceCache = {};
        for (const d of dispositivos) {
          if (d.mac && d.mac !== 'N/A') lastDeviceCache[d.ip] = d.mac;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: dispositivos, gateway }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Endpoint: info detallada de un dispositivo especifico
    const deviceMatch = req.url.match(/^\/api\/device\/(.+)$/);
    if (deviceMatch) {
      const targetIp = decodeURIComponent(deviceMatch[1]);
      if (!cfg.esIPv4(targetIp)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Dirección IPv4 no válida' }));
        return;
      }
      try {
        const info = await obtenerInfoDetalladaDispositivo(targetIp);
        // Usar MAC del cache del escaneo principal si no se detecto
        if ((!info.mac || info.mac === 'N/A') && lastDeviceCache[targetIp]) {
          info.mac = lastDeviceCache[targetIp];
          info.fabricante = lookupOUI ? lookupOUI(info.mac) : 'Desconocido';
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data: info }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Endpoint: ping en vivo a una IP
    const pingMatch = req.url.match(/^\/api\/ping\/(.+)$/);
    if (pingMatch) {
      const targetIp = decodeURIComponent(pingMatch[1]);
      if (!cfg.esIPv4(targetIp)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Dirección IPv4 no válida' }));
        return;
      }
      try {
        const ms = await pingLive(targetIp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ms }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Endpoint: datos WiFi en vivo (senial, velocidad, canal)
    if (req.url === '/api/wifi/live') {
      try {
        const info = await obtenerWiFiLive();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // Endpoint: velocidad de internet
    if (req.url === '/api/speed') {
      try {
        const result = await measureInternetSpeed();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
      return;
    }

    // ===== Medios capturados: ruta propia, nombre validado =====
    const mediaMatch = req.url.match(/^\/media\/([^/?#]+)$/);
    if (mediaMatch) {
      const nombre = decodeURIComponent(mediaMatch[1]);
      if (!cfg.RE_MEDIA.test(nombre)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Nombre de medio no válido');
        return;
      }
      const fpath = path.join(cfg.MEDIA_DIR, nombre);
      // Doble cierre: aunque el nombre ya está validado, se comprueba que la
      // ruta resuelta siga dentro de la carpeta de medios.
      if (path.dirname(path.resolve(fpath)) !== path.resolve(cfg.MEDIA_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Prohibido');
        return;
      }
      fs.readFile(fpath, (err, data) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('No encontrado'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(nombre)] || 'application/octet-stream' });
        res.end(data);
      });
      return;
    }

    // ===== Archivos servidos: solo los de la lista blanca =====
    // Nunca se sirve el árbol del proyecto: así ni la clave de la autoridad
    // certificadora ni los flujos capturados pueden pedirse por URL.
    const ruta = req.url.split('?')[0];
    const solicitado = (ruta === '/' || !path.extname(ruta)) ? '/index.html' : ruta;

    if (!cfg.ARCHIVOS_PUBLICOS.has(solicitado)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('No encontrado');
      return;
    }

    fs.readFile(path.join(__dirname, solicitado.slice(1)), 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error del servidor');
        return;
      }
      // El testigo de la sesión se incrusta aquí: el navegador lo recibe con la
      // página y ninguna web ajena puede leerlo.
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html.replace(/__NETPULSE_TOKEN__/g, cfg.TOKEN));
    });
  });

  srv.listen(port, cfg.BIND, () => {
    console.log(`\n========================================`);
    console.log(`  NetPulse AI - Servidor Online`);
    console.log(`========================================`);
    console.log(`  Abre tu navegador en:`);
    console.log(`  http://127.0.0.1:${port}`);
    console.log(`  (solo este equipo — enlace en ${cfg.BIND})`);
    console.log(`========================================\n`);
  });

  srv.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`  Puerto ${port} ocupado, probando ${port + 1}...`);
      srv.close();
      startServer(port + 1);
    } else {
      console.error('[ERROR]', err.message);
      process.exit(1);
    }
  });
}

startServer(PORT);
