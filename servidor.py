# =============================================================================
# servidor.py — servidor local de ODISEA-IX SIN CACHÉ.
# El navegador guarda los módulos JavaScript de forma agresiva; con este
# servidor cada archivo se entrega con "Cache-Control: no-store", así que tras
# cualquier actualización siempre se ejecuta el código nuevo.
# Uso: python servidor.py   (o doble clic en INICIAR.bat)
# =============================================================================
import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 8765


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    # Sin ETag/Last-Modified: nada que el navegador pueda revalidar desde caché.
    def send_header(self, keyword, value):
        if keyword.lower() in ("last-modified", "etag"):
            return
        super().send_header(keyword, value)


NoCacheHandler.extensions_map.update({".js": "text/javascript", ".mjs": "text/javascript"})


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    port = PORT
    for _ in range(10):
        try:
            httpd = Server(("127.0.0.1", port), NoCacheHandler)
            break
        except OSError:
            port += 1
    else:
        print("No hay puertos libres entre", PORT, "y", PORT + 9)
        return
    url = f"http://localhost:{port}/"
    print(f"ODISEA-IX en {url}  (sin caché; Ctrl+C para detener)")
    if "--no-open" not in sys.argv:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
