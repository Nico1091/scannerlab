// telemetria.js — Motor de telemetría de red en vivo para NetPulse AI
// Traduce el tráfico de tu equipo a lenguaje humano: qué aplicación habla con
// qué servicio, cuánto tráfico circula, qué redes WiFi hay alrededor y qué le
// falta a tu red. Todo con fuentes que NO requieren administrador.
//
// Fuentes usadas (todas nativas de Windows / Node):
//   - Get-NetTCPConnection  -> conexiones activas + proceso dueño (PID)
//   - dns.reverse           -> nombre del servidor remoto (DNS inverso)
//   - Get-NetAdapterStatistics -> bytes rx/tx por adaptador (throughput real)
//   - netsh wlan show networks -> redes WiFi cercanas (requiere Ubicación ON)
//   - Get-DnsClientCache    -> dominios que el sistema resolvió sin cifrar
//   - pktmon                -> captura profunda opcional (mejor con admin)

const { exec } = require('child_process');
const dns = require('dns');
const dnsp = dns.promises;
const os = require('os');
const path = require('path');
const fs = require('fs');

const HIST_FILE = path.join(__dirname, 'telemetria_db.json');

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function ps(cmd, timeoutMs = 12000) {
  return new Promise((resolve) => {
    exec(
      'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' +
        cmd.replace(/"/g, '\\"') + '"',
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 32, windowsHide: true },
      (err, stdout) => resolve(stdout ? stdout.toString() : '')
    );
  });
}

