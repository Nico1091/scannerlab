# NetPulse — contenedor de captura en modo monitor
#
# Aisla las herramientas de captura para no ensuciar el Ubuntu de WSL2.
# NO aporta drivers: el modulo rtl8xxxu vive en el kernel de WSL2, que este
# contenedor comparte. Aqui solo viven iw, tcpdump, tshark y aircrack-ng.
#
# Se ejecuta con --network host --cap-add NET_ADMIN --cap-add NET_RAW
# para poder ver y gobernar la interfaz inalambrica del anfitrion WSL.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      iw \
      iproute2 \
      wireless-tools \
      tcpdump \
      tshark \
      aircrack-ng \
      usbutils \
      python3 \
      python3-scapy \
      ca-certificates \
      procps \
 && rm -rf /var/lib/apt/lists/*

# tshark se niega a capturar como root si no se le autoriza en la instalacion
RUN echo "wireshark-common wireshark-common/install-setuid boolean true" | debconf-set-selections

WORKDIR /captura
COPY monitor.sh /usr/local/bin/monitor
RUN chmod +x /usr/local/bin/monitor

# Las capturas salen a un volumen montado, nunca a la imagen
VOLUME ["/captura/salida"]

ENTRYPOINT ["/usr/local/bin/monitor"]
CMD ["estado"]
