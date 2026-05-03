#!/usr/bin/env python3
"""
quantize_yolo_models.py

Exports YOLO11 models from PyTorch to quantized CoreML (.mlpackage) for iOS.
Uses Ultralytics export with INT8 quantization for reduced memory footprint.

Memory savings on 4GB devices (iPhone 13 mini):
  - YOLO11n: ~10MB FP16 -> ~5MB INT8 (saves ~5MB runtime)
  - YOLO11s: ~18MB FP16 -> ~9MB INT8 (saves ~9MB runtime)
  - YOLO11m: ~40MB FP16 -> ~20MB INT8 (saves ~20MB runtime)

Usage:
    # Quantize all models
    python3 quantize_yolo_models.py --all --output-dir ./quantized

    # Quantize specific model
    python3 quantize_yolo_models.py --model yolo11n --output-dir ./quantized

    # Upload to GitHub release
    python3 quantize_yolo_models.py --all --upload --repo ebowwa/meta-wearables-dat-ios --tag quantized-yolo-v1

Requires: ultralytics, coremltools >= 8.0
"""

import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

try:
    from ultralytics import YOLO
except ImportError:
    print("ERROR: ultralytics required. Install with: uv pip install ultralytics")
    sys.exit(1)


# YOLO11 PyTorch model IDs and their tasks
MODELS = {
    "yolo11n":      {"task": "detect", "pt_model": "yolo11n.pt"},
    "yolo11s":      {"task": "detect", "pt_model": "yolo11s.pt"},
    "yolo11m":      {"task": "detect", "pt_model": "yolo11m.pt"},
    "yolo11n-seg":  {"task": "segment", "pt_model": "yolo11n-seg.pt"},
    "yolo11s-seg":  {"task": "segment", "pt_model": "yolo11s-seg.pt"},
    "yolo11m-seg":  {"task": "segment", "pt_model": "yolo11m-seg.pt"},
    "yolo11n-pose": {"task": "pose", "pt_model": "yolo11n-pose.pt"},
    "yolo11s-pose": {"task": "pose", "pt_model": "yolo11s-pose.pt"},
    "yolo11m-pose": {"task": "pose", "pt_model": "yolo11m-pose.pt"},
}

# Original FP16 model URLs for size comparison
ORIGINAL_URLS = {
    "yolo11n":      "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11n.mlpackage.zip",
    "yolo11s":      "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11s.mlpackage.zip",
    "yolo11m":      "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11m.mlpackage.zip",
    "yolo11n-seg":  "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11n-seg.mlpackage.zip",
    "yolo11s-seg":  "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11s-seg.mlpackage.zip",
    "yolo11m-seg":  "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11m-seg.mlpackage.zip",
    "yolo11n-pose": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11n-pose.mlpackage.zip",
    "yolo11s-pose": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11s-pose.mlpackage.zip",
    "yolo11m-pose": "https://github.com/ultralytics/yolo-ios-app/releases/download/v8.3.0/yolo11m-pose.mlpackage.zip",
}


def get_directory_size(path: Path) -> int:
    """Total size of all files in directory tree."""
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def export_quantized(model_id: str, info: dict, output_dir: Path) -> Path:
    """Export a YOLO model to quantized CoreML using Ultralytics.
    Returns path to the exported .mlpackage directory."""
    export_name = f"{model_id}-int8"
    mlpackage_dir = output_dir / f"{export_name}.mlpackage"

    if mlpackage_dir.exists():
        print(f"  [SKIP] {export_name} already exported")
        return mlpackage_dir

    # Download PyTorch model (Ultralytics auto-downloads from their hub)
    print(f"  [LOAD] Loading {info['pt_model']} from Ultralytics hub...")
    model = YOLO(info["pt_model"])

    # Export to CoreML with INT8 quantization
    # Ultralytics handles: PyTorch -> CoreML conversion with NMS pipeline wrapper
    # int8=True enables weight quantization during export
    print(f"  [EXPORT] Converting to CoreML with INT8 quantization...")
    export_path = model.export(
        format="coreml",
        imgsz=640,
        int8=True,        # Enable INT8 weight quantization
        nms=True,          # Include NMS in the model pipeline
        half=False,        # FP32 for INT8 quantization (half=True would be FP16)
    )

    # Ultralytics saves to a temporary location, move to our output dir
    export_path = Path(export_path)
    if export_path.exists():
        # Rename to include -int8 suffix
        dest = output_dir / f"{export_name}.mlpackage"
        if export_path != dest:
            if dest.exists():
                shutil.rmtree(dest)
            shutil.move(str(export_path), str(dest))
        return dest
    else:
        raise RuntimeError(f"Export failed — no output at {export_path}")