function jsonSafe(txt, fallback) {
  if (!txt || !txt.trim()) return fallback;
  try {
    const v = JSON.parse(txt);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

// Extrae el dominio registrable de un hostname (server-1-2.cloudflare.com -> cloudflare.com)
const TLD2 = new Set(['co.uk', 'com.co', 'com.mx', 'com.br', 'com.ar', 'com.au', 'co.jp', 'net.co', 'org.co', 'gov.co', 'edu.co']);
function dominioRegistrable(host) {
  if (!host) return null;
  host = host.replace(/\.$/, '').toLowerCase();
  const p = host.split('.');
  if (p.length <= 2) return host;
  const dos = p.slice(-2).join('.');
  const tres = p.slice(-3).join('.');
  if (TLD2.has(dos)) return tres;
  return dos;
}

// Diccionario de servicios conocidos: dominio -> {nombre, categoria}
const SERVICIOS = {
  'google.com': ['Google', 'Búsqueda / Cuenta'],
  'googleapis.com': ['Google APIs', 'Servicios Google'],
  'gstatic.com': ['Google (estáticos)', 'CDN'],
  'googlevideo.com': ['YouTube (vídeo)', 'Streaming'],
  'youtube.com': ['YouTube', 'Streaming'],
  'ytimg.com': ['YouTube (imágenes)', 'CDN'],
  'doubleclick.net': ['Google Ads', 'Publicidad'],
  'google-analytics.com': ['Google Analytics', 'Telemetría'],
  'cloudflare.com': ['Cloudflare', 'CDN / Infraestructura'],
  'cloudflare-dns.com': ['Cloudflare DNS', 'DNS'],
  'amazonaws.com': ['Amazon AWS', 'Nube'],
  'aws.com': ['Amazon AWS', 'Nube'],
  'cloudfront.net': ['Amazon CloudFront', 'CDN'],
  'microsoft.com': ['Microsoft', 'Servicios'],
  'windows.com': ['Windows', 'Sistema'],
  'windowsupdate.com': ['Windows Update', 'Actualizaciones'],
  'msftncsi.com': ['Microsoft (conectividad)', 'Sistema'],
  'msftconnecttest.com': ['Microsoft (conectividad)', 'Sistema'],
  'office.com': ['Office 365', 'Ofimática'],
  'office365.com': ['Office 365', 'Ofimática'],
  'live.com': ['Microsoft Live', 'Cuenta'],
  'bing.com': ['Bing', 'Búsqueda'],
  'apple.com': ['Apple', 'Servicios'],
  'icloud.com': ['iCloud', 'Nube'],
  'akamai.net': ['Akamai', 'CDN'],
  'akamaiedge.net': ['Akamai', 'CDN'],
  'fbcdn.net': ['Facebook (CDN)', 'Redes sociales'],
  'facebook.com': ['Facebook', 'Redes sociales'],
  'instagram.com': ['Instagram', 'Redes sociales'],
  'whatsapp.net': ['WhatsApp', 'Mensajería'],
  'whatsapp.com': ['WhatsApp', 'Mensajería'],
  'x.com': ['X (Twitter)', 'Redes sociales'],
  'twitter.com': ['X (Twitter)', 'Redes sociales'],
  'twimg.com': ['X (imágenes)', 'CDN'],
  'tiktokcdn.com': ['TikTok (CDN)', 'Streaming'],
  'tiktokv.com': ['TikTok', 'Streaming'],
  'netflix.com': ['Netflix', 'Streaming'],
  'nflxvideo.net': ['Netflix (vídeo)', 'Streaming'],
  'spotify.com': ['Spotify', 'Música'],
  'scdn.co': ['Spotify (CDN)', 'Música'],
  'github.com': ['GitHub', 'Desarrollo'],
  'githubusercontent.com': ['GitHub (contenido)', 'Desarrollo'],
  'anthropic.com': ['Anthropic / Claude', 'IA'],
  'claude.ai': ['Claude', 'IA'],
  'openai.com': ['OpenAI', 'IA'],
  'discord.com': ['Discord', 'Mensajería'],
  'discord.gg': ['Discord', 'Mensajería'],
  'steamserver.net': ['Steam', 'Juegos'],
  'steampowered.com': ['Steam', 'Juegos'],
  'wikipedia.org': ['Wikipedia', 'Referencia'],
  'mercadolibre.com': ['MercadoLibre', 'Compras'],
  'nequi.com.co': ['Nequi', 'Banca'],
  'bancolombia.com': ['Bancolombia', 'Banca'],
};

function clasificarDominio(dominio) {
  if (!dominio) return { nombre: 'Desconocido', categoria: 'Sin identificar' };
  if (SERVICIOS[dominio]) return { nombre: SERVICIOS[dominio][0], categoria: SERVICIOS[dominio][1] };
  // buscar por sufijo
  for (const k of Object.keys(SERVICIOS)) {
    if (dominio === k || dominio.endsWith('.' + k)) {
      return { nombre: SERVICIOS[k][0], categoria: SERVICIOS[k][1] };
    }
  }
  return { nombre: dominio, categoria: 'Sitio web' };
}

// Rangos IP muy conocidos para cuando el DNS inverso no responde
function clasificarPorIP(ip) {
  if (!ip) return null;
  if (/^13\.107\./.test(ip) || /^20\./.test(ip) || /^40\./.test(ip) || /^52\./.test(ip)) return 'microsoft.com';
  if (/^142\.250\./.test(ip) || /^172\.217\./.test(ip) || /^216\.58\./.test(ip) || /^34\.120\./.test(ip)) return 'google.com';
  if (/^104\.1[6-9]\./.test(ip) || /^104\.2[0-7]\./.test(ip) || /^172\.6[4-9]\./.test(ip) || /^172\.7[01]\./.test(ip)) return 'cloudflare.com';
  if (/^157\.240\./.test(ip) || /^31\.13\./.test(ip) || /^179\.60\./.test(ip)) return 'facebook.com';
  if (/^17\./.test(ip)) return 'apple.com';
  return null;
}

// ---------------------------------------------------------------------------
// Enriquecimiento geo-IP por lotes (organización real de cada IP)
// ip-api.com: gratis, hasta 100 IP por petición, ~15 req/min. Sin API key.
// ---------------------------------------------------------------------------
const http = require('http');
const ipInfoCache = new Map(); // ip -> {org, isp, pais, ciudad, as, ts}
const IPINFO_TTL = 30 * 60 * 1000;

function ipApiBatch(ips) {
  return new Promise((resolve) => {
    if (!ips.length) return resolve({});
    const body = JSON.stringify(ips.slice(0, 100).map((q) => ({ query: q })));
    const req = http.request(
      { host: 'ip-api.com', path: '/batch?fields=query,org,isp,as,country,city,status', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 6000 },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          const out = {};
          try {
            for (const x of JSON.parse(d)) {
              out[x.query] = { org: x.org || x.isp || '', isp: x.isp || '', pais: x.country || '', ciudad: x.city || '', as: x.as || '' };
            }
          } catch {}
          resolve(out);
        });
      }
    );
    req.on('error', () => resolve({}));
    req.on('timeout', () => { req.destroy(); resolve({}); });
    req.write(body);
    req.end();
  });
}

