# mitm_addon.py — Addon de mitmproxy para NetPulse AI
# Registra cada peticion/respuesta HTTPS ya DESCIFRADA en un archivo JSONL que
# el servidor de NetPulse lee en vivo, y guarda las imagenes reales del trafico
# en disco para mostrarlas en el muro visual.
#
# Se ejecuta con:  mitmdump -s mitm_addon.py --listen-port 8080
#
# Solo intercepta el trafico de ESTE equipo (tu PC), enrutado por el proxy.

import json
import os
import time
import hashlib

BASE = os.path.dirname(os.path.abspath(__file__))
CAP_DIR = os.path.join(BASE, "captura")
IMG_DIR = os.path.join(CAP_DIR, "img")
FLOWS = os.path.join(CAP_DIR, "flows.jsonl")

os.makedirs(IMG_DIR, exist_ok=True)

# Limites para no llenar el disco
MAX_IMG_BYTES = 3 * 1024 * 1024      # no guardar imagenes > 3 MB
MAX_IMG_TOTAL = 400                    # tope de imagenes guardadas
EXT = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
       "image/webp": "webp", "image/svg+xml": "svg", "image/x-icon": "ico",
       "image/vnd.microsoft.icon": "ico", "image/bmp": "bmp", "image/avif": "avif"}

_img_count = 0


def _append(rec):
    try:
        with open(FLOWS, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _categoria(ctype, host):
    ct = (ctype or "").lower()
    if ct.startswith("image/"):
        return "imagen"
    if "json" in ct or "javascript" in ct or ct.startswith("application/"):
        return "api/datos"
    if ct.startswith("text/html"):
        return "pagina"
    if ct.startswith("text/css"):
        return "estilo"
    if ct.startswith("video/") or "mpegurl" in ct:
        return "video"
    if ct.startswith("audio/"):
        return "audio"
    if "font" in ct:
        return "fuente"
    return "otro"


def response(flow):
    global _img_count
    try:
        req = flow.request
        resp = flow.response
        ctype = resp.headers.get("content-type", "").split(";")[0].strip()
        host = req.pretty_host
        size = len(resp.raw_content) if resp.raw_content else 0

        rec = {
            "ts": time.time(),
            "metodo": req.method,
            "host": host,
            "ruta": req.path[:300],
            "url": req.pretty_url[:500],
            "esquema": req.scheme,
            "status": resp.status_code,
            "tipo": ctype,
            "categoria": _categoria(ctype, host),
            "bytes": size,
        }

        # Cuerpo de peticion legible (formularios / JSON / busquedas)
        if req.method in ("POST", "PUT", "PATCH"):
            try:
                body = req.get_text(strict=False) or ""
                if body and len(body) < 2000 and ("json" in req.headers.get("content-type", "").lower()
                                                   or "form" in req.headers.get("content-type", "").lower()):
                    rec["cuerpo"] = body[:1500]
            except Exception:
                pass

        # Guardar imagenes reales del trafico
        if ctype in EXT and 0 < size <= MAX_IMG_BYTES and _img_count < MAX_IMG_TOTAL:
            try:
                h = hashlib.md5(resp.raw_content).hexdigest()[:16]
                fname = h + "." + EXT[ctype]
                fpath = os.path.join(IMG_DIR, fname)
                if not os.path.exists(fpath):
                    with open(fpath, "wb") as im:
                        im.write(resp.raw_content)
                    _img_count += 1
                rec["imagen"] = "img/" + fname
            except Exception:
                pass

        _append(rec)
    except Exception:
        pass


def load(loader):
    # Reiniciar el archivo de flujos al arrancar una sesion nueva
    try:
        open(FLOWS, "w").close()
    except Exception:
        pass
