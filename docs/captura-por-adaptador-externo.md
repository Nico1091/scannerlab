# NetPulse — la captura debe hacerse con el adaptador externo

> [!warning] No implementado. Esto es el encargo, escrito para diseñarlo antes de tocar código.

## Lo que está mal hoy

La intercepción, tal como quedó tras la Fase 1, **no sirve para lo que se quiere**:

1. **Solo capta lo que pasa dentro del computador.** Todo lo que ve es el tráfico
   del propio equipo, descifrado por el proxy. De la red de fuera no ve nada.
2. **Usa la tarjeta de red interna.** No debe. Debe usar **solo la externa**.
3. **Deja el computador sin internet** mientras captura, porque enruta todo el
   sistema por el proxy. Eso no puede volver a pasar.
4. No está usando la memoria USB externa, que es justamente la que tiene **modo
   monitor** y la que debería hacer el trabajo.

## Lo que se quiere

- Capturar **fuera y dentro** del computador.
- Hacerlo con el **adaptador USB externo en modo monitor**, no con el proxy que
  secuestra la conexión del sistema.
- Que el equipo **conserve internet** durante toda la captura.
- Vía sugerida por Nicolás: **WSL2**, o lo que haga falta para que el modo
  monitor funcione.

## El hardware, verificado hoy

| | Adaptador | Identificación | Estado |
|---|---|---|---|
| **Interna — no usar** | Wi-Fi | Intel Wi-Fi 6 AX201 · `E8-B0-C5-69-E7-BD` | conectada a "Laura Montoya 2" |
| **Externa — la que debe usarse** | Wi-Fi 2 | TP-Link Wireless USB · `98-25-4A-D4-B1-D2` | desconectada |

WSL2 ya está en el equipo y en uso (ahí vive serena, ver notas de WSL2),
y hay un `vEthernet (WSL)` levantado.

## La tensión que hay que resolver al diseñarlo

El plan de mejora dio por cerrado que **el modo monitor no existe en este Windows**:
el TP-Link (RTL8192EU) con Npcap no declara `Dot11Support`. Ese dato se verificó en
su momento y es cierto **para Windows**. El encargo de hoy no lo contradice: lo que
pide es **sacar la captura de Windows**.

La vía que hay que estudiar, en este orden:

1. **`usbipd-win` + WSL2.** Pasar el adaptador USB entero a la máquina Linux, donde
   el controlador del RTL8192xx sí admite `iw dev ... set type monitor`. Windows
   deja de ver ese adaptador mientras dura la captura — y por eso **la Wi-Fi interna
   sigue dando internet sin tocarla**, que es justo lo que se pide.
2. **Comprobar el chip de verdad antes de prometer nada.** RTL8192EU tiene soporte
   de monitor irregular según el controlador (`rtl8xxxu` del núcleo frente a los
   `8192eu` de terceros). Hay que verificarlo en la máquina Linux, no suponerlo.
3. **Qué se obtiene y qué no.** En modo monitor se ven **todos los equipos de la
   red**, pero cifrado: tramas 802.11, quién habla con quién, cuánto y cuándo.
   El contenido descifrado **solo** se consigue con el proxy, y solo del propio PC.
   Son dos fuentes distintas, y la herramienta debería mostrar ambas sin mezclarlas.
4. **Dentro del computador, sin cortar internet.** Para lo propio ya no hace falta
   el proxy del sistema: basta leer las conexiones del sistema operativo, que es lo
   que hace hoy la pestaña de telemetría, o capturar en el bucle local. El proxy
   pasa a ser **opcional y explícito**, nunca el camino por defecto.

## Cómo encaja con el plan

Esto **reabre la restricción** que el plan daba por cerrada y se antepone a las
fases 2–5. Antes de escribir una línea hay que decidir la arquitectura: dónde corre
la captura (WSL2), cómo llega lo capturado a la interfaz, y cómo conviven las dos
fuentes.

## Relacionado

- Fase 1 del plan de mejora: ya ejecutada (rama `fase-1-seguridad`).

---

## 2026-09-19 — Arquitectura acordada y vía abierta

**Decisión de Nicolás:** la captura corre en **WSL2**, encapsulada en **Docker**,
dedicada solo a eso. La vía por la que los datos llegan a la interfaz de NetPulse
se decide al implementar.

**Matiz que hubo que corregir:** Docker en Windows corre sobre el *mismo* kernel de
WSL2. Un contenedor **no aporta drivers**: el módulo del TP-Link se necesitaba a
nivel de WSL2 igual. Docker sirve para **aislar las herramientas** (iw, tcpdump,
aircrack), no para resolver el driver.