async function enriquecerIPs(ips) {
  const faltan = ips.filter((ip) => {
    const c = ipInfoCache.get(ip);
    return !c || Date.now() - c.ts > IPINFO_TTL;
  });
  if (faltan.length) {
    const res = await ipApiBatch(faltan);
    for (const ip of faltan) {
      ipInfoCache.set(ip, { ...(res[ip] || { org: '', isp: '', pais: '', ciudad: '', as: '' }), ts: Date.now() });
    }
  }
  const out = {};
  for (const ip of ips) out[ip] = ipInfoCache.get(ip) || null;
  return out;
}

// Deriva un nombre de servicio a partir de la organización geo-IP
function servicioDesdeOrg(org) {
  if (!org) return null;
  const o = org.toLowerCase();
  const mapa = [
    ['google', ['Google', 'Servicios Google']], ['cloudflare', ['Cloudflare', 'CDN / Infraestructura']],
    ['fastly', ['Fastly', 'CDN']], ['amazon', ['Amazon AWS', 'Nube']], ['microsoft', ['Microsoft', 'Servicios']],
    ['akamai', ['Akamai', 'CDN']], ['anthropic', ['Anthropic / Claude', 'IA']], ['openai', ['OpenAI', 'IA']],
    ['meta', ['Meta / Facebook', 'Redes sociales']], ['facebook', ['Meta / Facebook', 'Redes sociales']],
    ['apple', ['Apple', 'Servicios']], ['netflix', ['Netflix', 'Streaming']], ['spotify', ['Spotify', 'Música']],
    ['tiktok', ['TikTok', 'Streaming']], ['bytedance', ['TikTok', 'Streaming']], ['discord', ['Discord', 'Mensajería']],
    ['github', ['GitHub', 'Desarrollo']], ['digitalocean', ['DigitalOcean', 'Nube']], ['hetzner', ['Hetzner', 'Nube']],
    ['oracle', ['Oracle Cloud', 'Nube']], ['valve', ['Steam', 'Juegos']],
  ];
  for (const [k, v] of mapa) if (o.includes(k)) return v;
  return null;
}

// ---------------------------------------------------------------------------
// DNS inverso con caché y timeout
// ---------------------------------------------------------------------------
const rdnsCache = new Map(); // ip -> {host, ts}
const RDNS_TTL = 10 * 60 * 1000;
function rdns(ip) {
  const c = rdnsCache.get(ip);
  if (c && Date.now() - c.ts < RDNS_TTL) return Promise.resolve(c.host);
  return Promise.race([
    dnsp.reverse(ip).then((a) => (a && a[0]) || null).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), 1200)),
  ]).then((host) => {
    rdnsCache.set(ip, { host, ts: Date.now() });
    return host;
  });
}

