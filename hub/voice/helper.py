"""The Crux hub's voice helper (decision 61 A).

Listening: NVIDIA Parakeet TDT 0.6B v3 (CC BY 4.0) through onnx-asr, on the CPU.
Speaking: Phonon 31M English (Apache 2.0) through ptts, voice Imogen, on the CPU.

The hub starts this only while its voice switch is on, with:
  python -I helper.py            serve: load both models, listen on 127.0.0.1 at a port Windows picks, print
                                 {"ready": true, "port": N} as one line, and exit when the hub closes stdin
  python -I helper.py --setup    download both models (and the voice) once, then exit
Environment: HF_HOME (where the models live), CRUX_VOICE_KEY (serve: every request must carry it in X-Voice-Key).

Audio is never written to disk: clips come in as request bodies and speech goes out as response bodies.
"""

import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ASR_MODEL = "nemo-parakeet-tdt-0.6b-v3"
ASR_QUANT = "int8"
TTS_LANG = "en"
TTS_VOICE = "Imogen"
LISTEN_RATE = 16000          # the page sends 16 kHz, 16-bit, mono
MAX_CLIP_S = 60
MAX_SAY_CHARS = 600
THREADS = os.cpu_count() or 4


def say_line(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def load_asr():
    import onnxruntime as rt
    import onnx_asr
    opts = rt.SessionOptions()
    opts.intra_op_num_threads = THREADS
    return onnx_asr.load_model(ASR_MODEL, quantization=ASR_QUANT, sess_options=opts, providers=["CPUExecutionProvider"])


def load_tts():
    import ptts
    try:
        ptts.set_num_threads(THREADS)
    except Exception:
        pass   # the pool is built once; a second call is harmless to skip
    return ptts.TTS(device="cpu", voice=TTS_VOICE, lang=TTS_LANG)


def wav_bytes(samples, rate):
    """Float samples (-1..1) as a mono 16-bit WAV, in memory."""
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


class Voice:
    def __init__(self):
        self.asr = load_asr()
        self.tts = load_tts()
        self.asr_lock = threading.Lock()
        self.tts_lock = threading.Lock()
        # Warm both once, so the first real clip and sentence are as quick as the rest.
        import numpy as np
        with self.asr_lock:
            self.asr.recognize(np.zeros(LISTEN_RATE // 2, dtype=np.float32), sample_rate=LISTEN_RATE)
        with self.tts_lock:
            self.tts.synth("Ready.")

    def listen(self, pcm16):
        import numpy as np
        samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        if samples.size < LISTEN_RATE // 4:
            return "", samples.size / LISTEN_RATE
        with self.asr_lock:
            text = self.asr.recognize(samples, sample_rate=LISTEN_RATE)
        return str(text or "").strip(), samples.size / LISTEN_RATE

    def say(self, text):
        with self.tts_lock:
            samples = self.tts.synth(text)
            rate = self.tts.sample_rate
        return wav_bytes(samples, rate), len(samples) / rate


def make_handler(voice, key):
    class Handler(BaseHTTPRequestHandler):
        server_version = "crux-voice"
        sys_version = ""

        def log_message(self, *args):
            pass   # nothing about requests goes to the hub's log

        def reply(self, code, body, ctype="application/json"):
            data = json.dumps(body).encode() if ctype == "application/json" else body
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def allowed(self):
            # Only the hub: it holds this start's key, and it never sends an Origin (a web page always does).
            if self.headers.get("Origin") is not None or self.headers.get("X-Voice-Key") != key:
                self.reply(403, {"error": "Not for you"})
                return False
            return True

        def body(self, limit):
            n = int(self.headers.get("Content-Length") or 0)
            if n < 0 or n > limit:
                raise ValueError("Too large")
            return self.rfile.read(n)

        def do_GET(self):
            if not self.allowed():
                return
            if self.path == "/health":
                return self.reply(200, {"ok": True, "threads": THREADS})
            self.reply(404, {"error": "Not found"})

        def do_POST(self):
            if not self.allowed():
                return
            try:
                if self.path == "/listen":
                    pcm = self.body(MAX_CLIP_S * LISTEN_RATE * 2 + 1024)
                    t = time.perf_counter()
                    text, secs = voice.listen(pcm)
                    return self.reply(200, {"text": text, "seconds": round(secs, 2), "ms": round((time.perf_counter() - t) * 1000)})
                if self.path == "/say":
                    req = json.loads(self.body(64 * 1024) or b"{}")
                    text = str(req.get("text") or "").strip()[:MAX_SAY_CHARS]
                    if not text:
                        return self.reply(400, {"error": "Nothing to say"})
                    t = time.perf_counter()
                    audio, secs = voice.say(text)
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(audio)))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Voice-Seconds", str(round(secs, 2)))
                    self.send_header("X-Voice-Ms", str(round((time.perf_counter() - t) * 1000)))
                    self.end_headers()
                    self.wfile.write(audio)
                    return
                self.reply(404, {"error": "Not found"})
            except Exception as e:   # one bad request never stops the helper
                self.reply(400, {"error": str(e)[:300]})

    return Handler


def watch_parent():
    """The hub holds our stdin open; when it closes (the hub stopped, or switched voice off), we leave.

    The pipe is moved off fd 0 first and fd 0 points at NUL: on Windows a pending read on a pipe blocks every other
    look at that pipe (GetFileType, isatty), and libraries check stdin while loading, which hung the helper at start.
    """
    fd = os.dup(0)
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    sys.stdin = open(os.devnull, "r")   # reading only: nothing is ever written

    def wait():
        try:
            while os.read(fd, 1024):
                pass
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=wait, daemon=True).start()


def setup():
    say_line({"step": "asr"})
    load_asr()
    say_line({"step": "tts"})
    tts = load_tts()
    tts.synth("Ready.")   # the voice itself comes from the catalog on first use
    say_line({"done": True})


def serve():
    key = os.environ.get("CRUX_VOICE_KEY", "")
    if len(key) < 32:
        say_line({"error": "No key from the hub"})
        sys.exit(2)
    watch_parent()
    t = time.perf_counter()
    voice = Voice()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(voice, key))
    server.daemon_threads = True
    say_line({"ready": True, "port": server.server_address[1], "loadMs": round((time.perf_counter() - t) * 1000), "threads": THREADS})
    server.serve_forever()


if __name__ == "__main__":
    try:
        setup() if "--setup" in sys.argv else serve()
    except Exception as e:
        say_line({"error": f"{type(e).__name__}: {e}"[:500]})
        sys.exit(1)
