"""Private Synap speaker-embedding service.

The service accepts short mono PCM16/16k WAV payloads and returns only a
normalized speaker embedding. It never writes the enrollment/meeting audio to
disk or object storage. Cloud Run IAM is the authentication boundary.
"""

from __future__ import annotations

import io
import math
import os
import wave
from array import array

import torch
from fastapi import FastAPI, HTTPException, Request
from speechbrain.inference.classifiers import EncoderClassifier

MODEL = os.getenv("SYNAP_SPEAKER_MODEL", "speechbrain/spkrec-ecapa-voxceleb")
MODEL_DIR = os.getenv("SYNAP_SPEAKER_MODEL_DIR", "/opt/synap-speaker-model")
MIN_MS = int(os.getenv("SYNAP_SPEAKER_SERVICE_MIN_MS", "2000"))
MAX_MS = int(os.getenv("SYNAP_SPEAKER_SERVICE_MAX_MS", "30000"))

app = FastAPI(title="Synap speaker service", docs_url=None, redoc_url=None)
classifier: EncoderClassifier | None = None


def load_classifier() -> EncoderClassifier:
    global classifier
    if classifier is None:
        classifier = EncoderClassifier.from_hparams(
            source=MODEL,
            savedir=MODEL_DIR,
            run_opts={"device": "cpu"},
        )
    return classifier


def decode_wav(data: bytes) -> tuple[torch.Tensor, int]:
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            channels = wav.getnchannels()
            sample_width = wav.getsampwidth()
            sample_rate = wav.getframerate()
            frames = wav.getnframes()
            if channels != 1 or sample_width != 2 or sample_rate != 16000:
                raise HTTPException(400, "Expected mono 16-bit PCM WAV at 16 kHz")
            raw = wav.readframes(frames)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "Invalid WAV payload") from exc

    samples = array("h")
    samples.frombytes(raw)
    if os.sys.byteorder != "little":
        samples.byteswap()
    duration_ms = round(len(samples) / sample_rate * 1000)
    if duration_ms < MIN_MS:
        raise HTTPException(400, f"Need at least {MIN_MS / 1000:.1f} seconds of speech")
    if duration_ms > MAX_MS:
        raise HTTPException(400, f"Audio sample is limited to {MAX_MS / 1000:.0f} seconds")

    signal = torch.tensor(samples, dtype=torch.float32).unsqueeze(0) / 32768.0
    return signal, duration_ms


def normalize(values: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(norm) or norm <= 0:
        raise HTTPException(500, "Speaker model returned an empty embedding")
    return [value / norm for value in values]


@app.on_event("startup")
def warm_model() -> None:
    load_classifier()


@app.get("/health")
def health() -> dict[str, object]:
    return {"status": "ok", "model": MODEL, "ready": classifier is not None}


@app.post("/embed")
async def embed(request: Request) -> dict[str, object]:
    if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() not in {
        "audio/wav",
        "audio/x-wav",
    }:
        raise HTTPException(415, "Content-Type must be audio/wav")
    data = await request.body()
    if not data or len(data) > 2 * 1024 * 1024:
        raise HTTPException(413, "Audio payload must be between 1 byte and 2 MB")

    signal, duration_ms = decode_wav(data)
    model = load_classifier()
    with torch.inference_mode():
        embedding = model.encode_batch(signal, normalize=True).detach().cpu().reshape(-1).tolist()

    values = normalize([float(value) for value in embedding])
    return {
        "embedding": values,
        "model": MODEL,
        "duration_ms": duration_ms,
        "dimensions": len(values),
    }