// ---------------------------------------------------------------------------
// 1) Inteligencia de conexiones: qué app habla con qué servicio
// ---------------------------------------------------------------------------
async function conexiones() {
  const cmd =
    "$p=@{}; Get-Process -EA SilentlyContinue | ForEach-Object { $p[[int]$_.Id]=$_.ProcessName }; " +
    "$c=Get-NetTCPConnection -State Established -EA SilentlyContinue | " +
    "Where-Object { $_.RemoteAddress -notmatch '^(127\\.|::1$|0\\.0\\.0\\.0|::$|fe80|169\\.254|224\\.)' -and $_.RemoteAddress -ne $_.LocalAddress } | " +
    "ForEach-Object { [pscustomobject]@{ ip=$_.RemoteAddress; puerto=[int]$_.RemotePort; lpuerto=[int]$_.LocalPort; pid=[int]$_.OwningProcess; proc=$p[[int]$_.OwningProcess] } }; " +
    "if($c){ ConvertTo-Json -Compress -InputObject @($c) } else { '[]' }";
  let arr = jsonSafe(await ps(cmd), []);
  if (!Array.isArray(arr)) arr = [arr];

  // resolver DNS inverso + geo-IP (organización) de las IP únicas
  const ips = [...new Set(arr.map((x) => x.ip))];
  const hosts = {};
  const [, info] = await Promise.all([
    Promise.all(ips.map(async (ip) => { hosts[ip] = await rdns(ip); })),
    enriquecerIPs(ips),
  ]);

  // armar por conexión
  const conns = arr.map((x) => {
    let host = hosts[x.ip];
    let dominio = host ? dominioRegistrable(host) : clasificarPorIP(x.ip);
    const geo = info[x.ip] || null;
    let cls = clasificarDominio(dominio);
    // si el dominio no dio un servicio claro, usar la organización geo-IP
    if ((cls.nombre === 'Desconocido' || cls.categoria === 'Sitio web' || !dominio) && geo && geo.org) {
      const s = servicioDesdeOrg(geo.org);
      cls = s ? { nombre: s[0], categoria: s[1] } : { nombre: geo.org, categoria: geo.isp && geo.isp !== geo.org ? geo.isp : 'Servidor remoto' };
    }
    return {
      ip: x.ip,
      puerto: x.puerto,
      proceso: x.proc || 'desconocido',
      pid: x.pid,
      host: host || null,
      dominio: dominio || (geo && geo.org ? cls.nombre : null),
      servicio: cls.nombre,
      categoria: cls.categoria,
      pais: geo ? geo.pais : null,
      org: geo ? geo.org : null,
      cifrado: x.puerto === 443 || x.puerto === 8443 || x.puerto === 993 || x.puerto === 995,
    };
  });

  // agrupar por dominio/servicio (para lista y muro visual)
  const porDominio = {};
  for (const c of conns) {
    const key = c.servicio && c.servicio !== 'Desconocido' ? c.servicio : (c.dominio || c.host || c.ip);
    if (!porDominio[key]) {
      // dominio para el favicon: el registrable si existe, si no null
      const favDom = c.dominio && c.dominio.includes('.') ? c.dominio : null;
      porDominio[key] = { clave: key, servicio: c.servicio, dominio: c.dominio, favDominio: favDom, categoria: c.categoria, pais: c.pais, hits: 0, procesos: new Set(), cifrado: c.cifrado, ip: c.ip };
    }
    porDominio[key].hits++;
    porDominio[key].procesos.add(c.proceso);
  }
  const dominios = Object.values(porDominio)
    .map((d) => ({ ...d, procesos: [...d.procesos] }))
    .sort((a, b) => b.hits - a.hits);

  // agrupar por aplicación
  const porApp = {};
  for (const c of conns) {
    if (!porApp[c.proceso]) porApp[c.proceso] = { proceso: c.proceso, conexiones: 0, dominios: new Set() };
    porApp[c.proceso].conexiones++;
    if (c.dominio || c.host) porApp[c.proceso].dominios.add(c.dominio || c.host);
  }
  const apps = Object.values(porApp)
    .map((a) => ({ proceso: a.proceso, conexiones: a.conexiones, dominios: [...a.dominios] }))
    .sort((a, b) => b.conexiones - a.conexiones);

  return { ts: Date.now(), total: conns.length, apps, dominios, conexiones: conns };
}

