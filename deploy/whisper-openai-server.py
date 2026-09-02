#!/usr/bin/env python3
"""OpenAI-compatible local Whisper STT for LLMrouterVEX.

POST /v1/audio/transcriptions  (multipart file=)
GET  /v1/models
GET  /health
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse


def _windows_dll_setup() -> None:
    """CTranslate2 on Windows needs its own folder + VC++ on PATH before import."""
    if os.name != "nt":
        return
    roots: list[Path] = [Path(sys.executable).resolve().parent]
    for p in sys.path:
        ct2 = Path(p) / "ctranslate2"
        if ct2.is_dir():
            roots.append(ct2)
            roots.append(Path(p))
    seen: set[str] = set()
    prepend: list[str] = []
    for d in roots:
        key = str(d)
        if key in seen or not d.is_dir():
            continue
        seen.add(key)
        prepend.append(key)
        adder = getattr(os, "add_dll_directory", None)
        if adder:
            try:
                adder(key)
            except OSError:
                pass
    if prepend:
        os.environ["PATH"] = os.pathsep.join(prepend) + os.pathsep + os.environ.get("PATH", "")


_windows_dll_setup()

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")  # cpu | cuda | auto

app = FastAPI(title="LLMrouterVEX Whisper STT", version="1.0.0")
_model = None
_device_used = None


def get_model():
    global _model, _device_used
    if _model is not None:
        return _model
    from faster_whisper import WhisperModel

    name = MODEL_NAME
    if DEVICE == "cpu":
        _model = WhisperModel(name, device="cpu", compute_type="int8")
        _device_used = "cpu"
        return _model
    if DEVICE == "cuda":
        _model = WhisperModel(name, device="cuda", compute_type="float16")
        _device_used = "cuda"
        return _model
    try:
        _model = WhisperModel(name, device="cuda", compute_type="float16")
        _device_used = "cuda"
    except Exception:
        _model = WhisperModel(name, device="cpu", compute_type="int8")
        _device_used = "cpu"
    return _model


@app.get("/health")
def health():
    return {
        "ok": True,
        "engine": "faster-whisper",
        "model": MODEL_NAME,
        "device": _device_used or DEVICE,
        "loaded": _model is not None,
    }


@app.get("/v1/models")
def models():
    return {
        "object": "list",
        "data": [
            {"id": "whisper-1", "object": "model", "owned_by": "faster-whisper"},
            {"id": MODEL_NAME, "object": "model", "owned_by": "faster-whisper"},
        ],
    }


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str | None = Form(None),
    language: str | None = Form(None),
    response_format: str = Form("json"),
    temperature: float | None = Form(None),
):
    suffix = Path(file.filename or "audio").suffix or ".wav"
    raw = await file.read()
    if not raw:
        raise HTTPException(400, "empty file")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(raw)
        tmp.close()
        whisper = get_model()
        lang = language or None
        segments, info = whisper.transcribe(
            tmp.name,
            language=lang if lang and lang != "auto" else None,
            vad_filter=True,
            beam_size=5,
        )
        text = "".join(seg.text for seg in segments).strip()
    except Exception as exc:
        raise HTTPException(500, f"transcription failed: {exc}") from exc
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    if response_format == "text":
        return PlainTextResponse(text)
    return JSONResponse(
        {
            "text": text,
            "model": model or "whisper-1",
            "language": getattr(info, "language", language),
            "task": "transcribe",
        }
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8090")),
    )
