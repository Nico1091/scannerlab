#!/bin/bash
# NetPulse — deja el firmware del adaptador externo donde el kernel de WSL lo encuentra.
#
# El kernel de WSL2 busca el firmware en SU propio espacio de archivos inicial, que no
# es el de Ubuntu. Por eso /lib/firmware no le sirve aunque el archivo este ahi: la
# depuracion del cargador lo enseña intentando /lib/firmware/... y fallando, porque en
# ese espacio no existe. El tmpfs /mnt/wsl si es comun a los dos, y es la unica ruta
# por la que el kernel alcanza el archivo. Como es un tmpfs, se vacia en cada arranque
# de WSL y hay que rehacerlo: de ahi que esto corra como servicio.
#
# Ademas el firmware de Ubuntu viene comprimido en .zst, y este kernel solo sabe
# descomprimir .xz (CONFIG_FW_LOADER_COMPRESS_ZSTD no esta activado), asi que hay que
# dejarlo descomprimido.

set -u

DESTINO=/mnt/wsl/fw/rtlwifi
ORIGEN=/usr/lib/firmware/rtlwifi

mkdir -p "$DESTINO"

for f in rtl8192eu_nic rtl8192eu_wowlan; do
    if [ ! -f "$ORIGEN/$f.bin" ] && [ -f "$ORIGEN/$f.bin.zst" ]; then
        zstd -d -f -q "$ORIGEN/$f.bin.zst" -o "$ORIGEN/$f.bin" 2>/dev/null
    fi
    if [ -f "$ORIGEN/$f.bin" ]; then
        cp -f "$ORIGEN/$f.bin" "$DESTINO/"
    fi
done

printf '/mnt/wsl/fw' > /sys/module/firmware_class/parameters/path

echo "firmware en $DESTINO ($(ls -1 "$DESTINO" | wc -l) archivos); ruta del kernel: $(cat /sys/module/firmware_class/parameters/path)"