### Lo que estaba cerrado y ya no lo está

El kernel de WSL2 que publica Microsoft viene recortado: en `net/wireless` solo trae
`intel` y `rsi`. **No existía driver para el TP-Link.** Eso parecía cerrar la vía.

No la cerraba. El driver `rtl8xxxu` del núcleo **sí soporta este chip** —
`0x2357, 0x0109` figura en su tabla — y `mac80211` **añade el modo monitor a todos
los drivers que lo usan** (`net/mac80211/main.c:1353`). Faltaba compilar el módulo,
no cambiar de plan.

### El error que no hay que repetir

Se empezó compilando **el kernel entero** con 16 núcleos. Es innecesario y castiga el
equipo. Basta compilar **solo el módulo** contra las fuentes, con 2 núcleos y prioridad
mínima: unos minutos, sin calentar la máquina, y **sin reemplazar el kernel**.

    make modules_prepare
    make M=drivers/net/wireless/realtek/rtl8xxxu modules KBUILD_MODPOST_WARN=1

Dos trampas dentro de eso:

- **Faltan `Module.symvers`**, así que `modpost` falla por símbolos indefinidos.
  `KBUILD_MODPOST_WARN=1` los deja para resolver en la carga, que es donde se
  resuelven de verdad. El módulo cargó limpio, sin forzar nada.
- **El vermagic salía con un `+`** (`...WSL2+`) y el kernel lo habría rechazado. Lo
  añade `scripts/setlocalversion` al ver un repositorio git sin etiqueta limpia.
  Se quita **renombrando `.git`** del árbol; un `.scmversion` vacío no basta.

### El cortafuegos, y cómo se esquivó sin abrirlo

`usbipd attach --wsl` falla: el **cortafuegos de Hyper-V** trae
`DefaultInboundAction = Block`, y WSL no alcanza el puerto 3240 de Windows. La
solución habitual es abrir ese puerto, pero **Nicolás lo rechazó por excesivo**.

Se comprobó que **el sentido contrario sí está permitido**: de Windows hacia WSL. De
ahí la vía definitiva, un **túnel SSH inverso**:

    ssh -N -R 127.0.0.1:3240:127.0.0.1:3240 root@<ip-wsl>

Windows abre la conexión, y el puerto del USB aparece *dentro* de Linux. **No se abre
ningún puerto, no se toca el cortafuegos y no hace falta administrador.** El servidor
SSH escucha en el 2222, solo por clave, sin contraseñas.

Hubo que compilar también el cliente `usbip` (`tools/usb/usbip` del propio kernel):
el de Ubuntu es un envoltorio que exige paquetes inexistentes para este kernel.

### Lo que queda instalado y configurado

| Pieza | Estado |
|---|---|
| `usbipd-win` 5.3.0 | instalado; adaptador `Shared` en el bus `2-1` |
| `rtl8xxxu.ko` | compilado y **cargado**; carga sola al arrancar WSL |
| `vhci-hcd` | cargado; carga solo al arrancar WSL |
| firmware `rtl8192eu_nic.bin` | instalado |
| cliente `usbip` | compilado en `/usr/local/sbin/usbip` |
| Docker Engine 29.8.1 | dentro de WSL2, arranca solo |
| Imagen `netpulse-captura` | construida |
| SSH (puerto 2222, solo clave) | arranca solo |
| Wi-Fi interna | **intacta**: nunca se tocó |

Verificado en vivo: Linux **ve el adaptador** por el túnel
(`TL-WN823N v2/v3 [Realtek RTL8192EU]`) y el USB **entra** en Linux
(`vhci_hcd: Device attached`).

### Lo único que falta comprobar

Tras el `attach`, la enumeración USB **se quedó a medias**: el último mensaje del
núcleo es `SetAddress Request`, y no llega el `New USB device found` que precede a
la carga del driver. Faltaba el firmware, que **ya está instalado**; hay que repetir
el `attach` y mirar el `dmesg`. Si el atasco persiste, la sospecha es la latencia del
túnel durante la enumeración, y se prueba con `-o Compression=no` o pasando el
dispositivo con el adaptador ya alimentado.

**No se dejó nada corriendo**: el adaptador está devuelto a Windows y el túnel cerrado.

### Cómo se usa (cuando haya alguien delante)

    cd Desktop\scannerlab\captura-externa
    .\netpulse-captura.ps1 estado
    .\netpulse-captura.ps1 iniciar
    .\netpulse-captura.ps1 resumen -Segundos 30
    .\netpulse-captura.ps1 detener

`monitor.sh` se niega a tocar la tarjeta interna: la compara por MAC y aborta.