// ---------------------------------------------------------------------------
// 2) Throughput real por adaptador (bytes/seg)
// ---------------------------------------------------------------------------
let _lastNet = {};
async function throughput() {
  const cmd =
    "$a=Get-NetAdapter -EA SilentlyContinue | Where-Object Status -eq 'Up'; " +
    "$o=foreach($x in $a){ $s=Get-NetAdapterStatistics -Name $x.Name -EA SilentlyContinue; " +
    "[pscustomobject]@{ nombre=$x.Name; desc=$x.InterfaceDescription; rx=[int64]$s.ReceivedBytes; tx=[int64]$s.SentBytes; vel=$x.LinkSpeed } }; " +
    "if($o){ ConvertTo-Json -Compress -InputObject @($o) } else { '[]' }";
  let arr = jsonSafe(await ps(cmd), []);
  if (!Array.isArray(arr)) arr = [arr];
  const now = Date.now();
  const salida = arr
    .filter((x) => !/Loopback|Bluetooth/i.test(x.nombre + x.desc))
    .map((x) => {
      const prev = _lastNet[x.nombre];
      let rxbps = 0, txbps = 0;
      if (prev) {
        const dt = (now - prev.ts) / 1000;
        if (dt > 0) {
          rxbps = Math.max(0, (x.rx - prev.rx) / dt);
          txbps = Math.max(0, (x.tx - prev.tx) / dt);
        }
      }
      _lastNet[x.nombre] = { rx: x.rx, tx: x.tx, ts: now };
      return {
        nombre: x.nombre,
        desc: x.desc,
        vel: x.vel,
        rxBytesSeg: Math.round(rxbps),
        txBytesSeg: Math.round(txbps),
        rxMbps: Math.round((rxbps * 8) / 1e5) / 10,
        txMbps: Math.round((txbps * 8) / 1e5) / 10,
        rxTotal: x.rx,
        txTotal: x.tx,
      };
    });
  return { ts: now, adaptadores: salida };
}

// ---------------------------------------------------------------------------
// 3) Redes WiFi cercanas (requiere Ubicación activada)
// ---------------------------------------------------------------------------
async function redesCercanas() {
  const out = await ps("netsh wlan show networks mode=bssid", 15000);
  if (/ubicaci|location|denegado|denied/i.test(out) || !out.trim()) {
    return { ok: false, motivo: 'Windows exige activar Ubicación (Configuración → Privacidad → Ubicación) para listar redes WiFi.', redes: [] };
  }
  const redes = [];
  const bloques = out.split(/\r?\n\r?\n(?=SSID \d+)/);
  for (const b of out.split(/SSID \d+ :/).slice(1)) {
    const ssid = (b.split(/\r?\n/)[0] || '').trim();
    const auth = (b.match(/Autenticaci[óo]n\s*:\s*(.+)/i) || [])[1];
    const cifr = (b.match(/Cifrado\s*:\s*(.+)/i) || [])[1];
    const bssids = [...b.matchAll(/BSSID \d+\s*:\s*([0-9a-f:]+)[\s\S]*?Se[ñn]al\s*:\s*(\d+)%[\s\S]*?Canal\s*:\s*(\d+)/gi)];
    if (bssids.length === 0) {
      redes.push({ ssid: ssid || '(oculta)', seguridad: (auth || 'N/A').trim(), cifrado: (cifr || '').trim(), senal: null, canal: null });
    }
    for (const m of bssids) {
      redes.push({
        ssid: ssid || '(oculta)',
        bssid: m[1],
        senal: parseInt(m[2], 10),
        canal: parseInt(m[3], 10),
        banda: parseInt(m[3], 10) > 14 ? '5 GHz' : '2.4 GHz',
        seguridad: (auth || 'N/A').trim(),
        cifrado: (cifr || '').trim(),
      });
    }
  }
  redes.sort((a, b) => (b.senal || 0) - (a.senal || 0));
  return { ok: true, total: redes.length, redes };
}

