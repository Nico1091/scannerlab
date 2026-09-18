# ScannerLab - Analizador de Red Local

ScannerLab es una aplicación de escaneo de red local que se ejecuta en Windows y muestra en tiempo real información sobre tu conexión WiFi, dispositivos conectados, latencia, velocidad de internet y métricas de red.

Repositorio: https://github.com/Nico1091/scannerlab

---

## Requisitos

- Windows 10 o superior
- [Node.js](https://nodejs.org/) instalado (versión LTS recomendada)
- Conexión a una red WiFi

---

## Instalación desde GitHub

Sigue estos pasos para instalar y ejecutar la aplicación desde el repositorio de GitHub:

### 1. Clonar el repositorio

Abre una terminal (PowerShell o CMD) y ejecuta:

```bash
git clone https://github.com/Nico1091/scannerlab.git
cd Scannerlab
```

Si deseas clonar una rama específica (por ejemplo, `main`):

```bash
git clone -b main https://github.com/Nico1091/scannerlab.git
cd Scannerlab
```

### 2. Instalar dependencias

```bash
npm install
```

> Nota: Si el proyecto no tiene un `package.json` con dependencias externas, este paso puede omitirse ya que usa solo módulos nativos de Node.js.

### 3. Ejecutar el servidor

```bash
node server.js
```

Deberías ver un mensaje como:

```
Servidor escuchando en http://localhost:3001
```

### 4. Abrir en el navegador

Abre tu navegador y ve a:

```
http://localhost:3001
```

La interfaz se cargará automáticamente y comenzará a escanear tu red.

---

## Uso rápido

1. Presiona el botón **Escanear Red** para obtener información de tu conexión WiFi.
2. Presiona **Buscar Dispositivos** para detectar todos los dispositivos conectados en tu red local.
3. Haz clic en cualquier dispositivo para ver información detallada, incluyendo latencia en vivo.
4. Las métricas en la parte superior (señal WiFi, velocidad, latencia, velocidad de internet) se actualizan automáticamente.

---

## Notas

- La aplicación está diseñada para funcionar **únicamente en Windows** porque utiliza comandos como `netsh`, `arp`, `nbtstat` e `ipconfig`.
- No requiere privilegios de administrador para la mayoría de funciones.
- El escaneo se realiza completamente dentro de tu red local.

