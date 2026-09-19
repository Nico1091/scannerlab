<#
.SINOPSIS
    NetPulse — captura con el adaptador USB externo, sin tocar la tarjeta interna.

.DESCRIPCION
    Pasa el adaptador TP-Link a WSL2 y lo pone en modo monitor dentro de un
    contenedor. La Wi-Fi interna nunca se toca: el equipo conserva internet
    durante toda la captura.

    El USB viaja por un tunel SSH inverso, no por el puerto 3240 abierto en el
    cortafuegos. El motivo: el cortafuegos de Hyper-V bloquea de WSL hacia
    Windows, pero permite de Windows hacia WSL. El tunel invierte el sentido y
    asi no hace falta abrir nada ni pedir permisos de administrador.

.EJEMPLOS
    .\netpulse-captura.ps1 estado
    .\netpulse-captura.ps1 iniciar
    .\netpulse-captura.ps1 capturar -Segundos 60
    .\netpulse-captura.ps1 resumen  -Segundos 30
    .\netpulse-captura.ps1 detener
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('estado', 'iniciar', 'capturar', 'resumen', 'detener')]
    [string]$Orden = 'estado',

    [int]$Segundos = 30,
    [int]$Canal = 0
)

$ErrorActionPreference = 'Stop'

$BUSID   = '2-1'                      # TP-Link Wireless USB (2357:0109)
$DISTRO  = 'Ubuntu-26.04'
$IMAGEN  = 'netpulse-captura'
$MAC_INT = 'E8-B0-C5-69-E7-BD'        # Intel AX201 — jamas se toca
$CLAVE   = Join-Path $env:USERPROFILE '.ssh\netpulse2'
$PUERTO  = 2222
$MARCA   = Join-Path $env:TEMP 'netpulse-tunel.pid'
$SALIDA  = Join-Path $env:APPDATA 'NetPulse\captura'

function Info($m) { Write-Host $m -ForegroundColor Cyan }
function Bien($m) { Write-Host $m -ForegroundColor Green }
function Mal($m)  { Write-Host $m -ForegroundColor Red }

function Get-Usbipd {
    $c = Get-Command usbipd -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    $p = Join-Path $env:ProgramFiles 'usbipd-win\usbipd.exe'
    if (Test-Path $p) { return $p }
    throw 'usbipd no esta instalado: winget install dorssel.usbipd-win'
}

function Get-IpWsl {
    (& wsl -d $DISTRO -u root -- hostname -I).Trim().Split(' ')[0]
}

function Wsl-Root {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Cmd)
    & wsl -d $DISTRO -u root -- @Cmd
}

# Comprueba que la Wi-Fi interna sigue conectada. Es la garantia de que el
# equipo no se queda sin internet, el motivo de rehacer toda la captura.
function Test-InternetIntacto {
    $i = Get-NetAdapter | Where-Object { $_.MacAddress -eq $MAC_INT }
    if ($i -and $i.Status -eq 'Up') { Bien "  internet intacto: $($i.Name) conectada"; return $true }
    Mal "  ATENCION: la tarjeta interna esta '$($i.Status)'"
    return $false
}

function Start-Tunel {
    if (Test-Path $MARCA) {
        $vp = Get-Process -Id (Get-Content $MARCA) -ErrorAction SilentlyContinue
        if ($vp) { return }           # ya hay tunel vivo
        Remove-Item $MARCA -Force
    }
    $ip = Get-IpWsl
    $p = Start-Process ssh -PassThru -WindowStyle Hidden -ArgumentList @(
        '-i', $CLAVE, '-p', $PUERTO,
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=NUL',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15',
        '-N', '-R', '127.0.0.1:3240:127.0.0.1:3240',
        "root@$ip"
    )
    $p.Id | Set-Content $MARCA
    Start-Sleep -Seconds 3
}

function Stop-Tunel {
    if (-not (Test-Path $MARCA)) { return }
    Get-Process -Id (Get-Content $MARCA) -ErrorAction SilentlyContinue | Stop-Process -Force
    Remove-Item $MARCA -Force -ErrorAction SilentlyContinue
}

function Invoke-Contenedor {
    param([Parameter(ValueFromRemainingArguments)][string[]]$Cmd)
    if (-not (Test-Path $SALIDA)) { New-Item -ItemType Directory -Path $SALIDA -Force | Out-Null }
    $montaje = (& wsl -d $DISTRO -- wslpath -a ($SALIDA -replace '\', '/')).Trim()
    Wsl-Root docker run --rm --network host --cap-add NET_ADMIN --cap-add NET_RAW `
        -v "${montaje}:/captura/salida" $IMAGEN @Cmd
}

function Orden-Estado {
    Info '=== Adaptador en Windows ==='
    & (Get-Usbipd) list | Select-String -Pattern $BUSID, 'BUSID'
    Info ''
    Info '=== Tarjeta interna ==='
    Test-InternetIntacto | Out-Null
    Info ''
    Info '=== Dentro de WSL2 ==='
    Invoke-Contenedor estado
}

function Orden-Iniciar {
    $usbipd = Get-Usbipd

    $linea = & $usbipd list | Select-String -Pattern "^$BUSID\s"
    if ($linea -and $linea -notmatch 'Shared') {
        Mal "El adaptador no esta compartido. Una sola vez, como administrador:"
        Mal "    usbipd bind --busid $BUSID"
        exit 1
    }

    Info 'Abriendo el tunel hacia WSL2...'
    Start-Tunel

    Info 'Conectando el adaptador a Linux...'
    Wsl-Root /usr/local/sbin/usbip attach -r 127.0.0.1 -b $BUSID
    if ($LASTEXITCODE -ne 0) { Mal 'No se pudo conectar el adaptador.'; Stop-Tunel; exit 1 }
    Start-Sleep -Seconds 5

    Info 'Poniendo el adaptador en modo monitor...'
    Invoke-Contenedor monitor
    if ($Canal -gt 0) { Invoke-Contenedor canal "$Canal" }

    Info ''
    Test-InternetIntacto | Out-Null
}

function Orden-Capturar {
    Info "Capturando $Segundos segundos..."
    Invoke-Contenedor capturar "$Segundos"
    Info "Los archivos quedan en: $SALIDA"
    Test-InternetIntacto | Out-Null
}

function Orden-Resumen {
    Info "Resumiendo $Segundos segundos de trafico..."
    Invoke-Contenedor resumen "$Segundos"
    Info "Los archivos quedan en: $SALIDA"
}

function Orden-Detener {
    Info 'Devolviendo el adaptador a modo normal...'
    try { Invoke-Contenedor gestionado } catch { }
    Info 'Desconectando el adaptador de Linux...'
    try { Wsl-Root /usr/local/sbin/usbip detach -p 00 } catch { }
    Stop-Tunel
    Bien 'Listo. El adaptador vuelve a estar en Windows.'
    Test-InternetIntacto | Out-Null
}

switch ($Orden) {
    'estado'   { Orden-Estado }
    'iniciar'  { Orden-Iniciar }
    'capturar' { Orden-Capturar }
    'resumen'  { Orden-Resumen }
    'detener'  { Orden-Detener }
}