// ---------------------------------------------------------------------------
// 4) Caché DNS (dominios resueltos sin cifrar)
// ---------------------------------------------------------------------------
async function dnsCache() {
  const cmd =
    "$c=Get-DnsClientCache -EA SilentlyContinue | Where-Object { $_.Type -eq 'A' -or $_.Type -eq 'AAAA' } | " +
    "Where-Object { $_.Entry -notmatch '\\.(local|arpa|home|lan)$' } | " +
    "Select-Object -Unique Entry; if($c){ ConvertTo-Json -Compress -InputObject @($c.Entry) } else { '[]' }";
  let arr = jsonSafe(await ps(cmd), []);
  if (!Array.isArray(arr)) arr = arr ? [arr] : [];
  const dominios = [...new Set(arr.map((e) => dominioRegistrable(e)).filter(Boolean))];
  return {
    ts: Date.now(),
    entradas: arr,
    dominios: dominios.map((d) => ({ dominio: d, ...clasificarDominio(d) })),
    nota: arr.length === 0 ? 'Caché vacío: tu navegador probablemente usa DNS cifrado (DoH). Los dominios se ven mejor en la pestaña Conexiones.' : null,
  };
}

// ---------------------------------------------------------------------------
// 5) Captura profunda con pktmon (mejor con administrador)
//    Captura N segundos filtrando DNS(53) y devuelve nombres legibles.
// ---------------------------------------------------------------------------
async function capturaProfunda(segundos = 6) {
  segundos = Math.min(20, Math.max(3, parseInt(segundos, 10) || 6));
  const dir = path.join(os.tmpdir(), 'netpulse_cap');
  const etl = path.join(dir, 'np.etl');
  const txt = path.join(dir, 'np.txt');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const script =
    `New-Item -ItemType Directory -Force '${dir}' | Out-Null; ` +
    `pktmon stop *> $null; pktmon filter remove *> $null; ` +
    `pktmon filter add -p 53 *> $null; ` +
    `$r = pktmon start --capture --pkt-size 500 -f '${etl}' 2>&1; ` +
    `if($LASTEXITCODE -ne 0){ Write-Output ('ADMIN_REQUERIDO:'+$r); return }; ` +
    `Start-Sleep -Seconds ${segundos}; pktmon stop *> $null; ` +
    `pktmon etl2txt '${etl}' -o '${txt}' *> $null; Write-Output 'OK'`;
  const res = await ps(script, (segundos + 20) * 1000);
  if (/ADMIN_REQUERIDO/.test(res)) {
    return { ok: false, admin: true, motivo: 'pktmon necesita ejecutarse como administrador. Cierra NetPulse y ábrelo con "iniciar-admin.bat".' };
  }
  let contenido = '';
  try { contenido = fs.readFileSync(txt, 'latin1'); } catch { contenido = ''; }
  // Extraer nombres de dominio legibles de las consultas DNS
  const nombres = new Set();
  for (const m of contenido.matchAll(/\b([a-z0-9][a-z0-9\-]{0,40}(?:\.[a-z0-9\-]{1,40}){1,4})\.(com|org|net|es|co|io|dev|gov|edu|tv|info|app|xyz|cloud|me)\b/gi)) {
    nombres.add((m[1] + '.' + m[2]).toLowerCase());
  }
  const dominios = [...nombres].map((d) => dominioRegistrable(d));
  const unicos = [...new Set(dominios)].map((d) => ({ dominio: d, ...clasificarDominio(d) }));
  return {
    ok: true,
    segundos,
    capturados: nombres.size,
    dominios: unicos,
    nota: nombres.size === 0 ? 'No se vieron consultas DNS en claro (tu equipo usa DNS cifrado). La captura funcionó, pero el tráfico de nombres va cifrado.' : null,
  };
}

