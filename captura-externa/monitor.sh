#!/bin/bash
# NetPulse — gobierno de la captura en modo monitor.
#
# Ordenes:
#   estado              muestra que adaptadores hay y en que modo estan
#   monitor [iface]     pone el adaptador en modo monitor
#   gestionado [iface]  lo devuelve a modo normal
#   canal <n> [iface]   fija el canal de escucha
#   capturar [seg]      captura tramas 802.11 a un pcap en /captura/salida
#   resumen [seg]       captura y resume quien habla con quien, en JSON
#
# No toca jamas la tarjeta interna: solo actua sobre el adaptador USB.

set -uo pipefail

# MAC del adaptador externo autorizado (TP-Link USB). La interna queda excluida.
MAC_EXTERNA="98:25:4a:d4:b1:d2"
MAC_INTERNA="e8:b0:c5:69:e7:bd"
SALIDA="/captura/salida"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }

# Descubre la interfaz inalambrica del adaptador externo por su MAC.
# Si no la halla por MAC, toma la unica wlan que exista, pero nunca la interna.
detectar_iface() {
    local candidata="" mac
    for d in /sys/class/net/*; do
        [ -e "$d/wireless" ] || [ -e "$d/phy80211" ] || continue
        local n; n=$(basename "$d")
        mac=$(cat "$d/address" 2>/dev/null | tr 'A-Z' 'a-z')
        if [ "$mac" = "$MAC_EXTERNA" ]; then echo "$n"; return 0; fi
        if [ "$mac" = "$MAC_INTERNA" ]; then continue; fi
        candidata="$n"
    done
    [ -n "$candidata" ] && { echo "$candidata"; return 0; }
    return 1
}

# Comprueba que la interfaz pedida no es la tarjeta interna.
verificar_no_interna() {
    local iface="$1" mac
    mac=$(cat "/sys/class/net/$iface/address" 2>/dev/null | tr 'A-Z' 'a-z')
    if [ "$mac" = "$MAC_INTERNA" ]; then
        rojo "NEGADO: $iface es la tarjeta interna ($mac). Solo se usa la externa."
        exit 3
    fi
}

iface_o_morir() {
    local iface="${1:-}"
    [ -z "$iface" ] && iface=$(detectar_iface)
    if [ -z "$iface" ]; then
        rojo "No hay ningun adaptador inalambrico externo visible."
        echo "Comprueba que el USB esta pasado a WSL:  usbipd attach --wsl --busid 2-1"
        exit 2
    fi
    verificar_no_interna "$iface"
    echo "$iface"
}

cmd_estado() {
    echo "=== Adaptadores inalambricos visibles ==="
    local hay=0
    for d in /sys/class/net/*; do
        [ -e "$d/wireless" ] || [ -e "$d/phy80211" ] || continue
        hay=1
        local n mac modo
        n=$(basename "$d")
        mac=$(cat "$d/address" 2>/dev/null | tr 'A-Z' 'a-z')
        modo=$(iw dev "$n" info 2>/dev/null | awk '/type/{print $2}')
        local etiqueta="externo"
        [ "$mac" = "$MAC_INTERNA" ] && etiqueta="INTERNO - no usar"
        printf "  %-10s %s  modo=%-10s (%s)\n" "$n" "$mac" "${modo:-?}" "$etiqueta"
    done
    [ "$hay" = 0 ] && rojo "  ninguno (el USB no esta pasado a WSL)"
    echo
    echo "=== Driver ==="
    # lsmod dentro del contenedor no ve los modulos del anfitrion: hay que
    # preguntarle a /proc/modules, que si esta compartido con el.
    if grep -q '^rtl8xxxu ' /proc/modules 2>/dev/null; then
        verde "  rtl8xxxu cargado"
    else
        echo "  rtl8xxxu NO cargado"
    fi
}

cmd_monitor() {
    local iface; iface=$(iface_o_morir "${1:-}") || exit $?
    echo "Poniendo $iface en modo monitor..."
    ip link set "$iface" down
    if iw dev "$iface" set type monitor 2>/dev/null; then
        ip link set "$iface" up
        verde "OK: $iface en modo monitor."
        iw dev "$iface" info
    else
        ip link set "$iface" up
        rojo "FALLO: el driver no acepta modo monitor en $iface."
        exit 4
    fi
}

cmd_gestionado() {
    local iface; iface=$(iface_o_morir "${1:-}") || exit $?
    ip link set "$iface" down
    iw dev "$iface" set type managed 2>/dev/null
    ip link set "$iface" up
    verde "OK: $iface devuelto a modo normal."
}

cmd_canal() {
    local canal="${1:?falta el numero de canal}"
    local iface; iface=$(iface_o_morir "${2:-}") || exit $?
    iw dev "$iface" set channel "$canal" && verde "OK: $iface escuchando el canal $canal."
}

cmd_capturar() {
    local seg="${1:-30}"
    local iface; iface=$(iface_o_morir "${2:-}") || exit $?
    mkdir -p "$SALIDA"
    local archivo="$SALIDA/captura-$(date +%Y%m%d-%H%M%S).pcap"
    echo "Capturando $seg s en $iface -> $archivo"
    timeout "$seg" tcpdump -i "$iface" -w "$archivo" -U 2>&1 | tail -3
    if [ -s "$archivo" ]; then
        verde "OK: $(du -h "$archivo" | cut -f1) en $archivo"
    else
        rojo "Sin tramas. Revisa que el adaptador este en modo monitor."
    fi
}

# Resume la captura en JSON: que equipos se oyen y cuanto hablan.
# Es lo que NetPulse consumira; el contenido va cifrado, los metadatos no.
cmd_resumen() {
    local seg="${1:-20}"
    local iface; iface=$(iface_o_morir "${2:-}") || exit $?
    mkdir -p "$SALIDA"
    local tmp="/tmp/resumen-$$.pcap"
    timeout "$seg" tcpdump -i "$iface" -w "$tmp" -U >/dev/null 2>&1
    local destino="$SALIDA/resumen-$(date +%Y%m%d-%H%M%S).json"
    python3 - "$tmp" "$destino" <<'PY'
import sys, json, collections, datetime
from scapy.all import PcapReader, Dot11, Dot11Beacon, Dot11Elt

origen, destino = sys.argv[1], sys.argv[2]
equipos = collections.defaultdict(lambda: {"tramas": 0, "bytes": 0, "visto": None})
redes = {}
total = 0
try:
    with PcapReader(origen) as f:
        for p in f:
            if not p.haslayer(Dot11):
                continue
            total += 1
            d = p[Dot11]
            for mac in (d.addr1, d.addr2):
                if not mac or mac == "ff:ff:ff:ff:ff:ff":
                    continue
                e = equipos[mac]
                e["tramas"] += 1
                e["bytes"] += len(p)
                e["visto"] = float(p.time)
            if p.haslayer(Dot11Beacon) and d.addr2:
                try:
                    ssid = p[Dot11Elt].info.decode(errors="replace")
                    if ssid:
                        redes[d.addr2] = ssid
                except Exception:
                    pass
except Exception as err:
    print("aviso al leer el pcap:", err, file=sys.stderr)

salida = {
    "generado": datetime.datetime.now().isoformat(timespec="seconds"),
    "fuente": "adaptador-externo-monitor",
    "tramas_totales": total,
    "redes": [{"bssid": b, "ssid": s} for b, s in sorted(redes.items())],
    "equipos": sorted(
        ({"mac": m, **v} for m, v in equipos.items()),
        key=lambda x: x["tramas"], reverse=True,
    )[:200],
}
with open(destino, "w", encoding="utf-8") as f:
    json.dump(salida, f, ensure_ascii=False, indent=2)
print(f"{total} tramas, {len(equipos)} equipos, {len(redes)} redes -> {destino}")
PY
    rm -f "$tmp"
}

orden="${1:-estado}"; shift 2>/dev/null || true
case "$orden" in
    estado)     cmd_estado ;;
    monitor)    cmd_monitor "$@" ;;
    gestionado) cmd_gestionado "$@" ;;
    canal)      cmd_canal "$@" ;;
    capturar)   cmd_capturar "$@" ;;
    resumen)    cmd_resumen "$@" ;;
    shell)      exec /bin/bash ;;
    *)          echo "Orden desconocida: $orden"; sed -n '3,12p' "$0"; exit 1 ;;
esac