def package_zip(mlpackage_dir: Path, output_dir: Path, model_id: str) -> Path:
    """Create a .zip from the quantized .mlpackage."""
    zip_path = output_dir / f"{model_id}-int8.mlpackage.zip"
    if zip_path.exists():
        print(f"  [SKIP] {zip_path.name} already packaged")
        return zip_path

    print(f"  [ZIP] Creating {zip_path.name}...")
    # Zip the contents of mlpackage_dir, with the dir name as the archive root
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in sorted(mlpackage_dir.rglob("*")):
            if file_path.is_file():
                arcname = f"{mlpackage_dir.name}/{file_path.relative_to(mlpackage_dir)}"
                zf.write(file_path, arcname)
    return zip_path


def upload_to_github(zip_path: Path, repo: str, tag: str):
    """Upload a file to GitHub releases using gh CLI."""
    print(f"  [UPLOAD] {zip_path.name} -> {repo} release {tag}")
    result = subprocess.run(
        ["gh", "release", "upload", tag, str(zip_path), "--repo", repo, "--clobber"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"  [ERROR] Upload failed: {result.stderr}")
        return False
    print(f"  [OK] Uploaded {zip_path.name}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Quantize YOLO11 CoreML models for iOS")
    parser.add_argument("--model", choices=list(MODELS.keys()), help="Quantize specific model")
    parser.add_argument("--all", action="store_true", help="Quantize all models")
    parser.add_argument("--output-dir", default="./quantized_output", help="Output directory")
    parser.add_argument("--upload", action="store_true", help="Upload to GitHub release after quantization")
    parser.add_argument("--repo", default="ebowwa/meta-wearables-dat-ios", help="GitHub repo for upload")
    parser.add_argument("--tag", default="quantized-yolo-v1", help="GitHub release tag")
    args = parser.parse_args()

    if not args.model and not args.all:
        parser.error("Specify --model <id> or --all")

    models_to_process = list(MODELS.keys()) if args.all else [args.model]
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    results = []

    for model_id in models_to_process:
        info = MODELS[model_id]
        print(f"\n{'='*60}")
        print(f"Model: {model_id} (task: {info['task']})")
        print(f"{'='*60}")

        # Step 1: Export with INT8 quantization
        print(f"\n[1/3] Exporting quantized CoreML model...")
        try:
            mlpackage_dir = export_quantized(model_id, info, output_dir)
        except Exception as e:
            print(f"  [ERROR] Export failed: {e}")
            import traceback
            traceback.print_exc()
            continue

        size_mb = get_directory_size(mlpackage_dir) / 1_048_576
        print(f"  Quantized size: {size_mb:.1f} MB")

        # Step 2: Package as zip
        print(f"\n[2/3] Packaging...")
        zip_path = package_zip(mlpackage_dir, output_dir, model_id)
        zip_mb = zip_path.stat().st_size / 1_048_576
        print(f"  Zip size: {zip_mb:.1f} MB")

        # Step 3: Upload (optional)
        uploaded = False
        if args.upload:
            print(f"\n[3/3] Uploading...")
            uploaded = upload_to_github(zip_path, args.repo, args.tag)
        else:
            print(f"\n[3/3] Skipping upload (--upload not set)")

        results.append({
            "model": model_id,
            "task": info["task"],
            "quantized_mb": size_mb,
            "zip_mb": zip_mb,
            "uploaded": uploaded,
        })

    # Summary
    print(f"\n{'='*60}")
    print("SUMMARY")
    print(f"{'='*60}")
    print(f"{'Model':<18} {'Task':<10} {'Quantized':>10} {'Zip':>8} {'Uploaded':>8}")
    print(f"{'-'*18} {'-'*10} {'-'*10} {'-'*8} {'-'*8}")
    total = 0
    for r in results:
        up = "YES" if r["uploaded"] else "no"
        print(f"{r['model']:<18} {r['task']:<10} {r['quantized_mb']:>8.1f} MB {r['zip_mb']:>6.1f} MB {up:>8}")
        total += r["quantized_mb"]
    print(f"\nTotal quantized: {total:.1f} MB")
    print(f"Output directory: {output_dir.resolve()}")

    # Print updated knownModelUrls for iOS
    print(f"\n{'='*60}")
    print("UPDATED knownModelUrls (copy to YOLOModelManager.swift)")
    print(f"{'='*60}")
    print('private static let knownModelUrls: [String: String] = [')
    for model_id in models_to_process:
        print(f'    "{model_id}": "https://github.com/{args.repo}/releases/download/{args.tag}/{model_id}-int8.mlpackage.zip",')
    for model_id in MODELS:
        if model_id not in models_to_process:
            print(f'    "{model_id}": "{ORIGINAL_URLS[model_id]}",')
    # Keep the custom Poker model
    print(f'    "YOLO11PokerInt8LUT": "https://github.com/ebowwa/meta-wearables-dat-ios/releases/download/poker-model-v1.0/YOLO11PokerInt8LUT.mlpackage.zip",')
    print(']')


if __name__ == "__main__":
    main()
