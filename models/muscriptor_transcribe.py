# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "muscriptor>=0.3",
#   "torch>=2.7.1; sys_platform != 'darwin'",
#   "torchaudio>=2.7.1; sys_platform != 'darwin'",
# ]
#
# [tool.uv.sources]
# torch = [{ index = "pytorch-cu128", marker = "sys_platform == 'win32' or sys_platform == 'linux'" }]
# torchaudio = [{ index = "pytorch-cu128", marker = "sys_platform == 'win32' or sys_platform == 'linux'" }]
# [[tool.uv.index]]
# name = "pytorch-cu128"
# url = "https://download.pytorch.org/whl/cu128"
# explicit = true
# ///
"""floatfall transcriber wrapper around MuScriptor (Kyutai x Mirelo).

Contract with the floatfall desktop app (settings.json -> transcriber):

    uv run --script models/muscriptor_transcribe.py {input} {output}

* reads the audio file at INPUT (any format libsndfile reads),
* writes {"notes": [{"pitch", "start", "end", "velocity"}]} to OUTPUT,
* prints "NN%" progress lines to stdout (shown in the floating window),
* logs everything else to stderr, exits non-zero on failure.

The model weights are gated on Hugging Face: accept the licence on
https://huggingface.co/MuScriptor/muscriptor-large and authenticate once with
`uvx hf auth login` (or set HF_TOKEN). Weights are CC BY-NC 4.0.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

EXIT_USAGE = 2
EXIT_AUTH = 3
EXIT_FAILED = 1

# Notes shorter than this after melody extraction are dropped (seconds).
MIN_NOTE_SEC = 0.03


@dataclass
class Note:
    pitch: int
    start: float
    end: float
    instrument: str


def log(message: str) -> None:
    print(f"[floatfall] {message}", file=sys.stderr, flush=True)


def progress(fraction: float) -> None:
    # The desktop app parses the first "NN%" on each stdout line.
    print(f"{max(0.0, min(1.0, fraction)) * 100:.0f}%", flush=True)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe the melody of an audio file with MuScriptor.",
    )
    parser.add_argument("input", type=Path, help="input audio (wav/flac/mp3/...)")
    parser.add_argument("output", type=Path, help="output notes JSON")
    parser.add_argument(
        "--model",
        default=os.environ.get("FLOATFALL_MUSCRIPTOR_MODEL", "large"),
        help="small | medium | large | local .safetensors | hf:// URL (default: large)",
    )
    parser.add_argument(
        "--instruments",
        default=os.environ.get("FLOATFALL_MUSCRIPTOR_INSTRUMENTS", "voice"),
        help=(
            "comma-separated MuScriptor instrument groups the model may output "
            "(default: voice). Pass an empty string to allow every instrument."
        ),
    )
    parser.add_argument(
        "--poly",
        action="store_true",
        help="keep overlapping notes instead of reducing to a single melody line",
    )
    parser.add_argument(
        "--device",
        default=os.environ.get("FLOATFALL_MUSCRIPTOR_DEVICE", "cuda"),
        help="torch device (default: cuda; pass cpu explicitly for CPU processing)",
    )
    parser.add_argument(
        "--cfg", type=float, default=1.0, help="classifier-free guidance coefficient"
    )
    parser.add_argument(
        "--list-instruments", action="store_true", help="print instrument groups and exit"
    )
    return parser.parse_args(argv)


def is_auth_error(error: BaseException) -> bool:
    try:
        from huggingface_hub.errors import GatedRepoError, HfHubHTTPError
    except ImportError:  # pragma: no cover - very old huggingface_hub
        return False
    if isinstance(error, GatedRepoError):
        return True
    if isinstance(error, HfHubHTTPError):
        status = getattr(getattr(error, "response", None), "status_code", None)
        return status in (401, 403)
    return False


def extract_melody(notes: list[Note]) -> list[Note]:
    """Reduce polyphony to one line: the highest sounding pitch wins ("skyline").

    Sweeps over every note boundary; within each interval the highest active
    note is kept. Consecutive intervals of the same note are merged, so a
    lower note covered by a higher one resumes once the higher one ends.
    """
    events: list[tuple[float, int, int]] = []  # (time, kind 0=end 1=start, note index)
    for i, n in enumerate(notes):
        if n.end > n.start:
            events.append((n.start, 1, i))
            events.append((n.end, 0, i))
    events.sort()

    active: set[int] = set()
    segments: list[Note] = []
    current: int | None = None  # index of the note currently on top
    seg_start = 0.0

    def close(at: float) -> None:
        if current is not None and at - seg_start >= MIN_NOTE_SEC:
            top = notes[current]
            segments.append(Note(top.pitch, seg_start, at, top.instrument))

    for k, (time_, kind, idx) in enumerate(events):
        if kind == 1:
            active.add(idx)
        else:
            active.discard(idx)
        # Only re-evaluate once all events at this timestamp are applied.
        if k + 1 < len(events) and events[k + 1][0] == time_:
            continue
        top = max(active, key=lambda i: notes[i].pitch, default=None)
        if top != current:
            close(time_)
            current, seg_start = top, time_
    return segments


def transcribe(args: argparse.Namespace) -> list[Note]:
    import torch

    device = torch.device(args.device)
    if device.type == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA is unavailable. Run this script with uv to install CUDA-enabled "
                "PyTorch and check your NVIDIA driver, or pass --device cpu explicitly."
            )
        log(f"using {device}: {torch.cuda.get_device_name(device)} (PyTorch {torch.__version__})")
    else:
        log(f"using {device}")

    from muscriptor import NoteEndEvent, NoteStartEvent, TranscriptionModel
    from muscriptor.events import ProgressEvent
    from muscriptor.tokenizer.mt3 import resolve_instrument_names

    instruments = [s for s in (t.strip() for t in args.instruments.split(",")) if s]
    instruments = resolve_instrument_names(instruments) if instruments else None

    t0 = time.perf_counter()
    log(f"loading model '{args.model}'")
    model = TranscriptionModel.load_model(args.model, device=args.device)
    log(f"model ready in {time.perf_counter() - t0:.1f}s")
    # Loading counts as the first few percent so the UI shows movement.
    progress(0.05)

    open_notes: dict[int, NoteStartEvent] = {}
    notes: list[Note] = []
    for event in model.transcribe(args.input, cfg_coef=args.cfg, instruments=instruments):
        if isinstance(event, ProgressEvent):
            if event.total > 0:
                progress(0.05 + 0.9 * event.completed / event.total)
        elif isinstance(event, NoteStartEvent):
            open_notes[event.index] = event
        elif isinstance(event, NoteEndEvent):
            start = open_notes.pop(event.start_event_index, event.start_event)
            if start.instrument == "drums":
                continue
            notes.append(Note(start.pitch, start.start_time, event.end_time, start.instrument))
    return notes


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    if args.list_instruments:
        from muscriptor.tokenizer.mt3 import MT3_FULL_PLUS_GROUP_NAMES

        print("\n".join(MT3_FULL_PLUS_GROUP_NAMES))
        return 0

    if not args.input.is_file():
        log(f"input not found: {args.input}")
        return EXIT_USAGE

    try:
        notes = transcribe(args)
    except Exception as error:  # noqa: BLE001 - report every failure to the app
        if is_auth_error(error):
            log(
                "cannot download MuScriptor weights: accept the licence at "
                "https://huggingface.co/MuScriptor/muscriptor-large and run "
                "`uvx hf auth login` (or set HF_TOKEN)"
            )
            return EXIT_AUTH
        log(f"transcription failed: {type(error).__name__}: {error}")
        return EXIT_FAILED

    total = len(notes)
    if not args.poly:
        notes = extract_melody(notes)
    log(f"{total} notes transcribed, {len(notes)} kept")

    payload = {
        "notes": [
            # MuScriptor does not predict velocity; use a constant.
            {"pitch": n.pitch, "start": round(n.start, 4), "end": round(n.end, 4), "velocity": 0.8}
            for n in notes
            if n.end > n.start
        ]
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload), encoding="utf-8")
    progress(1.0)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
