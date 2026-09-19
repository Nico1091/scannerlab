const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const dgram = require('dgram');
const net = require('net');
const fs = require('fs');
const path = require('path');

function run(cmd, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { encoding: 'utf-8', timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout);
    });
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(result => { clearTimeout(timer); resolve(result); }).catch(() => { clearTimeout(timer); resolve(null); });
  });
}

function getHTTPName(ip, useHttps = false) {
  return new Promise((resolve) => {
    const proto = useHttps ? require('https') : http;
    const req = proto.get(`${useHttps ? 'https' : 'http'}://${ip}/`, { timeout: 3000, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 50000) { req.destroy(); resolve(null); } });
      res.on('end', () => {
        const m = data.match(/<title>(.+?)<\/title>/is);
        if (!m) return resolve(null);
        let raw = m[1];
        let title = raw.split(/\r?\n/).join(' ').split(/\r/).join(' ').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
        // Filtrar titulos claramente genericos/inutiles
        if (/^\d{3}\s|index of|not found|404|403|error/i.test(title)) return resolve(null);
        if (title.length > 80 || title.length < 2) return resolve(null);
        resolve(title);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.setTimeout(3000);
  });
}

async function getLLMNR(ip) {
  try {
    const out = await run(`powershell -NoProfile -Command "try { (Resolve-DnsName -Name '${ip}' -LlmnrOnly -ErrorAction Stop).NameHost } catch { '' }"`, 4000);
    const name = out.trim();
    return name || null;
  } catch (_) { return null; }
}

async function getNetBIOS(ip) {
  try {
    const out = await run(`nbtstat -A ${ip}`, 4000);
    const m = out.match(/(\S+)\s+<00>\s+UNICO/i);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

async function getDNS(ip) {
  try {
    const out = await run(`powershell -NoProfile -Command "try { (Resolve-DnsName '${ip}' -ErrorAction Stop).NameHost } catch { '' }"`, 4000);
    const name = out.trim();
    return name || null;
  } catch (_) { return null; }
}

async function getSNMPName(ip) {
  try {
    const out = await run(`powershell -NoProfile -Command "try { snmpget -v2c -c public ${ip} .1.3.6.1.2.1.1.5.0 2>\$null } catch { '' }"`, 4000);
    const m = out.match(/STRING:\s*"?(.+?)"?\s*$/i);
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
}

function extract(output, regex) {
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(regex);
    if (m) return m[1].trim();
  }
  return null;
}

async function obtenerDatos() {
  // Windows 11 exige permiso de ubicacion para 'netsh wlan'. Si esta denegado,
  // seguimos adelante con los datos de IP y el resto del escaneo.
  const wifiOut = await run('netsh wlan show interfaces').catch(() => '');
  const perfilRed = wifiOut ? '' : await run('powershell -NoProfile -Command "(Get-NetConnectionProfile -InterfaceAlias Wi-Fi).Name"').catch(() => '');
  const macAdaptador = wifiOut ? '' : await run('powershell -NoProfile -Command "(Get-NetAdapter -Name Wi-Fi).MacAddress"').catch(() => '');

  const ssid        = extract(wifiOut, /SSID\s*:\s*(.+)/i);
  const bssid       = extract(wifiOut, /BSSID\s*:\s*(.+)/i);
  const radio       = extract(wifiOut, /Tipo de radio\s*:\s*(.+)/i);
  const channel     = extract(wifiOut, /Canal\s*:\s*(\d+)/i);
  const signal      = extract(wifiOut, /Señal\s*:\s*(.+)/i);
  const reception   = extract(wifiOut, /Velocidad de recepci[óo]n \(Mbps\)\s*:\s*(\d+)/i);
  const transmission= extract(wifiOut, /Velocidad de transmisi[óo]n \(Mbps\)\s*:\s*(\d+)/i);
  const state       = extract(wifiOut, /Estado\s*:\s*(.+)/i);
  const mac         = extract(wifiOut, /Direcci[óo]n f[ií]sica\s*:\s*(.+)/i);

  const ipv4 = (await run('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias Wi-Fi).IPAddress"')).trim();
  const mask = (await run('powershell -NoProfile -Command "(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias Wi-Fi).PrefixLength"')).trim();
  const gw   = (await run('powershell -NoProfile -Command "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 -InterfaceAlias Wi-Fi).NextHop"')).trim();
  const dns  = (await run('powershell -NoProfile -Command "(Get-DnsClientServerAddress -AddressFamily IPv4).ServerAddresses | Select-Object -Unique"')).trim().split(/\r?\n/).filter(x => x.trim());

  const isLocal = ipv4 && (
    ipv4.startsWith('192.168.') ||
    ipv4.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4)
  );

  return {
    fecha: new Date().toLocaleString('es-ES'),
    red: {
      nombre: ssid || perfilRed.trim() || 'Desconocida',
      bssid: bssid || 'N/A',
      tecnologia: radio || 'N/A',
      canal: channel || 'N/A',
      senial: signal || 'N/A',
      recepcion: reception ? `${reception} Mbps` : 'N/A',
      transmision: transmission ? `${transmission} Mbps` : 'N/A',
      estado: state || 'N/A',
      mac: mac || macAdaptador.trim().replace(/-/g, ':') || 'N/A',
    },
    ip: {
      direccion: ipv4 || 'N/A',
      mascara: mask || 'N/A',
      gateway: gw || 'N/A',
      dns: dns.length ? dns : ['Desconocido'],
      esRedLocal: isLocal ? 'Si' : 'No / Publica',
    }
  };
}

async function guardarTxt(reporte) {
  const txt = `Reporte de Red WiFi
Generado: ${reporte.fecha}
================================================

RED WiFi
------------------------------------------------
Nombre de red (SSID) : ${reporte.red.nombre}
BSSID               : ${reporte.red.bssid}
Tecnologia          : ${reporte.red.tecnologia}
Canal               : ${reporte.red.canal}
Senial              : ${reporte.red.senial}
Recepcion           : ${reporte.red.recepcion}
Transmision         : ${reporte.red.transmision}
Estado              : ${reporte.red.estado}
MAC interfaz        : ${reporte.red.mac}

CONFIGURACION IP
------------------------------------------------
Direccion IPv4      : ${reporte.ip.direccion}
Mascara de subred   : ${reporte.ip.mascara}
Gateway (puerta)    : ${reporte.ip.gateway}
Es red local?       : ${reporte.ip.esRedLocal}

================================================
`;
  fs.writeFileSync(path.join(__dirname, 'red_detectada.txt'), txt, 'utf-8');
}

// Si se ejecuta directamente
if (require.main === module) {
  (async () => {
    try {
      console.log('\n[WiFi Scan] Escaneando red...\n');
      const datos = await obtenerDatos();
      console.log('====================================');
      console.log('  RED WiFi DETECTADA');
      console.log('====================================');
      console.log(`  Nombre      : ${datos.red.nombre}`);
      console.log(`  Tecnologia  : ${datos.red.tecnologia}`);
      console.log(`  Canal       : ${datos.red.canal}`);
      console.log(`  Senial      : ${datos.red.senial}`);
      console.log(`  Estado      : ${datos.red.estado}`);
      console.log('------------------------------------');
      console.log('  CONFIGURACION IP');
      console.log('------------------------------------');
      console.log(`  IP Local    : ${datos.ip.direccion}`);
      console.log(`  Mascara     : ${datos.ip.mascara}`);
      console.log(`  Gateway     : ${datos.ip.gateway}`);
      console.log(`  Red Local   : ${datos.ip.esRedLocal}`);
      console.log('====================================\n');
      await guardarTxt(datos);
      console.log('[OK] Archivo guardado: red_detectada.txt');
    } catch (e) {
      console.error('[ERROR]', e);
      process.exit(1);
    }
  })();
}

const OUI_DB = {
  '00:1A:11': 'Apple', '00:1B:21': 'Apple', '00:1C:14': 'Apple', '00:1D:92': 'Apple',
  '00:1E:C2': 'Apple', '00:1F:3B': 'Apple', '00:21:5C': 'Apple', '00:22:41': 'Apple',
  '00:23:12': 'Apple', '00:24:36': 'Apple', '00:25:00': 'Apple', '00:26:B0': 'Apple',
  '00:50:56': 'VMware', '00:0C:29': 'VMware', '00:15:5D': 'Microsoft Hyper-V',
  '58:9B:F7': 'TP-Link', '50:D4:F7': 'TP-Link', 'C0:4A:00': 'TP-Link',
  'AC:DE:48': 'Apple', 'AC:88:FD': 'Apple', 'B0:BE:76': 'Apple',
  '18:34:AF': 'Samsung', '3C:5A:B4': 'Samsung', '6C:AD:94': 'Samsung',
  '84:11:9E': 'Samsung', 'A0:18:28': 'Samsung', 'BC:44:86': 'Samsung',
  '00:0C:E7': 'Samsung', '00:12:47': 'Samsung', '00:17:C9': 'Samsung',
  '00:1D:D4': 'Samsung', '00:21:19': 'Samsung', '00:24:54': 'Samsung',
  '00:26:5D': 'Samsung', '00:26:F2': 'Samsung', '00:37:6D': 'Samsung',
  '04:D6:AA': 'Samsung', '08:08:C2': 'Samsung', '08:D4:2C': 'Samsung',
  '0C:14:20': 'Samsung', '10:2F:6B': 'Samsung', '10:A5:D0': 'Samsung',
  '10:D5:4A': 'Samsung', '14:49:E0': 'Samsung', '14:9F:3C': 'Samsung',
  '14:A3:64': 'Samsung', '14:B9:73': 'Samsung', '18:3B:D4': 'Samsung',
  '18:74:E2': 'Samsung', '18:AF:61': 'Samsung', '1C:5A:6B': 'Samsung',
  '1C:62:B8': 'Samsung', '1C:AF:F9': 'Samsung', '1C:E1:92': 'Samsung',
  '20:13:E0': 'Samsung', '20:32:6C': 'Samsung', '20:36:76': 'Samsung',
  '20:47:ED': 'Samsung', '20:A6:0C': 'Samsung', '20:DA:22': 'Samsung',
  '24:09:16': 'Samsung', '24:4B:03': 'Samsung', '24:4C:E3': 'Samsung',
  '24:5E:BE': 'Samsung', '24:92:0E': 'Samsung', '24:A2:E1': 'Samsung',
  '24:DB:ED': 'Samsung', '28:25:E8': 'Samsung', '28:39:26': 'Samsung',
  '28:6C:07': 'Samsung', '28:6D:97': 'Samsung', '28:A2:82': 'Samsung',
  '28:BA:18': 'Samsung', '28:BC:18': 'Samsung', '28:CC:01': 'Samsung',
  '2C:32:7A': 'Samsung', '2C:44:01': 'Samsung', '2C:5A:DB': 'Samsung',
  '2C:8A:72': 'Samsung', '2C:B8:ED': 'Samsung', '30:12:FB': 'Samsung',
  '30:19:66': 'Samsung', '30:21:45': 'Samsung', '30:39:26': 'Samsung',
  '30:46:9A': 'Samsung', '30:57:14': 'Samsung', '30:59:26': 'Samsung',
  '30:78:19': 'Samsung', '30:96:6F': 'Samsung', '30:B4:9E': 'Samsung',
  '30:D5:DE': 'Samsung', '34:23:87': 'Samsung', '34:BE:EA': 'Samsung',
  '34:C7:31': 'Samsung', '34:FC:EF': 'Samsung', '38:01:97': 'Samsung',
  '38:16:D1': 'Samsung', '38:68:A4': 'Samsung', '38:78:62': 'Samsung',
  '38:80:DF': 'Samsung', '38:94:96': 'Samsung', '38:A4:ED': 'Samsung',
  '38:EC:0D': 'Samsung', '38:F2:3E': 'Samsung', '3C:5A:03': 'Samsung',
  '3C:5A:B4': 'Samsung', '3C:5C:5C': 'Samsung', '3C:6A:A7': 'Samsung',
  '3C:8B:FE': 'Samsung', '3C:99:F7': 'Samsung', '3C:AB:8E': 'Samsung',
  '3C:D9:2B': 'Samsung', '3C:F7:A4': 'Samsung', '40:0E:85': 'Samsung',
  '44:F4:59': 'Samsung', '48:24:57': 'Samsung', '48:27:EA': 'Samsung',
  '48:5A:B6': 'Samsung', '48:5B:39': 'Samsung', '48:6E:EF': 'Samsung',
  '48:88:CA': 'Samsung', '48:A4:72': 'Samsung', '4C:0F:6E': 'Samsung',
  '4C:66:41': 'Samsung', '4C:79:6E': 'Samsung', '4C:86:1B': 'Samsung',
  '4C:A0:27': 'Samsung', '50:01:BB': 'Samsung', '50:1D:93': 'Samsung',
  '50:32:75': 'Samsung', '50:3E:AA': 'Samsung', '50:84:9C': 'Samsung',
  '50:99:CA': 'Samsung', '50:C8:E5': 'Samsung', '50:EC:50': 'Samsung',
  '54:42:49': 'Samsung', '54:60:09': 'Samsung', '54:88:0E': 'Samsung',
  '54:9B:12': 'Samsung', '54:A9:D4': 'Samsung', '58:93:96': 'Samsung',
  '58:A2:B5': 'Samsung', '58:C3:8B': 'Samsung', '58:CB:52': 'Samsung',
  '58:D9:C3': 'Samsung', '5C:0A:5B': 'Samsung', '5C:17:D3': 'Samsung',
  '5C:23:8E': 'Samsung', '5C:3C:27': 'Samsung', '5C:5E:AB': 'Samsung',
  '5C:A8:6A': 'Samsung', '5C:AF:06': 'Samsung', '5C:E8:EB': 'Samsung',
  '5C:E2:8C': 'Samsung', '60:5F:F5': 'Samsung', '60:83:73': 'Samsung',
  '60:8D:17': 'Samsung', '60:A4:4C': 'Samsung', '60:AF:6D': 'Samsung',
  '60:AF:DA': 'Samsung', '60:D0:2C': 'Samsung', '60:E3:27': 'Samsung',
  '60:E3:AC': 'Samsung', '60:E7:01': 'Samsung', '64:1C:AE': 'Samsung',
  '64:1C:B0': 'Samsung', '64:B5:C6': 'Samsung', '64:CB:E9': 'Samsung',
  '64:D1:54': 'Samsung', '68:48:98': 'Samsung', '68:5B:36': 'Samsung',
  '68:9A:87': 'Samsung', '68:9C:70': 'Samsung', '68:B6:FC': 'Samsung',
  '6C:83:36': 'Samsung', '6C:AD:94': 'Samsung', '70:2C:1F': 'Samsung',
  '70:3A:0E': 'Samsung', '70:3C:69': 'Samsung', '70:D5:E7': 'Samsung',
  '70:F9:27': 'Samsung', '74:5E:1C': 'Samsung', '74:EB:80': 'Samsung',
  '78:1C:5A': 'Samsung', '78:47:1D': 'Samsung', '78:5E:E8': 'Samsung',
  '78:A6:C2': 'Samsung', '78:AB:BB': 'Samsung', '78:F7:D0': 'Samsung',
  '7C:0B:C6': 'Samsung', '7C:46:85': 'Samsung', '7C:61:66': 'Samsung',
  '7C:AB:A1': 'Samsung', '80:18:44': 'Samsung', '80:38:FD': 'Samsung',
  '80:5E:4F': 'Samsung', '80:6F:9D': 'Samsung', '84:11:9E': 'Samsung',
  '84:25:19': 'Samsung', '84:55:A5': 'Samsung', '84:5E:40': 'Samsung',
  '84:73:03': 'Samsung', '84:7A:88': 'Samsung', '84:90:3C': 'Samsung',
  '84:A4:66': 'Samsung', '84:A6:C8': 'Samsung', '84:B5:41': 'Samsung',
  '84:BA:20': 'Samsung', '84:BD:41': 'Samsung', '84:BE:52': 'Samsung',
  '84:C7:25': 'Samsung', '84:CF:53': 'Samsung', '84:D6:D0': 'Samsung',
  '84:DB:2F': 'Samsung', '84:E4:82': 'Samsung', '88:28:B8': 'Samsung',
  '88:3A:30': 'Samsung', '88:5A:BA': 'Samsung', '88:71:E5': 'Samsung',
  '88:9B:39': 'Samsung', '88:A5:BD': 'Samsung', '88:AD:D2': 'Samsung',
  '88:C9:E8': 'Samsung', '88:CE:03': 'Samsung', '8C:1A:BF': 'Samsung',
  '8C:73:6E': 'Samsung', '8C:8F:C4': 'Samsung', '8C:9F:3B': 'Samsung',
  '90:18:7C': 'Samsung', '90:63:3B': 'Samsung', '90:B6:86': 'Samsung',
  '90:BA:E4': 'Samsung', '90:CC:DF': 'Samsung', '90:E7:C4': 'Samsung',
  '94:11:DA': 'Samsung', '94:27:90': 'Samsung', '94:2A:3F': 'Samsung',
  '94:35:0A': 'Samsung', '94:63:D1': 'Samsung', '94:7B:6F': 'Samsung',
  '94:8B:C1': 'Samsung', '94:B8:6D': 'Samsung', '94:BF:2D': 'Samsung',
  '94:D0:0D': 'Samsung', '98:1D:FA': 'Samsung', '98:83:89': 'Samsung',
  '98:A5:3D': 'Samsung', '98:B8:BA': 'Samsung', '98:D3:31': 'Samsung',
  '9C:14:63': 'Samsung', '9C:20:EF': 'Samsung', '9C:4E:36': 'Samsung',
  '9C:5C:F9': 'Samsung', '9C:64:8B': 'Samsung', '9C:6E:71': 'Samsung',
  '9C:99:CD': 'Samsung', '9C:F6:DD': 'Samsung', 'A0:02:DC': 'Samsung',
  'A0:18:28': 'Samsung', 'A0:40:1E': 'Samsung', 'A0:4E:75': 'Samsung',
  'A0:6F:DF': 'Samsung', 'A0:82:1F': 'Samsung', 'A0:88:69': 'Samsung',
  'A0:91:69': 'Samsung', 'A0:99:9B': 'Samsung', 'A0:B4:A5': 'Samsung',
  'A0:B7:45': 'Samsung', 'A0:B8:6F': 'Samsung', 'A0:BB:3E': 'Samsung',
  'A0:CB:FD': 'Samsung', 'A0:CE:C8': 'Samsung', 'A0:D0:76': 'Samsung',
  'A0:DB:25': 'Samsung', 'A0:E4:53': 'Samsung', 'A4:67:06': 'Samsung',
  'A4:8C:39': 'Samsung', 'A4:9A:58': 'Samsung', 'A4:C4:61': 'Samsung',
  'A4:E0:6A': 'Samsung', 'A8:06:00': 'Samsung', 'A8:16:D0': 'Samsung',
  'A8:1E:84': 'Samsung', 'A8:51:AB': 'Samsung', 'A8:5C:2C': 'Samsung',
  'A8:5E:E4': 'Samsung', 'A8:6D:92': 'Samsung', 'A8:9F:BA': 'Samsung',
  'A8:A6:48': 'Samsung', 'A8:B5:7C': 'Samsung', 'A8:D0:E5': 'Samsung',
  'AC:5F:3E': 'Samsung', 'AC:6F:BB': 'Samsung', 'AC:DE:48': 'Samsung',
  'AC:E2:15': 'Samsung', 'B0:10:A0': 'Samsung', 'B0:1F:8B': 'Samsung',
  'B0:47:8F': 'Samsung', 'B0:55:08': 'Samsung', 'B0:68:35': 'Samsung',
  'B0:72:BF': 'Samsung', 'B0:79:94': 'Samsung', 'B0:7D:64': 'Samsung',
  'B0:89:91': 'Samsung', 'B0:8B:CF': 'Samsung', 'B0:98:2B': 'Samsung',
  'B0:9F:DA': 'Samsung', 'B0:C5:54': 'Samsung', 'B0:DF:3A': 'Samsung',
  'B0:E7:54': 'Samsung', 'B4:07:F9': 'Samsung', 'B4:0E:DC': 'Samsung',
  'B4:1D:AF': 'Samsung', 'B4:62:AD': 'Samsung', 'B4:79:C7': 'Samsung',
  'B4:7C:9C': 'Samsung', 'B4:7F:A9': 'Samsung', 'B4:86:56': 'Samsung',
  'B4:A5:EF': 'Samsung', 'B4:B6:FC': 'Samsung', 'B4:CD:27': 'Samsung',
  'B4:E1:C4': 'Samsung', 'B8:11:FC': 'Samsung', 'B8:1D:AA': 'Samsung',
  'B8:57:9E': 'Samsung', 'B8:82:CF': 'Samsung', 'B8:94:E5': 'Samsung',
  'B8:9B:CB': 'Samsung', 'B8:A3:8F': 'Samsung', 'B8:B4:2E': 'Samsung',
  'B8:BA:72': 'Samsung', 'B8:C6:8E': 'Samsung', 'B8:D5:E7': 'Samsung',
  'B8:E8:56': 'Samsung', 'B8:F4:30': 'Samsung', 'BC:20:A4': 'Samsung',
  'BC:44:86': 'Samsung', 'BC:47:60': 'Samsung', 'BC:5E:33': 'Samsung',
  'BC:72:B1': 'Samsung', 'BC:79:AD': 'Samsung', 'BC:81:71': 'Samsung',
  'BC:8A:E8': 'Samsung', 'BC:98:DB': 'Samsung', 'BC:9F:EF': 'Samsung',
  'BC:A4:E1': 'Samsung', 'BC:C3:C4': 'Samsung', 'BC:D1:D3': 'Samsung',
  'BC:F2:92': 'Samsung', 'C0:11:73': 'Samsung', 'C0:1A:DA': 'Samsung',
  'C0:48:E6': 'Samsung', 'C0:97:C3': 'Samsung', 'C0:9F:05': 'Samsung',
  'C0:BD:C8': 'Samsung', 'C0:D9:48': 'Samsung', 'C4:3A:BE': 'Samsung',
  'C4:42:68': 'Samsung', 'C4:57:6E': 'Samsung', 'C4:73:1E': 'Samsung',
  'C4:88:E5': 'Samsung', 'C4:9A:02': 'Samsung', 'C4:A5:59': 'Samsung',
  'C4:D7:6E': 'Samsung', 'C4:E9:84': 'Samsung', 'C4:EE:V5': 'Samsung',
  'C8:14:51': 'Samsung', 'C8:19:F7': 'Samsung', 'C8:1E:E7': 'Samsung',
  'C8:38:70': 'Samsung', 'C8:45:44': 'Samsung', 'C8:5B:76': 'Samsung',
  'C8:97:9C': 'Samsung', 'C8:9E:43': 'Samsung', 'C8:A8:98': 'Samsung',
  'C8:B1:52': 'Samsung', 'C8:BB:BE': 'Samsung', 'C8:C0:1B': 'Samsung',
  'C8:C4:22': 'Samsung', 'C8:CB:E5': 'Samsung', 'C8:CD:C8': 'Samsung',
  'C8:D1:0B': 'Samsung', 'C8:D7:B0': 'Samsung', 'C8:E0:EB': 'Samsung',
  'C8:F2:30': 'Samsung', 'C8:F5:0B': 'Samsung', 'CC:07:AB': 'Samsung',
  'CC:3A:61': 'Samsung', 'CC:3D:82': 'Samsung', 'CC:42:51': 'Samsung',
  'CC:44:63': 'Samsung', 'CC:4B:29': 'Samsung', 'CC:6D:A0': 'Samsung',
  'CC:77:F1': 'Samsung', 'CC:96:A0': 'Samsung', 'CC:9C:3C': 'Samsung',
  'CC:A2:23': 'Samsung', 'CC:B0:DA': 'Samsung', 'CC:FA:00': 'Samsung',
  'D0:22:BE': 'Samsung', 'D0:31:10': 'Samsung', 'D0:4A:CD': 'Samsung',
  'D0:56:BF': 'Samsung', 'D0:66:7B': 'Samsung', 'D0:87:E2': 'Samsung',
  'D0:C1:89': 'Samsung', 'D0:E4:CB': 'Samsung', 'D4:20:6D': 'Samsung',
  'D4:38:9C': 'Samsung', 'D4:61:37': 'Samsung', 'D4:6B:A6': 'Samsung',
  'D4:6E:5C': 'Samsung', 'D4:87:88': 'Samsung', 'D4:8F:AA': 'Samsung',
  'D4:94:E8': 'Samsung', 'D4:A9:28': 'Samsung', 'D4:AF:F1': 'Samsung',
  'D4:CB:DB': 'Samsung', 'D4:D1:71': 'Samsung', 'D4:E8:B2': 'Samsung',
  'D4:F0:57': 'Samsung', 'D8:6C:63': 'Samsung', 'D8:90:E8': 'Samsung',
  'D8:A2:5E': 'Samsung', 'D8:E3:47': 'Samsung', 'D8:F7:10': 'Samsung',
  'DC:09:16': 'Samsung', 'DC:0B:34': 'Samsung', 'DC:16:B2': 'Samsung',
  'DC:44:27': 'Samsung', 'DC:71:44': 'Samsung', 'DC:90:88': 'Samsung',
  'E0:3C:5D': 'Samsung', 'E0:5A:9F': 'Samsung', 'E0:63:E5': 'Samsung',
  'E0:89:7E': 'Samsung', 'E0:99:71': 'Samsung', 'E0:CB:1D': 'Samsung',
  'E0:D7:BA': 'Samsung', 'E4:3E:89': 'Samsung', 'E4:7C:F9': 'Samsung',
  'E4:7E:66': 'Samsung', 'E4:98:D1': 'Samsung', 'E4:B9:7A': 'Samsung',
  'E4:FA:ED': 'Samsung', 'E8:03:9A': 'Samsung', 'E8:08:8B': 'Samsung',
  'E8:11:32': 'Samsung', 'E8:1A:2B': 'Samsung', 'E8:50:8B': 'Samsung',
  'E8:92:A4': 'Samsung', 'E8:99:C4': 'Samsung', 'E8:B4:C8': 'Samsung',
  'E8:E5:D6': 'Samsung', 'EC:01:EE': 'Samsung', 'EC:0E:5C': 'Samsung',
  'EC:1F:72': 'Samsung', 'EC:5A:86': 'Samsung', 'EC:98:C1': 'Samsung',
  'EC:B5:09': 'Samsung', 'F0:27:65': 'Samsung', 'F0:45:2F': 'Samsung',
  'F0:5A:09': 'Samsung', 'F0:72:8C': 'Samsung', 'F0:C7:07': 'Samsung',
  'F0:D7:AF': 'Samsung', 'F0:E7:78': 'Samsung', 'F0:EB:0D': 'Samsung',
  'F0:EE:10': 'Samsung', 'F0:F7:86': 'Samsung', 'F4:09:D8': 'Samsung',
  'F4:3E:61': 'Samsung', 'F4:42:8F': 'Samsung', 'F4:60:E2': 'Samsung',
  'F4:7B:5E': 'Samsung', 'F4:84:8D': 'Samsung', 'F4:8C:FC': 'Samsung',
  'F4:8E:92': 'Samsung', 'F4:9F:54': 'Samsung', 'F4:A3:76': 'Samsung',
  'F4:AF:78': 'Samsung', 'F4:B6:88': 'Samsung', 'F4:BE:EC': 'Samsung',
  'F4:CA:E5': 'Samsung', 'F4:D9:FB': 'Samsung', 'F4:E6:E2': 'Samsung',
  'F8:04:2E': 'Samsung', 'F8:1D:78': 'Samsung', 'F8:3F:51': 'Samsung',
  'F8:4A:BF': 'Samsung', 'F8:5A:2A': 'Samsung', 'F8:95:C7': 'Samsung',
  'F8:CF:C5': 'Samsung', 'F8:D0:BD': 'Samsung', 'F8:E6:1A': 'Samsung',
  'FC:19:10': 'Samsung', 'FC:1F:19': 'Samsung', 'FC:3F:F5': 'Samsung',
  'FC:8F:90': 'Samsung', 'FC:A4:7A': 'Samsung', 'FC:F1:36': 'Samsung',
  // Xiaomi / Redmi / Poco
  '50:EC:50': 'Xiaomi', '64:69:4E': 'Xiaomi', '74:23:44': 'Xiaomi', '7C:89:56': 'Xiaomi',
  '88:C3:97': 'Xiaomi', '98:0D:6E': 'Xiaomi', '9C:99:A0': 'Xiaomi', 'A8:BD:3A': 'Xiaomi',
  'AC:57:75': 'Xiaomi', 'B0:E2:35': 'Xiaomi', 'C8:14:51': 'Xiaomi', 'D4:97:0B': 'Xiaomi',
  'E4:FA:ED': 'Xiaomi', 'F4:8C:50': 'Xiaomi', 'F4:F5:DB': 'Xiaomi', 'F8:A3:4F': 'Xiaomi',
  'F8:BB:BF': 'Xiaomi', '28:D1:27': 'Xiaomi', '34:CE:00': 'Xiaomi', '38:AF:29': 'Xiaomi',
  '40:31:3C': 'Xiaomi', '50:DC:e7': 'Xiaomi', '58:44:98': 'Xiaomi', '64:b4:5c': 'Xiaomi',
  '68:DF:DD': 'Xiaomi', '70:EF:00': 'Xiaomi', '78:11:25': 'Xiaomi', '7C:03:D8': 'Xiaomi',
  '8C:D7:8D': 'Xiaomi', '90:18:AE': 'Xiaomi', '98:0C:82': 'Xiaomi', '9C:2E:94': 'Xiaomi',
  'A4:77:2F': 'Xiaomi', 'AC:19:F9': 'Xiaomi', 'B0:DC:EF': 'Xiaomi', 'B4:43:0D': 'Xiaomi',
  'BC:83:AB': 'Xiaomi', 'C4:0B:CB': 'Xiaomi', 'C8:50:E9': 'Xiaomi', 'CC:2D:83': 'Xiaomi',
  'D0:C5:D3': 'Xiaomi', 'D4:97:0B': 'Xiaomi', 'DC:44:27': 'Xiaomi', 'E0:CC:F8': 'Xiaomi',
  'E4:0A:11': 'Xiaomi', 'EC:41:18': 'Xiaomi', 'F0:B4:29': 'Xiaomi', 'F4:F5:A5': 'Xiaomi',
  // Huawei / Honor
  '00:E0:FC': 'Huawei', '08:19:A6': 'Huawei', '10:47:80': 'Huawei', '10:51:07': 'Huawei',
  '10:C1:72': 'Huawei', '14:30:04': 'Huawei', '14:CF:92': 'Huawei', '18:DE:D7': 'Huawei',
  '1C:15:1F': 'Huawei', '1C:AB:34': 'Huawei', '20:0B:C7': 'Huawei', '24:69:A5': 'Huawei',
  '24:DB:AC': 'Huawei', '28:31:52': 'Huawei', '28:57:46': 'Huawei', '28:A2:BD': 'Huawei',
  '2C:AB:00': 'Huawei', '30:87:30': 'Huawei', '30:D1:6B': 'Huawei', '38:F2:3E': 'Huawei',
  '3C:FA:43': 'Huawei', '48:01:C5': 'Huawei', '4C:1F:CC': 'Huawei', '4C:54:99': 'Huawei',
  '4C:B1:99': 'Huawei', '54:89:98': 'Huawei', '58:25:68': 'Huawei', '5C:4C:A9': 'Huawei',
  '5C:B3:96': 'Huawei', '5C:B4:24': 'Huawei', '5C:F9:DD': 'Huawei', '60:E7:01': 'Huawei',
  '64:A6:51': 'Huawei', '70:72:0D': 'Huawei', '70:A8:E3': 'Huawei', '78:F5:E5': 'Huawei',
  '7C:11:CB': 'Huawei', '7C:46:85': 'Huawei', '80:38:FD': 'Huawei', '80:B6:86': 'Huawei',
  '84:A8:E4': 'Huawei', '88:53:D4': 'Huawei', '88:CF:98': 'Huawei', '8C:15:C7': 'Huawei',
  '90:4E:91': 'Huawei', '90:67:B5': 'Huawei', '9C:28:EF': 'Huawei', 'A0:28:ED': 'Huawei',
  'A4:81:7A': 'Huawei', 'A8:15:4D': 'Huawei', 'AC:85:F3': 'Huawei', 'AC:E2:15': 'Huawei',
  'B4:30:52': 'Huawei', 'B4:7C:9C': 'Huawei', 'BC:3F:8F': 'Huawei', 'BC:76:70': 'Huawei',
  'C0:49:EF': 'Huawei', 'C4:0B:CB': 'Huawei', 'C8:1E:E7': 'Huawei', 'CC:05:0F': 'Huawei',
  'CC:96:A0': 'Huawei', 'D0:16:7A': 'Huawei', 'D0:57:75': 'Huawei', 'D0:7E:28': 'Huawei',
  'D4:6A:A8': 'Huawei', 'D4:6D:6D': 'Huawei', 'D4:7B:05': 'Huawei', 'D4:94:E8': 'Huawei',
  'D4:B1:10': 'Huawei', 'D8:06:2A': 'Huawei', 'D8:49:2F': 'Huawei', 'DC:D2:FC': 'Huawei',
  'E0:24:7F': 'Huawei', 'E0:36:76': 'Huawei', 'E0:9D:31': 'Huawei', 'E0:AC:F1': 'Huawei',
  'E4:35:C8': 'Huawei', 'E4:60:17': 'Huawei', 'E8:08:8B': 'Huawei', 'EC:23:3D': 'Huawei',
  'EC:89:14': 'Huawei', 'F0:99:BF': 'Huawei', 'F4:55:9C': 'Huawei', 'F4:CB:5E': 'Huawei',
  'F4:E3:FB': 'Huawei', 'F8:4A:BF': 'Huawei', 'F8:E8:97': 'Huawei', 'FC:3F:DB': 'Huawei',
  // OPPO / Realme / OnePlus
  '00:36:76': 'OPPO', '00:F1:41': 'OPPO', '14:E7:80': 'OPPO', '18:3D:A2': 'OPPO',
  '1C:68:29': 'OPPO', '20:0B:C7': 'OPPO', '24:69:A5': 'OPPO', '28:3B:82': 'OPPO',
  '2C:AB:00': 'OPPO', '30:87:30': 'OPPO', '34:6B:D3': 'OPPO', '38:F2:3E': 'OPPO',
  '3C:FA:43': 'OPPO', '48:01:C5': 'OPPO', '54:89:98': 'OPPO', '58:25:68': 'OPPO',
  '5C:4C:A9': 'OPPO', '5C:B3:96': 'OPPO', '60:E7:01': 'OPPO', '64:A6:51': 'OPPO',
  '70:A8:E3': 'OPPO', '78:F5:E5': 'OPPO', '80:38:FD': 'OPPO', '84:A8:E4': 'OPPO',
  '90:4E:91': 'OPPO', '9C:28:EF': 'OPPO', 'A4:81:7A': 'OPPO', 'AC:85:F3': 'OPPO',
  'B4:30:52': 'OPPO', 'BC:3F:8F': 'OPPO', 'C8:1E:E7': 'OPPO', 'CC:05:0F': 'OPPO',
  'CC:96:A0': 'OPPO', 'D0:16:7A': 'OPPO', 'D4:6A:A8': 'OPPO', 'D4:6D:6D': 'OPPO',
  'D4:94:E8': 'OPPO', 'D8:06:2A': 'OPPO', 'E0:24:7F': 'OPPO', 'E4:35:C8': 'OPPO',
  'E8:08:8B': 'OPPO', 'F0:99:BF': 'OPPO', 'F4:CB:5E': 'OPPO',
  // Motorola
  '00:0C:E5': 'Motorola', '00:0E:5C': 'Motorola', '00:12:0E': 'Motorola',
  '00:15:1F': 'Motorola', '00:17:E2': 'Motorola', '00:18:82': 'Motorola',
  '00:1A:1B': 'Motorola', '00:1C:C5': 'Motorola', '00:1E:65': 'Motorola',
  '00:1F:7E': 'Motorola', '00:21:1E': 'Motorola', '00:22:68': 'Motorola',
  '00:23:04': 'Motorola', '00:24:8C': 'Motorola', '00:26:68': 'Motorola',
  '00:3A:9D': 'Motorola', '00:60:37': 'Motorola', '00:80:37': 'Motorola',
  '00:90:6D': 'Motorola', '04:50:DA': 'Motorola', '08:00:69': 'Motorola',
  '0C:96:CD': 'Motorola', '10:2E:AF': 'Motorola', '14:1A:A5': 'Motorola',
  '18:AF:61': 'Motorola', '1C:99:4C': 'Motorola', '24:DA:33': 'Motorola',
  '28:27:BF': 'Motorola', '2C:1E:4F': 'Motorola', '34:23:87': 'Motorola',
  '38:94:96': 'Motorola', '3C:43:8E': 'Motorola', '40:78:93': 'Motorola',
  '44:A7:28': 'Motorola', '48:27:E4': 'Motorola', '4C:10:A5': 'Motorola',
  '50:1A:C5': 'Motorola', '54:60:09': 'Motorola', '58:20:59': 'Motorola',
  '5C:3A:45': 'Motorola', '60:A4:D0': 'Motorola', '64:B4:73': 'Motorola',
  '68:35:EB': 'Motorola', '6C:AD:94': 'Motorola', '70:72:CF': 'Motorola',
  '74:AC:88': 'Motorola', '78:28:CA': 'Motorola', '7C:25:05': 'Motorola',
  '80:82:77': 'Motorola', '84:38:35': 'Motorola', '88:44:77': 'Motorola',
  '8C:95:7F': 'Motorola', '90:17:AC': 'Motorola', '94:76:F4': 'Motorola',
  '98:4B:4A': 'Motorola', '9C:97:1A': 'Motorola', 'A4:70:7E': 'Motorola',
  'AC:5D:10': 'Motorola', 'B0:79:94': 'Motorola', 'B4:35:64': 'Motorola',
  'B8:C1:11': 'Motorola', 'BC:30:7E': 'Motorola', 'C0:59:76': 'Motorola',
  'C4:63:94': 'Motorola', 'C8:1E:E7': 'Motorola', 'CC:04:B4': 'Motorola',
  'D0:07:CA': 'Motorola', 'D4:50:3A': 'Motorola', 'D8:16:0A': 'Motorola',
  'DC:02:8E': 'Motorola', 'E0:CB:C2': 'Motorola', 'E4:3E:E0': 'Motorola',
  'E8:84:A5': 'Motorola', 'EC:5A:86': 'Motorola', 'F0:27:65': 'Motorola',
  'F4:0F:24': 'Motorola', 'F8:CF:0D': 'Motorola', 'FC:19:10': 'Motorola',
  // Google / Nest
  '00:1A:11': 'Google', '18:D6:0D': 'Google', '3C:5A:B4': 'Google', '54:60:09': 'Google',
  '64:9E:F4': 'Google', '74:DE:2B': 'Google', 'A4:77:33': 'Google', 'D4:F5:13': 'Google',
  'F4:F5:E8': 'Google',
  // LG
  '00:1E:75': 'LG', '00:1F:E3': 'LG', '00:26:E2': 'LG', '04:7B:CB': 'LG',
  '10:68:92': 'LG', '14:56:8E': 'LG', '18:3D:A2': 'LG', '1C:56:FE': 'LG',
  'BC:30:D9': 'LG',
  '24:26:42': 'LG', '2C:54:CF': 'LG', '38:BC:01': 'LG', '3C:52:82': 'LG',
  '48:59:A2': 'LG', '50:BC:96': 'LG', '58:35:59': 'LG', '5C:17:D3': 'LG',
  '64:89:08': 'LG', '6C:C7:EC': 'LG', '74:A5:28': 'LG', '78:5E:E8': 'LG',
  '80:86:F2': 'LG', '88:C9:E8': 'LG', '8C:7A:28': 'LG', '90:18:7C': 'LG',
  '94:44:44': 'LG', '9C:E6:35': 'LG', 'A0:39:EE': 'LG', 'A4:71:74': 'LG',
  'A8:16:D0': 'LG', 'AC:E2:15': 'LG', 'B0:7E:5C': 'LG', 'B4:CE:40': 'LG',
  'BC:4C:93': 'LG', 'C0:49:EF': 'LG', 'C4:9E:41': 'LG', 'C8:1E:E7': 'LG',
  'CC:FA:00': 'LG', 'D4:38:AF': 'LG', 'D8:5D:E2': 'LG', 'DC:2B:2A': 'LG',
  'E0:98:61': 'LG', 'E4:7C:D7': 'LG', 'E8:5B:5B': 'LG', 'EC:5C:84': 'LG',
  'F0:1F:AF': 'LG', 'F4:6A:DD': 'LG', 'F8:E0:79': 'LG', 'FC:35:35': 'LG',
  // Sony
  '00:01:4A': 'Sony', '00:0A:30': 'Sony', '00:0E:07': 'Sony', '00:13:A9': 'Sony',
  '00:15:C1': 'Sony', '00:19:C5': 'Sony', '00:1D:0D': 'Sony', '00:1E:3C': 'Sony',
  '00:1F:E4': 'Sony', '00:21:5E': 'Sony', '00:24:BE': 'Sony', '00:26:BD': 'Sony',
  '00:80:A0': 'Sony', '04:4B:F3': 'Sony', '08:00:46': 'Sony', '0C:48:C6': 'Sony',
  '10:4F:A8': 'Sony', '10:95:E8': 'Sony', '14:5A:05': 'Sony', '18:22:EF': 'Sony',
  '1C:A6:2C': 'Sony', '20:5E:F7': 'Sony', '24:BE:18': 'Sony', '28:EF:01': 'Sony',
  '2C:54:CF': 'Sony', '30:96:FB': 'Sony', '38:59:F9': 'Sony', '3C:07:71': 'Sony',
  '40:2B:A1': 'Sony', '44:5C:E9': 'Sony', '48:50:47': 'Sony', '4C:3B:FF': 'Sony',
  '50:01:BB': 'Sony', '54:42:49': 'Sony', '58:17:0C': 'Sony', '5C:96:9D': 'Sony',
  '60:38:E0': 'Sony', '64:77:91': 'Sony', '68:27:37': 'Sony', '6C:0E:0D': 'Sony',
  '70:F0:87': 'Sony', '74:03:BD': 'Sony', '78:84:3C': 'Sony', '7C:61:66': 'Sony',
  '80:EA:96': 'Sony', '84:BE:9D': 'Sony', '88:19:C2': 'Sony', '8C:25:05': 'Sony',
  '90:C1:15': 'Sony', '94:27:90': 'Sony', '98:9C:57': 'Sony', '9C:14:63': 'Sony',
  'A0:02:DC': 'Sony', 'A4:DA:3F': 'Sony', 'A8:E3:EE': 'Sony', 'AC:9B:0A': 'Sony',
  'B0:55:08': 'Sony', 'B4:52:7D': 'Sony', 'B8:97:5A': 'Sony', 'BC:6E:E2': 'Sony',
  'C0:49:EF': 'Sony', 'C4:21:E4': 'Sony', 'C8:14:79': 'Sony', 'CC:5D:4E': 'Sony',
  'D0:27:88': 'Sony', 'D4:E8:B2': 'Sony', 'D8:9C:67': 'Sony', 'DC:03:98': 'Sony',
  'E0:5A:9F': 'Sony', 'E4:18:6F': 'Sony', 'E8:6E:44': 'Sony', 'EC:9B:F3': 'Sony',
  'F0:BF:97': 'Sony', 'F4:6D:2F': 'Sony', 'F8:E0:79': 'Sony', 'FC:F1:52': 'Sony',
  // Amazon / Echo / Fire TV
  '00:BB:3A': 'Amazon', '0C:47:C9': 'Amazon', '18:74:2E': 'Amazon', '1C:12:9E': 'Amazon',
  '24:4C:07': 'Amazon', '28:EF:01': 'Amazon', '2C:11:65': 'Amazon', '2C:F0:5D': 'Amazon',
  '34:D2:70': 'Amazon', '38:F7:3D': 'Amazon', '3C:5C:04': 'Amazon', '40:9F:38': 'Amazon',
  '44:65:0D': 'Amazon', '48:E7:DA': 'Amazon', '50:DC:e7': 'Amazon', '54:EF:44': 'Amazon',
  '58:48:22': 'Amazon', '5C:41:5F': 'Amazon', '60:45:BD': 'Amazon', '64:DB:A7': 'Amazon',
  '68:37:E9': 'Amazon', '68:54:FD': 'Amazon', '68:9E:2E': 'Amazon', '6C:5E:3B': 'Amazon',
  '74:C2:46': 'Amazon', '78:E1:03': 'Amazon', '7C:61:66': 'Amazon', '80:7A:7F': 'Amazon',
  '84:71:27': 'Amazon', '88:71:E5': 'Amazon', '8C:84:01': 'Amazon', '90:45:27': 'Amazon',
  '94:6A:B8': 'Amazon', '98:06:3C': 'Amazon', '9C:50:EE': 'Amazon', 'A0:02:DC': 'Amazon',
  'A4:39:26': 'Amazon', 'A8:E3:EE': 'Amazon', 'AC:63:BE': 'Amazon', 'B0:FC:0D': 'Amazon',
  'B4:E7:AD': 'Amazon', 'B8:5C:DA': 'Amazon', 'BC:0F:2B': 'Amazon', 'C0:28:45': 'Amazon',
  'C4:03:A8': 'Amazon', 'C8:2E:18': 'Amazon', 'CC:69:FA': 'Amazon', 'D0:50:99': 'Amazon',
  'D4:6D:6D': 'Amazon', 'D8:28:C9': 'Amazon', 'DC:74:A8': 'Amazon', 'E0:47:36': 'Amazon',
  'E4:71:2C': 'Amazon', 'E8:DE:27': 'Amazon', 'EC:65:CC': 'Amazon', 'F0:81:73': 'Amazon',
  'F4:03:43': 'Amazon', 'F4:65:A6': 'Amazon', 'F8:4F:AD': 'Amazon', 'FC:A6:67': 'Amazon',
  // Nokia / HMD Global
  '00:14:A7': 'Nokia', '00:19:B7': 'Nokia', '00:1C:9A': 'Nokia', '00:1F:5E': 'Nokia',
  '00:1F:DF': 'Nokia', '00:21:08': 'Nokia', '00:22:FA': 'Nokia', '00:24:03': 'Nokia',
  '00:25:5E': 'Nokia', '00:26:CC': 'Nokia', '00:28:7E': 'Nokia', '00:2A:10': 'Nokia',
  '00:E0:FC': 'Nokia', '08:5B:0E': 'Nokia', '0C:48:C6': 'Nokia', '10:68:92': 'Nokia',
  '14:4F:8A': 'Nokia', '18:3D:A2': 'Nokia', '1C:56:FE': 'Nokia', '24:26:42': 'Nokia',
  '2C:54:CF': 'Nokia', '34:CE:00': 'Nokia', '38:AF:29': 'Nokia', '3C:52:82': 'Nokia',
  '40:31:3C': 'Nokia', '48:59:A2': 'Nokia', '50:BC:96': 'Nokia', '58:35:59': 'Nokia',
  '5C:17:D3': 'Nokia', '64:89:08': 'Nokia', '6C:C7:EC': 'Nokia', '74:A5:28': 'Nokia',
  '78:5E:E8': 'Nokia', '80:86:F2': 'Nokia', '88:C9:E8': 'Nokia', '8C:7A:28': 'Nokia',
  '90:18:7C': 'Nokia', '94:44:44': 'Nokia', '9C:E6:35': 'Nokia', 'A0:39:EE': 'Nokia',
  'A4:71:74': 'Nokia', 'A8:16:D0': 'Nokia', 'AC:E2:15': 'Nokia', 'B0:7E:5C': 'Nokia',
  'B4:CE:40': 'Nokia', 'BC:4C:93': 'Nokia', 'C0:49:EF': 'Nokia', 'C4:9E:41': 'Nokia',
  'C8:1E:E7': 'Nokia', 'CC:FA:00': 'Nokia', 'D4:38:AF': 'Nokia', 'D8:5D:E2': 'Nokia',
  'DC:2B:2A': 'Nokia', 'E0:98:61': 'Nokia', 'E4:7C:D7': 'Nokia', 'E8:5B:5B': 'Nokia',
  'EC:5C:84': 'Nokia', 'F0:1F:AF': 'Nokia', 'F4:6A:DD': 'Nokia', 'F8:E0:79': 'Nokia',
  'FC:35:35': 'Nokia',
  // Vivo / iQOO
  '00:36:76': 'Vivo', '00:BB:3A': 'Vivo', '14:E7:80': 'Vivo', '18:3D:A2': 'Vivo',
  '1C:68:29': 'Vivo', '20:0B:C7': 'Vivo', '24:69:A5': 'Vivo', '28:3B:82': 'Vivo',
  '2C:AB:00': 'Vivo', '30:87:30': 'Vivo', '34:6B:D3': 'Vivo', '38:F2:3E': 'Vivo',
  '3C:FA:43': 'Vivo', '48:01:C5': 'Vivo', '54:89:98': 'Vivo', '58:25:68': 'Vivo',
  '5C:4C:A9': 'Vivo', '5C:B3:96': 'Vivo', '60:E7:01': 'Vivo', '64:A6:51': 'Vivo',
  '70:A8:E3': 'Vivo', '78:F5:E5': 'Vivo', '80:38:FD': 'Vivo', '84:A8:E4': 'Vivo',
  '90:4E:91': 'Vivo', '9C:28:EF': 'Vivo', 'A4:81:7A': 'Vivo', 'AC:85:F3': 'Vivo',
  'B4:30:52': 'Vivo', 'BC:3F:8F': 'Vivo', 'C8:1E:E7': 'Vivo', 'CC:05:0F': 'Vivo',
  'CC:96:A0': 'Vivo', 'D0:16:7A': 'Vivo', 'D4:6A:A8': 'Vivo', 'D4:6D:6D': 'Vivo',
  'D4:94:E8': 'Vivo', 'D8:06:2A': 'Vivo', 'E0:24:7F': 'Vivo', 'E4:35:C8': 'Vivo',
  'E8:08:8B': 'Vivo', 'F0:99:BF': 'Vivo', 'F4:CB:5E': 'Vivo',
  // Roku
  'AC:3A:7A': 'Roku', 'AC:AE:19': 'Roku', 'B0:A7:37': 'Roku', 'C8:3A:6B': 'Roku',
  'D0:4D:FC': 'Roku', 'D4:EA:0E': 'Roku', 'D8:2A:7E': 'Roku', 'DC:3A:5E': 'Roku',
  'E0:26:36': 'Roku', 'E4:2C:D8': 'Roku', 'E8:31:CD': 'Roku', 'EC:6C:9A': 'Roku',
  'F0:3E:1F': 'Roku', 'F4:09:D8': 'Roku', 'F8:A9:7A': 'Roku', 'FC:0F:E6': 'Roku',
  // Sonos
  '00:0E:58': 'Sonos', '34:42:62': 'Sonos', '48:A6:B8': 'Sonos', '54:2A:A2': 'Sonos',
  '5C:AA:FD': 'Sonos', '78:28:CA': 'Sonos', '94:9F:3E': 'Sonos', '9C:8E:CD': 'Sonos',
  'B8:E9:37': 'Sonos', 'BC:30:7B': 'Sonos', 'C0:28:45': 'Sonos', 'D8:1D:72': 'Sonos',
  'E8:91:20': 'Sonos',
  // Chromecast / Google Cast
  '00:1A:11': 'Chromecast', '18:D6:0D': 'Chromecast', '3C:5A:B4': 'Chromecast',
  '54:60:09': 'Chromecast', '64:9E:F4': 'Chromecast', '74:DE:2B': 'Chromecast',
  'A4:77:33': 'Chromecast', 'D4:F5:13': 'Chromecast', 'F4:F5:E8': 'Chromecast',
  // Philips Hue
  '00:17:88': 'Philips Hue', '00:1B:ED': 'Philips Hue', '00:21:2E': 'Philips Hue',
  '00:23:97': 'Philips Hue', '00:25:E4': 'Philips Hue', '00:27:13': 'Philips Hue',
  '00:29:6F': 'Philips Hue', '00:2A:A8': 'Philips Hue', '00:2C:15': 'Philips Hue',
  '00:2E:9C': 'Philips Hue', '00:30:F1': 'Philips Hue', '00:33:97': 'Philips Hue',
  '00:35:E0': 'Philips Hue', '00:38:5E': 'Philips Hue', '00:3A:7D': 'Philips Hue',
  '00:3C:10': 'Philips Hue', '00:3D:E1': 'Philips Hue', '00:3F:BD': 'Philips Hue',
  '00:41:BC': 'Philips Hue', '00:43:94': 'Philips Hue', '00:45:58': 'Philips Hue',
  '00:47:20': 'Philips Hue', '00:49:06': 'Philips Hue', '00:4A:8B': 'Philips Hue',
  '00:4C:3B': 'Philips Hue', '00:4E:35': 'Philips Hue', '00:50:C7': 'Philips Hue',
  '00:52:E6': 'Philips Hue', '00:54:AF': 'Philips Hue', '00:56:FE': 'Philips Hue',
  '00:58:90': 'Philips Hue', '00:5A:39': 'Philips Hue', '00:5C:E2': 'Philips Hue',
  '00:5E:3A': 'Philips Hue', '00:60:6D': 'Philips Hue', '00:62:EC': 'Philips Hue',
  '00:64:40': 'Philips Hue', '00:66:4B': 'Philips Hue', '00:68:EB': 'Philips Hue',
  '00:6B:9E': 'Philips Hue', '00:6D:52': 'Philips Hue', '00:6F:4E': 'Philips Hue',
  '00:71:C1': 'Philips Hue', '00:74:12': 'Philips Hue', '00:75:E2': 'Philips Hue',
  '00:77:49': 'Philips Hue', '00:79:18': 'Philips Hue', '00:7B:CB': 'Philips Hue',
  '00:7D:E7': 'Philips Hue', '00:80:A3': 'Philips Hue', '00:82:6D': 'Philips Hue',
  '00:84:41': 'Philips Hue', '00:86:50': 'Philips Hue', '00:88:15': 'Philips Hue',
  '00:89:6C': 'Philips Hue', '00:8B:FB': 'Philips Hue', '00:8D:44': 'Philips Hue',
  '00:8F:01': 'Philips Hue', '00:90:7A': 'Philips Hue', '00:92:9C': 'Philips Hue',
  '00:94:E6': 'Philips Hue', '00:96:E6': 'Philips Hue', '00:98:77': 'Philips Hue',
  '00:9A:49': 'Philips Hue', '00:9C:8E': 'Philips Hue', '00:9E:2F': 'Philips Hue',
  '00:A0:6D': 'Philips Hue', '00:A1:E5': 'Philips Hue', '00:A3:14': 'Philips Hue',
  '00:A4:C2': 'Philips Hue', '00:A6:4F': 'Philips Hue', '00:A7:8C': 'Philips Hue',
  '00:A8:5D': 'Philips Hue', '00:AA:DA': 'Philips Hue', '00:AC:52': 'Philips Hue',
  '00:AD:63': 'Philips Hue', '00:AF:58': 'Philips Hue', '00:B0:52': 'Philips Hue',
  '00:B1:D5': 'Philips Hue', '00:B3:19': 'Philips Hue', '00:B4:F2': 'Philips Hue',
  '00:B6:1B': 'Philips Hue', '00:B8:7D': 'Philips Hue', '00:BA:B2': 'Philips Hue',
  '00:BC:9F': 'Philips Hue', '00:BE:61': 'Philips Hue', '00:C0:14': 'Philips Hue',
  '00:C2:C6': 'Philips Hue', '00:C4:64': 'Philips Hue', '00:C6:10': 'Philips Hue',
  '00:C8:74': 'Philips Hue', '00:CA:40': 'Philips Hue', '00:CC:5A': 'Philips Hue',
  '00:CE:4D': 'Philips Hue', '00:D0:CA': 'Philips Hue', '00:D2:1E': 'Philips Hue',
  '00:D4:3B': 'Philips Hue', '00:D6:1B': 'Philips Hue', '00:D8:A1': 'Philips Hue',
  '00:DA:00': 'Philips Hue', '00:DC:E8': 'Philips Hue', '00:DE:58': 'Philips Hue',
  '00:E0:3B': 'Philips Hue', '00:E2:1D': 'Philips Hue', '00:E4:01': 'Philips Hue',
  '00:E6:2E': 'Philips Hue', '00:E8:75': 'Philips Hue', '00:EA:00': 'Philips Hue',
  '00:EC:30': 'Philips Hue', '00:EE:BD': 'Philips Hue', '00:F0:1E': 'Philips Hue',
  '00:F2:14': 'Philips Hue', '00:F4:0A': 'Philips Hue', '00:F6:20': 'Philips Hue',
  '00:F8:21': 'Philips Hue', '00:FA:22': 'Philips Hue', '00:FC:44': 'Philips Hue',
  '00:FE:20': 'Philips Hue', '14:23:D7': 'Philips Hue', '18:17:34': 'Philips Hue',
  '1C:43:19': 'Philips Hue', '20:13:E0': 'Philips Hue', '24:62:AB': 'Philips Hue',
  '28:AD:3A': 'Philips Hue', '2C:3F:3F': 'Philips Hue', '30:52:CB': 'Philips Hue',
  '34:31:C4': 'Philips Hue', '38:17:66': 'Philips Hue', '3C:71:BF': 'Philips Hue',
  '40:12:E4': 'Philips Hue', '44:4E:2A': 'Philips Hue', '48:43:FC': 'Philips Hue',
  '4C:30:89': 'Philips Hue', '50:32:75': 'Philips Hue', '54:52:1A': 'Philips Hue',
  '58:8C:08': 'Philips Hue', '5C:AD:CF': 'Philips Hue', '60:27:5C': 'Philips Hue',
  '64:1C:AE': 'Philips Hue', '68:14:01': 'Philips Hue', '6C:72:20': 'Philips Hue',
  '70:12:F4': 'Philips Hue', '74:03:BD': 'Philips Hue', '78:28:CA': 'Philips Hue',
  '7C:1C:4E': 'Philips Hue', '80:7A:7F': 'Philips Hue', '84:17:15': 'Philips Hue',
  '88:15:44': 'Philips Hue', '8C:85:80': 'Philips Hue', '90:14:DA': 'Philips Hue',
  '94:8B:C1': 'Philips Hue', '98:E7:43': 'Philips Hue', '9C:32:96': 'Philips Hue',
  'A0:1E:0B': 'Philips Hue', 'A4:3E:51': 'Philips Hue', 'A8:60:B6': 'Philips Hue',
  'AC:4B:C8': 'Philips Hue', 'B0:AD:6B': 'Philips Hue', 'B4:35:22': 'Philips Hue',
  'B8:27:EB': 'Philips Hue', 'BC:93:07': 'Philips Hue', 'C0:3F:0E': 'Philips Hue',
  'C4:45:67': 'Philips Hue', 'C8:14:79': 'Philips Hue', 'CC:20:E8': 'Philips Hue',
  'D0:22:BE': 'Philips Hue', 'D4:22:3F': 'Philips Hue', 'D8:30:62': 'Philips Hue',
  'DC:4F:22': 'Philips Hue', 'E0:14:9F': 'Philips Hue', 'E4:11:5B': 'Philips Hue',
  'E8:06:88': 'Philips Hue', 'EC:B5:FC': 'Philips Hue', 'F0:1F:AF': 'Philips Hue',
  'F4:4C:7F': 'Philips Hue', 'F8:97:68': 'Philips Hue', 'FC:45:96': 'Philips Hue',
  // Microsoft Surface / Xbox
  '28:18:78': 'Microsoft', '30:59:26': 'Microsoft', '40:E2:30': 'Microsoft',
  '50:1A:C5': 'Microsoft', '60:45:BD': 'Microsoft', '7C:61:66': 'Microsoft',
  '90:E4:68': 'Microsoft', '98:5F:D3': 'Microsoft', 'B0:65:F2': 'Microsoft',
  'C8:3B:45': 'Microsoft', 'D4:63:C6': 'Microsoft', 'E4:98:D1': 'Microsoft',
  'F8:59:71': 'Microsoft',
};

function lookupOUI(mac) {
  const oui = mac.toUpperCase().slice(0, 8);
  return OUI_DB[oui] || 'Desconocido';
}

async function discoverUPnP() {
  return new Promise((resolve) => {
    const devices = {};
    const socket = dgram.createSocket('udp4');
    const searchMsg = Buffer.from([
      'M-SEARCH * HTTP/1.1',
      'HOST: 239.255.255.250:1900',
      'MAN: "ssdp:discover"',
      'MX: 2',
      'ST: ssdp:all',
      'USER-AGENT: Node.js/18 UPnP/1.1 WiFiAnalyzer/1.0',
      '',
    ].join('\r\n'));

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const ip = rinfo.address;
      if (ip === '127.0.0.1' || ip.startsWith('127.')) return;
      const locationMatch = text.match(/LOCATION:\s*(.+)/i);
      const serverMatch = text.match(/SERVER:\s*(.+)/i);
      const usnMatch = text.match(/USN:\s*(.+)/i);
      const stMatch = text.match(/ST:\s*(.+)/i);
      if (!devices[ip]) devices[ip] = [];
      devices[ip].push({
        location: locationMatch ? locationMatch[1].trim() : null,
        server: serverMatch ? serverMatch[1].trim() : null,
        usn: usnMatch ? usnMatch[1].trim() : null,
        st: stMatch ? stMatch[1].trim() : null,
      });
    });

    socket.on('listening', () => {
      try { socket.addMembership('239.255.255.250'); } catch (_) {}
      socket.send(searchMsg, 0, searchMsg.length, 1900, '239.255.255.250');
      setTimeout(() => {
        try { socket.dropMembership('239.255.255.250'); } catch (_) {}
        socket.close();
        resolve(devices);
      }, 3500);
    });

    socket.bind(1900, () => {
      // A veces bind tarda; fallback
      setTimeout(() => {
        if (socket.pending !== false) {
          try { socket.send(searchMsg, 0, searchMsg.length, 1900, '239.255.255.250'); } catch (_) {}
        }
      }, 100);
    });
  });
}

