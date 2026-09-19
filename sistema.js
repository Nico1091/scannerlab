// sistema.js — Puente reversible entre NetPulse y la configuración de Windows.
// Solo se activa cuando el usuario pulsa "Activar intercepción" en su propio
// equipo. Enruta el navegador hacia el interceptor local y confía su
// certificado. Todo es reversible con "Desactivar", y además se revierte solo
// si el servidor se cierra, para no dejar el equipo sin internet.

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function ps(cmd, timeout = 15000) {
  return new Promise((resolve) => {
    exec('powershell -NoProfile -NonInteractive -Command "' + cmd.replace(/"/g, '\\"') + '"',
      { timeout, windowsHide: true }, (err, out, er) => resolve({ err, out: (out || '').toString().trim(), er: (er || '').toString().trim() }));
  });
}

// Avisa a Windows/navegadores que la configuración de proxy cambió
function refrescar() {
  const cs = "$s='[DllImport(\\\"wininet.dll\\\")] public static extern bool InternetSetOption(IntPtr a,int b,IntPtr c,int d);'; " +
    "$t=Add-Type -MemberDefinition $s -Name Win -Namespace Net -PassThru; " +
    "$t::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0)|Out-Null; $t::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0)|Out-Null";
  return ps(cs);
}

async function activarProxy(puerto = 8080) {
  await ps(
    `Set-ItemProperty -Path '${KEY}' -Name ProxyServer -Value '127.0.0.1:${puerto}'; ` +
    `Set-ItemProperty -Path '${KEY}' -Name ProxyOverride -Value '<local>;localhost;127.*;10.*;192.168.*'; ` +
    `Set-ItemProperty -Path '${KEY}' -Name ProxyEnable -Value 1 -Type DWord`);
  await refrescar();
  return true;
}

async function desactivarProxy() {
  await ps(`Set-ItemProperty -Path '${KEY}' -Name ProxyEnable -Value 0 -Type DWord`);
  await refrescar();
  return true;
}

async function proxyActivo() {
  const r = await ps(`(Get-ItemProperty -Path '${KEY}' -Name ProxyEnable -EA SilentlyContinue).ProxyEnable`);
  return r.out === '1';
}

async function certConfiado() {
  const r = await ps("(Get-ChildItem Cert:\\CurrentUser\\Root -EA SilentlyContinue | Where-Object { $_.Issuer -match 'mitmproxy|NetPulse|http-mitm' }).Count");
  return parseInt(r.out || '0', 10) > 0;
}

// Confía el certificado del interceptor en el almacén del USUARIO (no requiere admin)
async function confiarCert(rutaPem) {
  if (!fs.existsSync(rutaPem)) return { ok: false, error: 'Aún no existe el certificado; arranca el interceptor una vez.' };
  if (await certConfiado()) return { ok: true, yaEstaba: true };
  const r = await ps(`Import-Certificate -FilePath '${rutaPem.replace(/\//g, '\\')}' -CertStoreLocation Cert:\\CurrentUser\\Root | Out-Null; 'OK'`);
  const ok = /OK/.test(r.out) || (await certConfiado());
  return ok ? { ok: true } : { ok: false, error: (r.er || r.out || 'No se pudo confiar el certificado').slice(0, 200) };
}

async function olvidarCert() {
  await ps("Get-ChildItem Cert:\\CurrentUser\\Root -EA SilentlyContinue | Where-Object { $_.Issuer -match 'mitmproxy|NetPulse|http-mitm' } | Remove-Item -Force -EA SilentlyContinue");
  return { ok: true };
}

// Revertido síncrono de emergencia (al cerrar el servidor): deja el equipo con internet
function revertirSync() {
  try {
    require('child_process').execSync(
      "powershell -NoProfile -Command \"Set-ItemProperty -Path '" + KEY.replace('HKCU:', 'HKCU:') + "' -Name ProxyEnable -Value 0\"",
      { timeout: 8000, windowsHide: true });
  } catch {}
}

module.exports = { activarProxy, desactivarProxy, proxyActivo, confiarCert, olvidarCert, certConfiado, revertirSync };
