#!/usr/bin/env python3
"""Voicebank local server (Python standard library only).

* Serves the mobile web app from ./app over HTTPS (self-signed cert, so phones
  on your Wi-Fi get microphone access) or plain HTTP on localhost.
* PUT /api/upload  saves recordings into ./dataset (wavs/ + metadata files).
* POST /api/tts    speaks text with your trained Piper voice (--model).

Usage:
    python3 server.py                                  # HTTPS on :8443
    python3 server.py --model voices/me.onnx           # + text-to-speech in your voice
    python3 server.py --http --port 8000               # plain HTTP (localhost only for mic)
"""

import argparse
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_UPLOAD = 20 * 1024 * 1024
MAX_TTS_CHARS = 2000
lock = threading.Lock()


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(cert_dir: Path, ip: str):
    cert, key = cert_dir / "cert.pem", cert_dir / "key.pem"
    if cert.exists() and key.exists():
        return cert, key
    if not shutil.which("openssl"):
        sys.exit("openssl not found. Install it, pass --cert/--key, or use --http on localhost.")
    cert_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
            "-days", "825", "-keyout", str(key), "-out", str(cert),
            "-subj", "/CN=voicebank.local",
            "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
        ],
        check=True,
        capture_output=True,
    )
    print(f"Created self-signed certificate in {cert_dir}")
    return cert, key


class Dataset:
    def __init__(self, path: Path):
        self.path = path
        self.wavs = path / "wavs"
        self.wavs.mkdir(parents=True, exist_ok=True)
        self.index_file = path / "transcripts.json"
        self.index = json.loads(self.index_file.read_text("utf-8")) if self.index_file.exists() else {}

    def save(self, utt_id: str, text: str, wav: bytes):
        with lock:
            tmp = self.wavs / f".{utt_id}.tmp"
            tmp.write_bytes(wav)
            tmp.replace(self.wavs / f"{utt_id}.wav")
            self.index[utt_id] = text
            self._write()

    def _write(self):
        items = sorted(self.index.items())
        clean = [(i, " ".join(t.replace("|", " ").split())) for i, t in items]
        self.index_file.write_text(json.dumps(self.index, indent=1, ensure_ascii=False), "utf-8")
        # Classic Piper / LJSpeech single speaker: id|text
        (self.path / "metadata.csv").write_text("".join(f"{i}|{t}\n" for i, t in clean), "utf-8")
        # Filename variant: id.wav|text
        (self.path / "metadata_files.csv").write_text("".join(f"{i}.wav|{t}\n" for i, t in clean), "utf-8")
        # Coqui TTS "ljspeech" formatter: id|text|normalized text
        (self.path / "metadata_coqui.csv").write_text("".join(f"{i}|{t}|{t}\n" for i, t in clean), "utf-8")


def make_handler(args, dataset: Dataset):
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(APP_DIR), **kw)

        def log_message(self, fmt, *a):
            if args.verbose or not self.path.startswith(("/api/upload",)):
                super().log_message(fmt, *a)

        def end_headers(self):
            if args.cors:
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
            if self.path.endswith((".js", ".html", "/")):
                self.send_header("Cache-Control", "no-cache")
            super().end_headers()

        def reply(self, code, body, ctype="text/plain; charset=utf-8"):
            data = body if isinstance(body, bytes) else body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def read_body(self, limit):
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > limit:
                raise ValueError("bad body size")
            return self.rfile.read(n)

        def do_OPTIONS(self):
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            if urlparse(self.path).path == "/api/status":
                return self.reply(
                    200,
                    json.dumps({"ok": True, "tts": bool(args.model), "recordings": len(dataset.index)}),
                    "application/json",
                )
            return super().do_GET()

        def do_PUT(self):
            url = urlparse(self.path)
            if url.path != "/api/upload":
                return self.reply(404, "not found")
            q = parse_qs(url.query)
            utt_id = (q.get("id") or [""])[0]
            text = (q.get("text") or [""])[0].strip()
            if not ID_RE.match(utt_id) or not text:
                return self.reply(400, "missing or invalid id/text")
            try:
                wav = self.read_body(MAX_UPLOAD)
            except ValueError as e:
                return self.reply(400, str(e))
            if wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
                return self.reply(400, "not a WAV file")
            dataset.save(utt_id, text, wav)
            return self.reply(200, "ok")

        def do_POST(self):
            if urlparse(self.path).path != "/api/tts":
                return self.reply(404, "not found")
            if not args.model:
                return self.reply(503, "no voice model loaded (start server.py with --model)")
            try:
                text = json.loads(self.read_body(64 * 1024)).get("text", "").strip()
            except (ValueError, AttributeError):
                return self.reply(400, "bad request")
            if not text or len(text) > MAX_TTS_CHARS:
                return self.reply(400, f"text must be 1-{MAX_TTS_CHARS} characters")
            with tempfile.TemporaryDirectory() as td:
                out = Path(td) / "out.wav"
                cmd = [a.replace("{model}", args.model).replace("{out}", str(out)) for a in args.tts_cmd.split()]
                try:
                    proc = subprocess.run(cmd, input=text.encode("utf-8"), capture_output=True, timeout=120)
                except (OSError, subprocess.TimeoutExpired) as e:
                    return self.reply(500, f"TTS failed to run: {e}")
                if proc.returncode != 0 or not out.exists():
                    return self.reply(500, "TTS error: " + proc.stderr.decode("utf-8", "replace")[-500:])
                return self.reply(200, out.read_bytes(), "audio/wav")

    return Handler


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=None, help="default 8443 (https) / 8000 (http)")
    p.add_argument("--http", action="store_true", help="serve plain HTTP (mic only works via localhost)")
    p.add_argument("--cert", help="TLS certificate (PEM); default: auto-generated self-signed")
    p.add_argument("--key", help="TLS private key (PEM)")
    p.add_argument("--dataset", default=str(ROOT / "dataset"), help="where uploads are stored")
    p.add_argument("--model", help="Piper .onnx voice model for /api/tts (its .onnx.json must sit next to it)")
    p.add_argument(
        "--tts-cmd",
        default=f"{sys.executable} -m piper --model {{model}} --output_file {{out}}",
        help="command that reads text on stdin and writes {out}; {model} is replaced too. "
        "For the standalone binary use: 'piper --model {model} --output_file {out}'",
    )
    p.add_argument("--cors", action="store_true", help="allow other origins (if the app is hosted elsewhere)")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args()

    if args.model and not Path(args.model).exists():
        sys.exit(f"model not found: {args.model}")
    if args.model:
        args.model = str(Path(args.model).resolve())

    dataset = Dataset(Path(args.dataset).resolve())
    ip = lan_ip()
    port = args.port or (8000 if args.http else 8443)
    httpd = ThreadingHTTPServer((args.host, port), make_handler(args, dataset))
    scheme = "http"
    if not args.http:
        cert, key = (args.cert, args.key) if args.cert else ensure_cert(ROOT / ".certs", ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    print(f"\nVoicebank running.")
    print(f"  On this computer : {scheme}://localhost:{port}")
    print(f"  On your phone    : {scheme}://{ip}:{port}   (same Wi-Fi)")
    if scheme == "https":
        print("  The certificate is self-signed: accept the browser warning once.")
    else:
        print("  Note: phones need HTTPS for the microphone; drop --http for LAN use.")
    print(f"  Dataset folder   : {dataset.path}  ({len(dataset.index)} recordings)")
    print(f"  Voice model      : {args.model or 'none (Speak tab will use other engines)'}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