async function getUPnPFriendlyName(locationUrl) {
  if (!locationUrl) return null;
  const proto = locationUrl.startsWith('https') ? https : http;
  return new Promise((resolve) => {
    const req = proto.get(locationUrl, { timeout: 3000, rejectUnauthorized: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; if (data.length > 100000) { req.destroy(); resolve(null); } });
      res.on('end', () => {
        const fm = data.match(/<friendlyName>(.+?)<\/friendlyName>/is);
        if (fm) {
          const name = fm[1].replace(/[\r\n\s]+/g, ' ').trim();
          if (name.length > 1 && name.length < 80) return resolve(name);
        }
        const dm = data.match(/<modelName>(.+?)<\/modelName>/is);
        if (dm) {
          const name = dm[1].replace(/[\r\n\s]+/g, ' ').trim();
          if (name.length > 1 && name.length < 80) return resolve(name);
        }
        resolve(null);
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.setTimeout(3000);
  });
}

async function discoverMDNS() {
  // Windows no tiene mDNS nativo, usamos PowerShell + Resolve-DnsName con .local
  try {
    const out = await run(`powershell -NoProfile -Command "
      $ips = @('192.168.20.1'..'192.168.20.254')
      $results = @()
      foreach ($last in 1..254) {
        $ip = '192.168.20.' + $last
        try {
          $name = (Resolve-DnsName $ip -Type PTR -ErrorAction SilentlyContinue).NameHost
          if ($name) { $results += \"$ip|$name\" }
        } catch {}
      }
      $results -join \"\`n\"
    "`, 15000);
    const map = {};
    for (const line of out.split(/\r?\n/)) {
      const [ip, name] = line.split('|');
      if (ip && name && name.includes('.')) map[ip.trim()] = name.trim();
    }
    return map;
  } catch (_) {
    return {};
  }
}

async function getHostname(ip, upnpDevices = {}) {
  // Si ya tenemos UPnP descubierto con friendlyName, usarlo
  if (upnpDevices[ip]) {
    const upnp = upnpDevices[ip];
    if (upnp.friendlyName && upnp.friendlyName !== 'Desconocido') return upnp.friendlyName;
    // Intentar obtener friendlyName desde LOCATION
    for (const entry of upnp.entries || []) {
      if (entry.location) {
        const name = await withTimeout(getUPnPFriendlyName(entry.location), 3000);
        if (name) return name;
      }
    }
  }

  // Probar varios metodos de descubrimiento de nombre en paralelo
  const metodos = [
    withTimeout(getDNS(ip), 3000),
    withTimeout(getLLMNR(ip), 3000),
    withTimeout(getNetBIOS(ip), 3000),
    withTimeout(getHTTPName(ip, false), 3000),
    withTimeout(getHTTPName(ip, true), 3000),
    withTimeout(getSNMPName(ip), 3000),
  ];

  const resultados = await Promise.all(metodos);
  for (const nombre of resultados) {
    if (nombre && nombre !== 'Desconocido' && nombre.length > 1) {
      return nombre.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return 'Desconocido';
}

// TTL OS Fingerprinting - Extrae TTL del ping para identificar OS
async function getTTLFromPing(ip) {
  try {
    const out = await run(`ping -n 1 -w 1000 ${ip}`, 3000);
    const m = out.match(/TTL[=:](\d+)/i);
    if (m) return parseInt(m[1]);
  } catch (_) {}
  return null;
}

function detectOSByTTL(ttl) {
  if (!ttl) return null;
  // TTL decrementa por cada hop (router) que pasa
  // En red local (1 hop del router), TTL esperado:
  if (ttl >= 60 && ttl <= 65) return { os: 'Linux / Android / iOS / MacOS', family: 'Unix-like' };
  if (ttl >= 126 && ttl <= 129) return { os: 'Windows', family: 'Windows' };
  if (ttl >= 250 && ttl <= 255) return { os: 'Router / Cisco / Solaris / AIX', family: 'Network' };
  if (ttl >= 50 && ttl <= 59) return { os: 'Linux / Android (2+ hops)', family: 'Unix-like' };
  if (ttl >= 116 && ttl <= 125) return { os: 'Windows (2+ hops)', family: 'Windows' };
  return null;
}

// Detecta MACs localmente administrados (randomizados por privacidad de Android/iOS)
function isLocalMAC(mac) {
  if (!mac || mac === 'N/A') return false;
  const firstByte = parseInt(mac.split(':')[0], 16);
  return (firstByte & 0x02) !== 0; // bit 1 = localmente administrado
}

function inferirDispositivoCompleto(puertos, mac, ttl, hostname) {
  const p = new Set(puertos);
  const macU = mac.toUpperCase();
  const oui = macU.slice(0, 8);
  const osInfo = detectOSByTTL(ttl);
  const h = (hostname || '').toLowerCase();

  // Si hostname indica claramente un tipo de dispositivo, respetarlo
  if (h.includes('tv') || h.includes('webos') || h.includes('bravia') || h.includes('roku') || h.includes('firetv') || h.includes('fire tv')) {
    return { tipo: 'Smart TV LG', nombre: hostname };
  }
  if (h.includes('chromecast') || h.includes('google cast')) {
    return { tipo: 'Chromecast', nombre: hostname };
  }
  if (h.includes('sonos')) {
    return { tipo: 'Dispositivo Sonos', nombre: hostname };
  }
  if (h.includes('hue') || h.includes('philips')) {
    return { tipo: 'Dispositivo Philips Hue', nombre: hostname };
  }
  if (h.includes('xbox')) {
    return { tipo: 'Dispositivo Microsoft', nombre: hostname };
  }
  if (h.includes('playstation') || h.includes('ps4') || h.includes('ps5')) {
    return { tipo: 'Dispositivo Sony', nombre: hostname };
  }
  if (h.includes('printer') || h.includes('impresora') || h.includes('hp ') || h.includes('canon')) {
    return { tipo: 'Impresora', nombre: hostname };
  }
  if (h.includes('camera') || h.includes('camara') || h.includes('ipcam')) {
    return { tipo: 'Cámara IP', nombre: hostname };
  }
  if (h.includes('nas') || h.includes('synology') || h.includes('qnap')) {
    return { tipo: 'NAS / Servidor', nombre: hostname };
  }

  // iPhone / iPad
  if (p.has(62078)) return { tipo: 'Movil/Tablet', nombre: 'iPhone / iPad (Apple)' };

  // Android ADB
  if (p.has(5555)) return { tipo: 'Movil/Tablet', nombre: 'Android (Modo Desarrollo)' };

  // Router / Gateway
  if (p.has(80) && p.has(5000)) return { tipo: 'Router / AP', nombre: 'Router UPnP' };
  if (ttl && ttl >= 250) return { tipo: 'Router / AP', nombre: 'Router / Network Device' };

  // Windows PC
  if (p.has(445) || p.has(3389)) return { tipo: 'PC / Laptop', nombre: 'Windows PC' };
  if (osInfo && osInfo.family === 'Windows') {
    return { tipo: 'PC / Laptop', nombre: osInfo.os };
  }

  // NAS / Servidor
  if (p.has(5000) || p.has(5001)) return { tipo: 'NAS / Servidor', nombre: 'Synology NAS' };
  if (p.has(32400)) return { tipo: 'Media Server', nombre: 'Plex Media Server' };
  if (p.has(8123)) return { tipo: 'Smart Home', nombre: 'Home Assistant' };

  // Linux / Servidor
  if (p.has(22)) return { tipo: 'Servidor / Linux', nombre: 'Servidor SSH' };

  // Deteccion de moviles por MAC local + TTL Linux-like + sin puertos abiertos
  if (isLocalMAC(mac) && (!puertos || puertos.length === 0)) {
    if (osInfo && osInfo.family === 'Unix-like') {
      return { tipo: 'Movil/Tablet', nombre: 'Celular/Tablet (Privacidad MAC activada)' };
    }
    return { tipo: 'Movil/Tablet', nombre: 'Dispositivo Movil (MAC randomizada)' };
  }

  // Deteccion por TTL Linux-like sin puertos (probablemente movil con firewall)
  if (osInfo && osInfo.family === 'Unix-like' && (!puertos || puertos.length === 0)) {
    return { tipo: 'Movil/Tablet', nombre: osInfo.os + ' (Firewall activo)' };
  }

  // Web
  if (p.has(80) || p.has(443) || p.has(8080) || p.has(8443)) {
    return { tipo: 'Dispositivo con Web', nombre: 'Dispositivo con Interfaz Web' };
  }

  return null;
}

// Cache para resultados de LM Studio (evita re-consultar mismos dispositivos)
const lmCache = new Map();

// Base de datos local de dispositivos identificados (aprendizaje)
const DEVICE_DB_PATH = path.join(__dirname, 'dispositivos_db.json');
function loadDeviceDB() {
  try {
    if (fs.existsSync(DEVICE_DB_PATH)) {
      const data = JSON.parse(fs.readFileSync(DEVICE_DB_PATH, 'utf-8'));
      return new Map(Object.entries(data));
    }
  } catch (e) {}
  return new Map();
}
function saveDeviceDB(db) {
  try {
    const obj = Object.fromEntries(db);
    fs.writeFileSync(DEVICE_DB_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {}
}
const deviceDB = loadDeviceDB();

// Buscar informacion de MAC address online via macvendors.com
async function lookupMACOnline(mac) {
  if (!mac || mac === 'N/A') return null;
  const oui = mac.replace(/:/g, '').substring(0, 6).toUpperCase();
  return new Promise((resolve) => {
    const req = https.get(`https://api.macvendors.com/${mac}`, { timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const clean = data.trim();
        if (clean && !clean.includes('error') && !clean.includes('Not Found')) {
          console.log(`[Web] MAC lookup ${mac} -> ${clean}`);
          resolve(clean);
        } else {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Buscar en DuckDuckGo para obtener informacion de dispositivos
async function searchWeb(query) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(query);
    const req = https.get(`https://html.duckduckgo.com/html/?q=${encoded}`, { timeout: 6000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Extraer snippets de resultados
          const snippets = [];
          const matches = data.match(/class="result__snippet"[^>]*>([^<]*)/g);
          if (matches) {
            matches.slice(0, 3).forEach(m => {
              const text = m.replace(/class="result__snippet"[^>]*>/, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
              if (text.length > 10) snippets.push(text);
            });
          }
          if (snippets.length > 0) {
            console.log(`[Web] Search "${query}" -> ${snippets.length} resultados`);
            resolve(snippets.join(' | '));
          } else {
            resolve(null);
          }
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Enriquecer datos del dispositivo con busquedas web
async function enriquecerConWeb(dispositivo) {
  const webInfo = {};
  const promises = [];

  // Buscar fabricante por MAC online
  if (dispositivo.mac && dispositivo.mac !== 'N/A') {
    promises.push(
      lookupMACOnline(dispositivo.mac).then(r => { if (r) webInfo.macVendor = r; })
    );
  }

  // Buscar info del hostname
  if (dispositivo.hostname && dispositivo.hostname !== 'Desconocido') {
    const h = dispositivo.hostname.replace('.local', '');
    promises.push(
      searchWeb(`${h} device model network`).then(r => { if (r) webInfo.hostnameSearch = r; })
    );
  }

  // Buscar info por fabricante + tipo
  if (dispositivo.fabricante && dispositivo.fabricante !== 'Desconocido') {
    promises.push(
      searchWeb(`${dispositivo.fabricante} ${dispositivo.tipo} MAC OUI`).then(r => { if (r) webInfo.vendorSearch = r; })
    );
  }

  await Promise.all(promises);
  return webInfo;
}

// Identificacion de dispositivos usando LM Studio con gemma-4-e2b + datos web
async function identificarConLMStudio(dispositivo) {
  const LM_STUDIO_URL = 'http://localhost:1234/v1/chat/completions';

  // Usar cache por MAC para evitar re-consultas
  const cacheKey = dispositivo.mac + dispositivo.hostname;
  if (lmCache.has(cacheKey)) {
    console.log(`[LM Studio] Cache hit para ${dispositivo.ip}`);
    return lmCache.get(cacheKey);
  }

  // Enriquecer con datos de internet
  console.log(`[Web] Buscando info online para ${dispositivo.ip}...`);
  const webData = await enriquecerConWeb(dispositivo);

  let webContext = '';
  if (webData.macVendor) webContext += `\n- Fabricante confirmado online: ${webData.macVendor}`;
  if (webData.hostnameSearch) webContext += `\n- Info del hostname en internet: ${webData.hostnameSearch.substring(0, 300)}`;
  if (webData.vendorSearch) webContext += `\n- Busqueda del fabricante: ${webData.vendorSearch.substring(0, 300)}`;

  const prompt = `Eres un experto en identificacion de dispositivos de red. Analiza estos datos y devuelve EXACTAMENTE el modelo del dispositivo (ej: "iPhone 14 Pro", "Xiaomi Redmi Note 12", "Samsung Galaxy S23", "LG OLED C3", "Router TP-Link Archer AX50", "Smart TV Samsung 55\"", etc.).

Datos del dispositivo:
- IP: ${dispositivo.ip}
- MAC: ${dispositivo.mac}
- Fabricante (OUI): ${dispositivo.fabricante}
- Hostname: ${dispositivo.hostname}
- Puertos abiertos: ${(dispositivo.puertos || []).join(', ') || 'Ninguno'}
- TTL: ${dispositivo.ttl || 'Desconocido'}
- Tipo inferido: ${dispositivo.tipo}
- MAC local (randomizada): ${dispositivo.macLocal ? 'Si' : 'No'}${webContext}

Responde UNICAMENTE con el nombre exacto del modelo. Si no puedes identificar el modelo exacto, responde "Desconocido". No incluyas explicaciones.`;

  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'google/gemma-4-e2b',
      messages: [
        { role: 'system', content: 'Eres un experto en identificacion precisa de dispositivos de red. Responde SOLO con el nombre exacto del modelo, sin explicaciones ni razonamiento.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 500,
      stream: false
    });

    const req = http.request(LM_STUDIO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const message = json.choices?.[0]?.message;
          let content = message?.content?.trim();
          // Modelos de razonamiento (gemma-4-e2b) pueden poner respuesta en reasoning_content
          if (!content && message?.reasoning_content) {
            content = message.reasoning_content.trim();
          }
          if (content && content !== 'Desconocido' && content.length > 2 && content.length < 120) {
            // Limpiar razonamiento: extraer solo la linea con el modelo
            const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
            const modelLine = lines.find(l => !l.toLowerCase().includes('thinking') && !l.toLowerCase().includes('process') && !l.toLowerCase().includes('analyze') && !l.toLowerCase().includes('determine') && !l.toLowerCase().includes('step'));
            const final = modelLine || lines[lines.length - 1] || content;
            const clean = final.replace(/^\d+\.\s*/, '').replace(/^-\s*/, '').replace(/^\*\s*/, '').trim();
            if (clean && clean !== 'Desconocido' && clean.length > 2 && clean.length < 120) {
              console.log(`[LM Studio] ${dispositivo.ip} -> ${clean}`);
              lmCache.set(cacheKey, clean);
              resolve(clean);
              return;
            }
          }
          lmCache.set(cacheKey, null);
          resolve(null);
        } catch (e) {
          lmCache.set(cacheKey, null);
          resolve(null);
        }
      });
    });

    req.on('error', () => { lmCache.set(cacheKey, null); resolve(null); });
    req.on('timeout', () => { lmCache.set(cacheKey, null); req.destroy(); resolve(null); });
    req.write(postData);
    req.end();
  });
}

function scanPort(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.on('connect', () => { socket.destroy(); resolve({ open: true, port }); });
    socket.on('timeout', () => { socket.destroy(); resolve({ open: false, port }); });
    socket.on('error', () => { socket.destroy(); resolve({ open: false, port }); });
    socket.connect(port, ip);
  });
}

async function scanPorts(ip) {
  const commonPorts = [22, 23, 80, 443, 445, 3389, 5000, 5001, 5555, 62078, 8080, 8443, 32400, 8123];
  // Paralelizar escaneo de todos los puertos de la IP al mismo tiempo
  const results = await Promise.all(commonPorts.map(port => scanPort(ip, port, 800)));
  return results.filter(r => r.open).map(r => r.port);
}

async function grabBanner(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let data = '';
    socket.setTimeout(timeout);
    socket.on('connect', () => {
      if (port === 22) { /* SSH envia banner automatico */ }
      else { socket.write('HEAD / HTTP/1.0\r\n\r\n'); }
    });
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.length > 512 || data.includes('\n')) { socket.destroy(); resolve(data.slice(0, 300)); }
    });
    socket.on('timeout', () => { socket.destroy(); resolve(data.slice(0, 300)); });
    socket.on('error', () => { socket.destroy(); resolve(data.slice(0, 300)); });
    socket.connect(port, ip);
  });
}

function identificarPorPuertos(puertos, mac) {
  const p = new Set(puertos);
  const macU = mac.toUpperCase();
  const oui = macU.slice(0, 8);

  // iPhone / iPad
  if (p.has(62078)) return { tipo: 'Movil/Tablet', nombre: 'iPhone / iPad (Apple)' };
  if (oui.startsWith('AC:DE:48') || oui.startsWith('F0:18:98') || macU.startsWith('02:00:00')) {
    if (p.has(80) || p.has(443)) return { tipo: 'Movil/Tablet', nombre: 'iPhone / iPad (Apple)' };
  }

  // Android ADB
  if (p.has(5555)) return { tipo: 'Movil/Tablet', nombre: 'Android (Modo Desarrollo)' };

  // Router / Gateway
  if (p.has(80) && p.has(5000)) return { tipo: 'Router / AP', nombre: 'Router UPnP' };

  // Windows PC
  if (p.has(445) || p.has(3389)) return { tipo: 'PC / Laptop', nombre: 'Windows PC' };

  // NAS / Servidor
  if (p.has(5000) || p.has(5001)) return { tipo: 'NAS / Servidor', nombre: 'Synology NAS' };
  if (p.has(32400)) return { tipo: 'Media Server', nombre: 'Plex Media Server' };
  if (p.has(8123)) return { tipo: 'Smart Home', nombre: 'Home Assistant' };

  // Linux / Servidor
  if (p.has(22)) return { tipo: 'Servidor / Linux', nombre: 'Servidor SSH' };

  // Web
  if (p.has(80) || p.has(443) || p.has(8080) || p.has(8443)) {
    return { tipo: 'Dispositivo con Web', nombre: 'Dispositivo con Interfaz Web' };
  }

  return null;
}

function detectarTipo(fabricante, ip, gatewayIp) {
  if (ip === gatewayIp) return 'Router / Gateway';
  const f = fabricante.toLowerCase();
  if (f.includes('apple')) return 'Dispositivo Apple';
  if (f.includes('samsung')) return 'Dispositivo Samsung';
  if (f.includes('xiaomi') || f.includes('redmi')) return 'Dispositivo Xiaomi / Redmi';
  if (f.includes('huawei') || f.includes('honor')) return 'Dispositivo Huawei / Honor';
  if (f.includes('oppo')) return 'Dispositivo OPPO';
  if (f.includes('vivo')) return 'Dispositivo Vivo';
  if (f.includes('oneplus')) return 'Dispositivo OnePlus';
  if (f.includes('realme')) return 'Dispositivo Realme';
  if (f.includes('motorola') || f.includes('lenovo moto')) return 'Dispositivo Motorola';
  if (f.includes('lg')) return 'Dispositivo LG';
  if (f.includes('sony') || f.includes('ericsson')) return 'Dispositivo Sony';
  if (f.includes('nokia') || f.includes('hmd')) return 'Dispositivo Nokia';
  if (f.includes('google') || f.includes('nest')) return 'Dispositivo Google / Nest';
  if (f.includes('amazon') || f.includes('alexa') || f.includes('echo')) return 'Dispositivo Amazon / Alexa';
  if (f.includes('vmware') || f.includes('hyper-v') || f.includes('virtualbox')) return 'Máquina Virtual';
  if (f.includes('tp-link') || f.includes('huawei') || f.includes('xiaomi') || f.includes('d-link') || f.includes('netgear') || f.includes('asus') || f.includes('linksys')) return 'Router / AP';
  if (f.includes('philips') || f.includes('hue')) return 'Dispositivo Philips Hue';
  if (f.includes('sonos')) return 'Dispositivo Sonos';
  if (f.includes('chromecast') || f.includes('google cast')) return 'Chromecast';
  if (f.includes('roku')) return 'Dispositivo Roku';
  if (f.includes('fire tv') || f.includes('firetv')) return 'Amazon Fire TV';
  if (f.includes('samsung') && f.includes('tv')) return 'Smart TV Samsung';
  if (f.includes('lg') && f.includes('tv')) return 'Smart TV LG';
  if (f.includes('tcl')) return 'Smart TV TCL';
  if (f.includes('hisense')) return 'Smart TV Hisense';
  return 'Dispositivo Genérico';
}

function ping(ip, timeout = 300) {
  return new Promise((resolve) => {
    exec(`ping -n 1 -w ${timeout} ${ip}`, { encoding: 'utf-8' }, (err) => {
      resolve(!err); // true si respondió
    });
  });
}

async function pingSweep(subnet, onProgress) {
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${subnet}.${i}`);

  const batchSize = 50; // Aumentado de 30 a 50 para mas paralelismo
  const activos = [];
  for (let i = 0; i < ips.length; i += batchSize) {
    const batch = ips.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(ip => ping(ip, 300)));
    results.forEach((ok, idx) => { if (ok) activos.push(batch[idx]); });
    if (onProgress) onProgress(Math.min(i + batchSize, 254), 254);
  }
  return activos;
}

// Helper para ejecutar tareas async en batches paralelos
async function runInBatches(items, fn, batchSize = 10) {
  const results = {};
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(async (item) => {
      const result = await fn(item);
      return { item, result };
    }));
    batchResults.forEach(({ item, result }) => {
      results[item] = result;
    });
  }
  return results;
}

async function obtenerDispositivos(gatewayIp) {
  console.time('[Dispositivos] Tiempo total');
  const subnet = gatewayIp.split('.').slice(0, 3).join('.');

  // 1. Descubrir dispositivos UPnP en paralelo con ping sweep
  console.log(`[Dispositivos] Escaneando UPnP/SSDP en paralelo...`);
  const upnpPromise = discoverUPnP();

  // 2. Ping sweep
  console.log(`[Dispositivos] Haciendo ping sweep a ${subnet}.1 - ${subnet}.254...`);
  const activos = await pingSweep(subnet, (done, total) => {
    console.log(`[Dispositivos] Progreso: ${done}/${total} IPs`);
  });
  console.log(`[Dispositivos] ${activos.length} dispositivos respondieron al ping`);

  // 3. Esperar resultados UPnP
  const upnpRaw = await upnpPromise;
  console.log(`[Dispositivos] UPnP descubrio ${Object.keys(upnpRaw).length} IPs`);

  // Normalizar datos UPnP por IP
  const upnpDevices = {};
  for (const [ip, entries] of Object.entries(upnpRaw)) {
    upnpDevices[ip] = { entries, friendlyName: null };
  }

  // 4. Asegurar que gateway siempre esté en la lista
  if (!activos.includes(gatewayIp)) activos.push(gatewayIp);

  // 5. Agregar dispositivos UPnP que no respondieron al ping
  for (const ip of Object.keys(upnpDevices)) {
    if (!activos.includes(ip)) activos.push(ip);
  }

  // 6. Obtener hostname de cada IP (con UPnP como hint) - PARALELO con batches de 10
  console.log(`[Dispositivos] Resolviendo nombres de ${activos.length} hosts...`);
  const hostMap = await runInBatches(activos, ip => getHostname(ip, upnpDevices), 10);

  // 7. Scan de puertos para identificar dispositivos - PARALELO con batches de 10
  console.log(`[Dispositivos] Escaneando puertos de ${activos.length} hosts...`);
  const portMap = await runInBatches(activos, async (ip) => {
    const ports = await scanPorts(ip);
    if (ports.length > 0) {
      console.log(`[Dispositivos] ${ip} puertos abiertos: ${ports.join(', ')}`);
    }
    return ports;
  }, 10);

  // 8. TTL OS Fingerprinting - PARALELO con batches de 15
  console.log(`[Dispositivos] Obteniendo TTL de ${activos.length} hosts...`);
  const ttlMap = await runInBatches(activos, async (ip) => {
    const ttl = await getTTLFromPing(ip);
    if (ttl) {
      const osGuess = detectOSByTTL(ttl);
      console.log(`[Dispositivos] ${ip} TTL=${ttl} -> ${osGuess ? osGuess.os : 'Desconocido'}`);
    }
    return ttl;
  }, 15);

  // 9. Forzar ARP resolution - PARALELO con batches de 20
  console.log(`[Dispositivos] Forzando ARP para ${activos.length} hosts...`);
  await runInBatches(activos, ip => run(`ping -n 1 -w 200 ${ip}`).catch(() => null), 20);
  await new Promise(r => setTimeout(r, 800));

  // 10. Leer tabla ARP
  const arpOut = await run('arp -a');
  const arpMap = {};
  for (const line of arpOut.split(/\r?\n/)) {
    const m = line.trim().match(/(\d+\.\d+\.\d+\.\d+)\s+([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/i);
    if (!m) continue;
    const ip = m[1];
    const mac = m[2].replace(/-/g, ':').toUpperCase();
    const firstOctet = parseInt(ip.split('.')[0]);
    if (firstOctet >= 224 && firstOctet <= 239) continue;
    if (ip === '255.255.255.255' || ip.startsWith('127.')) continue;
    if (!arpMap[ip]) arpMap[ip] = mac;
  }

  // 11. Construir lista preliminar
  const dispositivosPre = [];
  for (const ip of activos) {
    let mac = arpMap[ip];
    if (!mac) {
      try {
        const specific = await run(`arp -a ${ip}`);
        const m2 = specific.match(/([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/i);
        if (m2) mac = m2[1].replace(/-/g, ':').toUpperCase();
      } catch (_) {}
    }
    if (!mac) mac = 'N/A';
    const fabricante = mac !== 'N/A' ? lookupOUI(mac) : 'Desconocido';
    let tipo = detectarTipo(fabricante, ip, gatewayIp);
    let hostname = hostMap[ip] || 'Desconocido';
    hostname = hostname.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ').replace(/\s+/g, ' ').trim();

    const puertos = portMap[ip] || [];
    const ttl = ttlMap[ip];
    const inferido = inferirDispositivoCompleto(puertos, mac, ttl, hostname);
    if (inferido) {
      if (hostname === 'Desconocido') hostname = inferido.nombre;
      const genericos = ['Dispositivo Genérico', 'Dispositivo LG', 'Dispositivo Sony', 'Dispositivo Samsung', 'Dispositivo Apple', 'Dispositivo Xiaomi / Redmi', 'Dispositivo Huawei / Honor', 'Dispositivo OPPO', 'Dispositivo Vivo', 'Dispositivo OnePlus', 'Dispositivo Realme', 'Dispositivo Motorola', 'Dispositivo Nokia', 'Dispositivo Google / Nest', 'Dispositivo Amazon / Alexa', 'Dispositivo Microsoft'];
      if (genericos.includes(tipo)) tipo = inferido.tipo;
    }

    dispositivosPre.push({
      ip,
      mac,
      fabricante,
      tipo,
      estado: 'Activo',
      hostname,
      puertos,
      ttl,
      macLocal: isLocalMAC(mac)
    });
  }

  // 12. Aplicar base de datos local aprendida primero
  for (const d of dispositivosPre) {
    if (d.mac !== 'N/A' && deviceDB.has(d.mac)) {
      const known = deviceDB.get(d.mac);
      if (known && known !== 'Desconocido') {
        d.hostname = known;
        console.log(`[DB] ${d.ip} identificado por DB aprendida como: ${known}`);
      }
    }
  }

  // 13. Consultar LM Studio para dispositivos no identificados (excluyendo los ya en DB)
  const genericosParaLM = ['Dispositivo Genérico', 'Movil/Tablet', 'Dispositivo LG', 'Dispositivo Sony', 'Dispositivo Samsung', 'Dispositivo Apple', 'Dispositivo Xiaomi / Redmi', 'Dispositivo Huawei / Honor', 'Dispositivo OPPO', 'Dispositivo Vivo', 'Dispositivo OnePlus', 'Dispositivo Realme', 'Dispositivo Motorola', 'Dispositivo Nokia', 'Dispositivo Google / Nest', 'Dispositivo Amazon / Alexa', 'Dispositivo Microsoft', 'Dispositivo con Web'];
  const dispositivosParaLM = dispositivosPre.filter(d =>
    (genericosParaLM.includes(d.tipo) || d.hostname === 'Desconocido') &&
    d.mac !== 'N/A' && !deviceDB.has(d.mac)
  );

  if (dispositivosParaLM.length > 0) {
    console.log(`[Dispositivos] Consultando LM Studio para ${dispositivosParaLM.length} dispositivos...`);
    const lmResults = await runInBatches(dispositivosParaLM, async (d) => {
      const lmName = await identificarConLMStudio(d);
      return { ip: d.ip, mac: d.mac, lmName };
    }, 3); // Solo 3 en paralelo para no saturar LM Studio

    // Aplicar resultados de LM Studio y guardar en DB
    for (const d of dispositivosPre) {
      const lmResult = lmResults[d.ip];
      if (lmResult && lmResult !== 'Desconocido') {
        d.hostname = lmResult;
        console.log(`[Dispositivos] ${d.ip} identificado por LM Studio como: ${lmResult}`);
        // Guardar en DB local para aprendizaje futuro
        if (d.mac !== 'N/A') {
          deviceDB.set(d.mac, lmResult);
        }
      }
    }
    saveDeviceDB(deviceDB);
    console.log(`[DB] Guardados ${dispositivosParaLM.length} dispositivos en base de datos local`);
  }

  // 14. Lista final
  const dispositivos = dispositivosPre.map(d => ({
    ip: d.ip,
    mac: d.mac,
    fabricante: d.fabricante,
    tipo: d.tipo,
    estado: d.estado,
    hostname: d.hostname,
    puertos: d.puertos
  }));

  console.timeEnd('[Dispositivos] Tiempo total');
  return dispositivos.sort((a, b) => {
    if (a.tipo === 'Router / Gateway') return -1;
    if (b.tipo === 'Router / Gateway') return 1;
    return a.ip.localeCompare(b.ip, undefined, { numeric: true });
  });
}

// Convertir prefijo CIDR a mascara de red (ej: 24 -> 255.255.255.0)
function cidrToMask(cidr) {
  const bits = parseInt(cidr);
  if (isNaN(bits) || bits < 0 || bits > 32) return '255.255.255.0';
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return [(mask >>> 24) & 0xff, (mask >>> 16) & 0xff, (mask >>> 8) & 0xff, mask & 0xff].join('.');
}

// Calcular rango de red a partir de IP y mascara
function calcularRangoRed(ip, mascaraDecimal) {
  const ipToInt = (ip) => ip.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet)) >>> 0, 0);
  const maskToInt = (mask) => mask.split('.').reduce((acc, octet) => ((acc << 8) + parseInt(octet)) >>> 0, 0);
  const intToIp = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');

  const ipInt = ipToInt(ip);
  const maskInt = maskToInt(mascaraDecimal);
  const networkInt = ipInt & maskInt;
  const broadcastInt = networkInt | (~maskInt >>> 0);
  const cidr = maskInt.toString(2).split('1').length - 1;

  return {
    network: intToIp(networkInt),
    broadcast: intToIp(broadcastInt),
    firstHost: intToIp(networkInt + 1),
    lastHost: intToIp(broadcastInt - 1),
    cidr,
    range: `${intToIp(networkInt)}/${cidr}`,
    totalHosts: broadcastInt - networkInt - 1
  };
}

// Obtener informacion detallada de un dispositivo especifico (para el modal)
async function obtenerInfoDetalladaDispositivo(targetIp) {
  console.time(`[Detalle] ${targetIp}`);

  // 1. Datos de red del escaner (en paralelo con ping)
  const redPromise = obtenerDatos();

  // 2. Ping para latencia y packet loss
  const pingPromise = run(`ping -n 4 -w 1000 ${targetIp}`, 8000).catch(() => '');

  // 3. Info de adaptadores de red locales (en paralelo) - usando PowerShell porque wmic esta deprecado
  const nicPromise = run('powershell.exe -Command "Get-NetAdapter | Where-Object Status -eq \'Up\' | Select-Object Name, LinkSpeed | ConvertTo-Json -Compress"', 5000).catch(() => '');

  // 4. Info WiFi (en paralelo)
  const wifiPromise = run('netsh wlan show interfaces', 5000).catch(() => '');

  // 5. TTL del dispositivo
  const ttlPromise = getTTLFromPing(targetIp);

  // 6. MAC desde ARP
  const arpPromise = run(`arp -a ${targetIp}`, 3000).catch(() => '');

  // 7. DHCP info del escaner
  const dhcpPromise = run('ipconfig /all', 4000).catch(() => '');

  // 8. NetBIOS name del dispositivo remoto
  const netbiosPromise = run(`nbtstat -A ${targetIp}`, 5000).catch(() => '');

  // 9. Traceroute al dispositivo
  const traceroutePromise = run(`tracert -d -h 15 ${targetIp}`, 8000).catch(() => '');

  // 10. Banner grabbing de puertos comunes
  const bannerPromises = [22, 23, 80, 443, 445, 21, 25, 110, 143, 3306, 3389, 5900, 8080].map(port =>
    grabBanner(targetIp, port).catch(() => null)
  );

  // Esperar todo en paralelo
  const [red, pingOut, nicOut, wifiOut, ttl, arpOut, dhcpOut, netbiosOut, tracerouteOut, ...bannerResults] = await Promise.all([
    redPromise, pingPromise, nicPromise, wifiPromise, ttlPromise, arpPromise,
    dhcpPromise, netbiosPromise, traceroutePromise,
    ...bannerPromises
  ]);

  // Parsear ping robusto (no depende de tildes ni codificación)
  let latenciaMin = null, latenciaMax = null, latenciaAvg = null, packetLoss = null;
  const timeMatches = pingOut.match(/=\s*(<1|\d+)ms/g);
  if (timeMatches && timeMatches.length >= 3) {
    const parseTime = (t) => t.includes('<1') ? 0 : parseInt(t.match(/\d+/)[0]);
    latenciaMin = parseTime(timeMatches[0]);
    latenciaMax = parseTime(timeMatches[1]);
    latenciaAvg = parseTime(timeMatches[2]);
  }
  const lossMatch = pingOut.match(/(\d+)%\s*p[ée]rdida/i) || pingOut.match(/(\d+)%\s*loss/i);
  if (lossMatch) packetLoss = parseInt(lossMatch[1]);

  // Parsear NIC (formato JSON de PowerShell)
  const adapters = [];
  try {
    const nicJson = JSON.parse(nicOut);
    const nicArray = Array.isArray(nicJson) ? nicJson : [nicJson];
    for (const nic of nicArray) {
      if (nic && nic.Name) {
        const speedStr = nic.LinkSpeed || '';
        const speedMatch = speedStr.match(/(\d+)/);
        const speedMbps = speedMatch ? parseInt(speedMatch[1]) : null;
        adapters.push({ name: nic.Name.trim(), speedMbps });
      }
    }
  } catch (e) {
    // Fallback vacio
  }

  // Parsear WiFi (soporta formato con (Mbps) en medio)
  let wifiInfo = null;
  const ssidMatch = wifiOut.match(/SSID\s*:\s*(.+)/i);
  const signalMatch = wifiOut.match(/Señal\s*:\s*(\d+)%/i) || wifiOut.match(/Signal\s*:\s*(\d+)%/i);
  const rateMatch = wifiOut.match(/Velocidad de transmisi[óo]n(?:\s*\(Mbps\))?\s*:\s*(\d+)/i) || wifiOut.match(/Transmit rate\s*:\s*(\d+)/i) || wifiOut.match(/Rate\s*:\s*(\d+)/i);
  const bandMatch = wifiOut.match(/Banda\s*:\s*(.+)/i) || wifiOut.match(/Band\s*:\s*(.+)/i);
  if (ssidMatch) {
    wifiInfo = {
      ssid: ssidMatch[1].trim(),
      signal: signalMatch ? parseInt(signalMatch[1]) : null,
      rateMbps: rateMatch ? parseInt(rateMatch[1]) : null,
      band: bandMatch ? bandMatch[1].trim() : null
    };
  }

  // Parsear MAC desde ARP (entrada específica)
  let mac = 'N/A';
  const macMatch = arpOut.match(/([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/i);
  if (macMatch) mac = macMatch[1].replace(/-/g, ':').toUpperCase();

  // Fallback 1: buscar en tabla ARP completa
  if (mac === 'N/A') {
    try {
      const arpFull = await run('arp -a', 3000);
      const lines = arpFull.split(/\r?\n/);
      for (const line of lines) {
        if (line.includes(targetIp)) {
          const m = line.match(/([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/i);
          if (m) { mac = m[1].replace(/-/g, ':').toUpperCase(); break; }
        }
      }
    } catch (_) {}
  }

  // Fallback 2: si es la propia máquina, obtener MAC de la interfaz Wi-Fi
  if (mac === 'N/A' && red.ip.direccion === targetIp) {
    try {
      const localMac = (await run('powershell -NoProfile -Command "(Get-NetAdapter | Where-Object Status -eq \'Up\' | Select-Object -First 1 MacAddress).MacAddress"', 3000)).trim();
      if (localMac && localMac.includes('-')) mac = localMac.replace(/-/g, ':').toUpperCase();
    } catch (_) {}
  }

  // Fallback 3: forzar ping + esperar + ARP específico
  if (mac === 'N/A') {
    try {
      await run(`ping -n 1 -w 500 ${targetIp}`, 3000);
      await new Promise(r => setTimeout(r, 800));
      const arpRetry = await run(`arp -a ${targetIp}`, 3000);
      const macRetry = arpRetry.match(/([0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2}[-:][0-9a-fA-F]{2})/i);
      if (macRetry) mac = macRetry[1].replace(/-/g, ':').toUpperCase();
    } catch (_) {}
  }

  // TTL -> OS guess
  const osGuess = ttl ? detectOSByTTL(ttl) : null;

  // Parsear DHCP
  let dhcpInfo = null;
  const dhcpServidor = dhcpOut.match(/Servidor DHCP\s*[:.]\s*(\d+\.\d+\.\d+\.\d+)/i);
  const dhcpHabilitado = dhcpOut.match(/DHCP habilitado\s*[:.]\s*(S[ií]|Yes)/i);
  const dhcpLease = dhcpOut.match(/Concesi[óo]n obtenida\s*[:.]\s*(.+)/i);
  const dhcpExpire = dhcpOut.match(/Concesi[óo]n expira\s*[:.]\s*(.+)/i);
  if (dhcpServidor || dhcpHabilitado) {
    dhcpInfo = {
      servidor: dhcpServidor ? dhcpServidor[1].trim() : 'Desconocido',
      habilitado: dhcpHabilitado ? 'Si' : 'No',
      concesionObt: dhcpLease ? dhcpLease[1].trim() : 'N/A',
      concesionExp: dhcpExpire ? dhcpExpire[1].trim() : 'N/A'
    };
  }

  // Parsear NetBIOS
  let netbiosName = null;
  const nbMatch = netbiosOut.match(/(\S+)\s+<00>\s+UNIQUE/i);
  if (nbMatch) netbiosName = nbMatch[1].trim();

  // Parsear Traceroute
  const tracerouteHops = [];
  for (const line of tracerouteOut.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s*ms/i);
    if (m) {
      tracerouteHops.push({ hop: parseInt(m[1]), time: parseInt(m[2]) });
    }
  }

  // Parsear banners
  const banners = [];
  const bannerPorts = [22, 23, 80, 443, 445, 21, 25, 110, 143, 3306, 3389, 5900, 8080];
  for (let i = 0; i < bannerPorts.length; i++) {
    if (bannerResults[i]) {
      banners.push({ port: bannerPorts[i], banner: bannerResults[i].substring(0, 200) });
    }
  }

  // Convertir mascara CIDR a formato decimal
  const mascaraDecimal = red.ip.mascara && /^\d+$/.test(red.ip.mascara) ? cidrToMask(red.ip.mascara) : red.ip.mascara;

  // Rango de red
  let rangoRed = null;
  if (red.ip.direccion && mascaraDecimal) {
    rangoRed = calcularRangoRed(red.ip.direccion, mascaraDecimal);
  }

  console.timeEnd(`[Detalle] ${targetIp}`);

  return {
    ip: targetIp,
    mac,
    fabricante: mac !== 'N/A' ? lookupOUI(mac) : 'Desconocido',
    ttl,
    osGuess: osGuess ? osGuess.os : 'Desconocido',
    latencia: {
      min: latenciaMin,
      max: latenciaMax,
      avg: latenciaAvg,
      packetLoss
    },
    redLocal: {
      gateway: red.ip.gateway,
      mascara: mascaraDecimal,
      dns: red.ip.dns,
      adaptadores: adapters,
      wifi: wifiInfo,
      rango: rangoRed,
      interfaz: red.red ? red.red.nombre : 'Desconocido',
      velocidadInternet: red.red && red.red.recepcion ? red.red.recepcion : 'Desconocido',
      dhcp: dhcpInfo
    },
    netbiosName,
    tracerouteHops,
    banners,
    online: latenciaAvg !== null
  };
}

// Banner grabbing para detectar servicios/versiones
async function grabBanner(ip, port) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const socket = new net.Socket();
    socket.setTimeout(3000);
    let banner = '';

    socket.connect(port, ip, () => {
      if (port === 80 || port === 8080) {
        socket.write('GET / HTTP/1.0\r\nHost: ' + ip + '\r\n\r\n');
      } else if (port === 21) {
        // FTP: el servidor envia banner automaticamente
      } else if (port === 22) {
        // SSH: el servidor envia banner automaticamente
      } else {
        socket.write('\r\n');
      }
    });

    socket.on('data', (data) => {
      banner += data.toString('utf-8', 0, Math.min(data.length, 512));
      if (banner.length > 300) socket.destroy();
    });

    socket.on('error', () => reject());
    socket.on('timeout', () => { socket.destroy(); reject(); });
    socket.on('close', () => {
      if (banner.trim().length > 0) resolve(banner.trim());
      else reject();
    });
  });
}

// Ping en vivo: un solo paquete, devuelve latencia en ms o null
async function pingLive(ip, timeout = 1000) {
  try {
    const out = await run(`ping -n 1 -w ${timeout} ${ip}`, timeout + 500);
    const m = out.match(/tiempo[<=](\d+)ms/i) || out.match(/time[<=](\d+)ms/i);
    if (m) return parseInt(m[1]);
    // Fallback para <1ms
    const m2 = out.match(/tiempo[<]1ms/i) || out.match(/time[<]1ms/i);
    if (m2) return 0;
    return null;
  } catch (e) {
    return null;
  }
}

// Obtener solo datos WiFi actuales (rapido, para en vivo)
async function obtenerWiFiLive() {
  try {
    const out = await run('netsh wlan show interfaces', 3000);
    const signal    = extract(out, /Se[ñn]al\s*:\s*(.+)/i);
    const reception = extract(out, /Velocidad de recepci[óo]n \(Mbps\)\s*:\s*(\d+)/i);
    const transmission = extract(out, /Velocidad de transmisi[óo]n \(Mbps\)\s*:\s*(\d+)/i);
    const channel = extract(out, /Canal\s*:\s*(\d+)/i);
    const ssid    = extract(out, /SSID\s*:\s*(.+)/i);
    const radio   = extract(out, /Tipo de radio\s*:\s*(.+)/i);
    return {
      ok: true,
      senial: signal || 'N/A',
      recepcion: reception ? parseInt(reception) : null,
      transmision: transmission ? parseInt(transmission) : null,
      canal: channel || 'N/A',
      ssid: ssid || 'N/A',
      tecnologia: radio || 'N/A'
    };
  } catch (e) {
    return { ok: false, senial: 'N/A', recepcion: null, transmision: null, canal: 'N/A', ssid: 'N/A', tecnologia: 'N/A' };
  }
}

module.exports = { obtenerDatos, guardarTxt, obtenerDispositivos, obtenerInfoDetalladaDispositivo, lookupOUI, pingLive, obtenerWiFiLive };
