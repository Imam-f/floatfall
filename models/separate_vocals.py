# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "audio-separator[cpu]==0.44.0",
#   "audioread>=3.0",
#   "librosa==0.11.0",
#   "torch==2.11.0; sys_platform == 'win32' or sys_platform == 'linux'",
#   "torchaudio==2.11.0; sys_platform == 'win32' or sys_platform == 'linux'",
#   "torchvision==0.26.0; sys_platform == 'win32' or sys_platform == 'linux'",
# ]
#
# # RoFormer runs on CUDA through PyTorch. The ONNX CPU backend is only needed
# # for audio-separator's imports; no ONNX models are used by this wrapper.
# [tool.uv.sources]
# torch = [{ index = "pytorch-cu128", marker = "sys_platform == 'win32' or sys_platform == 'linux'" }]
# torchaudio = [{ index = "pytorch-cu128", marker = "sys_platform == 'win32' or sys_platform == 'linux'" }]
# torchvision = [{ index = "pytorch-cu128", marker = "sys_platform == 'win32' or sys_platform == 'linux'" }]
# [[tool.uv.index]]
# name = "pytorch-cu128"
# url = "https://download.pytorch.org/whl/cu128"
# explicit = true
# ///
"""Isolate singing vocals with BS-RoFormer on CUDA for floatfall.

uv run --locked --script models/separate_vocals.py INPUT OUTPUT --ffmpeg PATH

Writes a stereo 44.1 kHz WAV to exactly OUTPUT. The desktop pipeline converts
this stem to mono at the transcription sample rate after separation.
"""

from __future__ import annotations

import argparse
import logging
import os
from pathlib import Path
import shutil
import sys
import tempfile

DEFAULT_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, nargs="?", help="input audio")
    parser.add_argument("output", type=Path, nargs="?", help="output vocal WAV")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="audio-separator model filename")
    parser.add_argument(
        "--model-dir", type=Path,
        default=Path(os.environ.get("LOCALAPPDATA", str(Path.home() / ".cache"))) / "floatfall" / "models" / "audio-separator",
        help="persistent model download directory",
    )
    parser.add_argument("--ffmpeg", type=Path, help="path to ffmpeg executable if absent from PATH")
    parser.add_argument("--download-only", action="store_true", help="download weights without processing audio")
    parser.add_argument("--segment-size", type=int, default=256, help="inference segment size (smaller uses less VRAM)")
    args = parser.parse_args(argv)
    if not args.download_only and (args.input is None or args.output is None):
        parser.error("input and output are required unless --download-only is set")
    if args.segment_size <= 0:
        parser.error("--segment-size must be positive")
    return args


def progress(percent: int) -> None:
    print(f"{percent}%", flush=True)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.download_only and not args.input.is_file():
        print(f"[floatfall] input not found: {args.input}", file=sys.stderr)
        return 2
    try:
        if args.ffmpeg is not None:
            if not args.ffmpeg.is_file():
                raise FileNotFoundError(f"ffmpeg not found: {args.ffmpeg}")
            os.environ["PATH"] = str(args.ffmpeg.resolve().parent) + os.pathsep + os.environ.get("PATH", "")

        import torch
        from audio_separator.separator import Separator

        if args.download_only:
            separator = Separator(model_file_dir=str(args.model_dir), info_only=True)
            separator.download_model_and_data(args.model)
            return 0

        if not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable. Run with uv to install GPU dependencies and check your NVIDIA driver.")
        print(f"[floatfall] isolating vocals on {torch.cuda.get_device_name(0)} with {args.model}", file=sys.stderr, flush=True)
        progress(0)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        # Private output directory prevents collisions when two videos run at once.
        with tempfile.TemporaryDirectory(prefix="floatfall-vocals-", dir=args.output.parent) as output_dir:
            separator = Separator(
                log_level=logging.INFO,
                model_file_dir=str(args.model_dir),
                output_dir=output_dir,
                output_format="WAV",
                output_single_stem="Vocals",
                sample_rate=44100,
                use_soundfile=True,
                use_autocast=True,
                mdxc_params={
                    "segment_size": args.segment_size,
                    "override_model_segment_size": True,
                    "batch_size": 1,
                    "overlap": 8,
                    "pitch_shift": 0,
                },
            )
            if separator.torch_device.type != "cuda":
                raise RuntimeError("The separator did not select CUDA; refusing to run on the CPU.")
            separator.load_model(model_filename=args.model)
            progress(10)
            outputs = separator.separate(str(args.input.resolve()), custom_output_names={"Vocals": "vocals"})
            if len(outputs) != 1:
                raise RuntimeError(f"Expected one vocal stem, got {outputs!r}")
            stem = Path(outputs[0])
            if not stem.is_absolute():
                stem = Path(output_dir) / stem

            import soundfile as sf

            info = sf.info(stem)
            if info.frames == 0 or info.samplerate != 44100 or info.channels != 2:
                raise RuntimeError(f"Invalid vocal stem: {info}")
            shutil.move(str(stem), str(args.output))
        progress(100)
        return 0
    except Exception as error:
        print(f"[floatfall] vocal separation failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
