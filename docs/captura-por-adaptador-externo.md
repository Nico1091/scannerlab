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