// ---------------------------------------------------------------------------
// 6) Auditoría de red: qué le falta / qué está débil
// ---------------------------------------------------------------------------
function auditoria(datos, dispositivos) {
  const h = [];
  const add = (nivel, titulo, detalle) => h.push({ nivel, titulo, detalle });
  const red = (datos && datos.red) || {};
  const ip = (datos && datos.ip) || {};

  // Seguridad WiFi
  if (/abierta|open|WEP/i.test(red.seguridad || red.autenticacion || '')) {
    add('alto', 'Red WiFi insegura', 'Tu red usa cifrado débil o está abierta. Cambia a WPA2/WPA3 en el router.');
  }
  // Dispositivos sin identificar
  const sinId = (dispositivos || []).filter((d) => !d.fabricante || d.fabricante === 'Desconocido' || d.tipo === 'Desconocido');
  if (sinId.length > 0) {
    add('medio', `${sinId.length} dispositivo(s) sin identificar`, 'Hay equipos en tu red cuyo fabricante o tipo no se pudo determinar. Revísalos: podrían ser intrusos o dispositivos IoT sin actualizar.');
  }
  // Cantidad de dispositivos
  const n = (dispositivos || []).length;
  if (n > 15) add('info', `Red concurrida (${n} equipos)`, 'Muchos dispositivos conectados pueden saturar el canal WiFi. Considera separar 2.4 y 5 GHz.');

  // MAC aleatoria / IPs 169.254 (sin DHCP)
  const apipa = (dispositivos || []).filter((d) => (d.ip || '').startsWith('169.254'));
  if (apipa.length > 0) add('medio', 'Equipos sin IP válida (APIPA)', `${apipa.length} equipo(s) con dirección 169.254.x.x: no obtuvieron IP del router (DHCP). Pueden ser dispositivos con problemas de conexión.`);

  // DNS cifrado (bueno) o no
  add('info', 'Sugerencia: DNS cifrado', 'Activar DNS-over-HTTPS (DoH) en el router/navegador impide que terceros vean qué dominios visitas.');

  // Puertos abiertos en el gateway
  const gw = (dispositivos || []).find((d) => d.ip === ip.gateway);
  if (gw && gw.puertos && gw.puertos.length) {
    const criticos = gw.puertos.filter((p) => [23, 21, 80, 8080].includes(p.puerto || p));
    if (criticos.length) add('alto', 'Router con puertos de gestión abiertos', `El router expone ${criticos.map((p) => p.puerto || p).join(', ')}. Telnet(23)/HTTP(80) sin cifrar son riesgosos. Usa HTTPS y desactiva administración remota.`);
  }

  // Cobertura de agentes/telemetría (qué módulos faltan)
  const agentes = [
    { nombre: 'Escaneo de dispositivos', activo: n > 0 },
    { nombre: 'Inteligencia de conexiones', activo: true },
    { nombre: 'Throughput en vivo', activo: true },
    { nombre: 'Muro visual de tráfico', activo: true },
    { nombre: 'Redes WiFi cercanas', activo: null, nota: 'Requiere Ubicación activada' },
    { nombre: 'Captura profunda pktmon', activo: null, nota: 'Mejor con administrador' },
    { nombre: 'Segundo adaptador (TP-Link) como sensor', activo: null, nota: 'Conéctalo para escaneo doble' },
  ];

  return { ts: Date.now(), hallazgos: h, agentes };
}

// ---------------------------------------------------------------------------
// Persistencia de historial de telemetría
// ---------------------------------------------------------------------------
function cargarHist() {
  try { return JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')); } catch { return { throughput: [], dominios: {} }; }
}
function guardarHist(h) {
  try { fs.writeFileSync(HIST_FILE, JSON.stringify(h)); } catch {}
}
function registrarHistorial(tp, conns) {
  const h = cargarHist();
  const totalRx = (tp.adaptadores || []).reduce((s, a) => s + a.rxBytesSeg, 0);
  const totalTx = (tp.adaptadores || []).reduce((s, a) => s + a.txBytesSeg, 0);
  h.throughput.push({ ts: Date.now(), rx: totalRx, tx: totalTx });
  if (h.throughput.length > 600) h.throughput = h.throughput.slice(-600);
  for (const d of (conns.dominios || []).slice(0, 30)) {
    h.dominios[d.dominio] = (h.dominios[d.dominio] || 0) + d.hits;
  }
  guardarHist(h);
  return h;
}

module.exports = {
  conexiones,
  throughput,
  redesCercanas,
  dnsCache,
  capturaProfunda,
  auditoria,
  cargarHist,
  registrarHistorial,
  clasificarDominio,
  dominioRegistrable,
};
