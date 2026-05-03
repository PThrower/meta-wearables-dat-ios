#!/usr/bin/env python3
"""
Convert OSNet (Omni-Scale Network) person ReID model from PyTorch to CoreML.

Outputs a 512-dim L2-normalized embedding suitable for on-device
person re-identification and tracklet appearance matching.

Requirements:
    pip install torch torchvision coremltools torchreid

Usage:
    python convert_osnet_coreml.py
    python convert_osnet_coreml.py --model-size x0_5 --quantize --output ./models
    python convert_osnet_coreml.py --model-size x1_0 --no-pretrained

Model sizes and approximate parameter counts:
    x0_25 : 1.19M params  (~4 MB float32, ~2 MB float16)
    x0_5  : 2.21M params  (~8 MB float32, ~4 MB float16)
    x1_0  : 2.19M params  (~8 MB float32, ~4 MB float16)

Input:  RGB image tensor, shape [1, 3, 256, 128], float32 normalized to [0, 1]
Output: 512-dim L2-normalized embedding, shape [1, 512], float32
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

# ---------------------------------------------------------------------------
# OSNet Embedding Wrapper
# ---------------------------------------------------------------------------


class OSNetEmbedding(nn.Module):
    """Wraps an OSNet model to produce L2-normalized 512-dim embeddings.

    Strips the classification head (FC layer) and outputs the global-average-
    pooled feature vector after L2 normalization.  This is the standard
    representation used for cosine-similarity ReID matching.

    Architecture flow:
        input [B, 3, 256, 128]
          -> conv1 + maxpool
          -> conv2 (OS blocks)
          -> conv3 (OS blocks)
          -> conv4 (OS blocks)
          -> conv5 (OS blocks)
          -> featuremaps: [B, 512, H', W']
          -> global average pool: [B, 512]
          -> L2 normalize: [B, 512]
    """

    def __init__(self, model: nn.Module):
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # featuremaps() returns pre-GAP activations: [B, 512, H', W']
        f = self.model.featuremaps(x)
        # Global average pool over spatial dims -> [B, 512]
        f = f.mean(dim=[2, 3])
        # L2 normalize along embedding dimension
        f = F.normalize(f, p=2, dim=1)
        return f


# ---------------------------------------------------------------------------
# Model Loader
# ---------------------------------------------------------------------------

MODEL_CONSTRUCTORS = {
    "x0_25": "osnet_x0_25",
    "x0_5": "osnet_x0_5",
    "x1_0": "osnet_x1_0",
}

PRETRAINED_DATASETS = {
    "x0_25": "market1501",
    "x0_5": "market1501",
    "x1_0": "market1501",
}


def load_osnet(model_size: str, pretrained: bool = True) -> nn.Module:
    """Load an OSNet variant from torchreid with optional pretrained weights."""
    try:
        from torchreid.models import osnet
    except ImportError:
        print(
            "ERROR: torchreid is not installed.\n"
            "  Install with:  pip install torchreid\n"
            "  Or from source: pip install git+https://github.com/KaiyangZhou/torchreid.git",
            file=sys.stderr,
        )
        sys.exit(1)

    constructor_name = MODEL_CONSTRUCTORS.get(model_size)
    if constructor_name is None:
        raise ValueError(
            f"Unknown model size '{model_size}'. "
            f"Choose from: {list(MODEL_CONSTRUCTORS.keys())}"
        )

    constructor = getattr(osnet, constructor_name)

    if pretrained:
        dataset = PRETRAINED_DATASETS[model_size]
        print(f"Loading OSNet-{model_size} pretrained on {dataset}...")
        model = constructor(pretrained=True, pretrained_path=None)
    else:
        print(f"Loading OSNet-{model_size} with random weights...")
        model = constructor(pretrained=False)

    model.eval()
    return model


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------

def convert_to_coreml(
    wrapper: nn.Module,
    example_input: torch.Tensor,
    quantize: bool = False,
    ios_version: str = "17",
) -> "ct.models.MLModel":
    """Trace the wrapper and convert to CoreML ML Program."""
    try:
        import coremltools as ct
    except ImportError:
        print(
            "ERROR: coremltools is not installed.\n"
            "  Install with:  pip install coremltools",
            file=sys.stderr,
        )
        sys.exit(1)

    # --- Trace ---
    print("Tracing model with torch.jit.trace...")
    with torch.no_grad():
        traced = torch.jit.trace(wrapper, example_input)

    # --- Verify traced output ---
    with torch.no_grad():
        pt_output = wrapper(example_input).numpy()
    print(f"  PyTorch output shape: {pt_output.shape}")
    print(f"  L2 norm (should be ~1.0): {np.linalg.norm(pt_output, axis=1)[0]:.6f}")

    # --- Deployment target ---
    ios_major = int(ios_version.split(".")[0])
    deployment_target = getattr(ct.target, f"iOS{ios_major}", None)
    if deployment_target is None:
        # Fallback: try constructing from string
        deployment_target = ct.target.iOS17
        print(f"  Warning: iOS{ios_version} target not found, falling back to iOS17")

    # --- Convert ---
    print("Converting to CoreML ML Program...")
    mlmodel = ct.convert(
        traced,
        inputs=[
            ct.TensorType(
                name="image",
                shape=example_input.shape,
                dtype=np.float32,
            )
        ],
        outputs=[
            ct.TensorType(name="embedding", dtype=np.float32),
        ],
        convert_to="mlprogram",
        minimum_deployment_target=deployment_target,
        compute_units=ct.ComputeUnit.ALL,
    )

    # --- Quantize to float16 ---
    if quantize:
        print("Quantizing weights to float16...")
        mlmodel = ct.optimize.coreml.linear_quantize_weights(
            mlmodel,
            mode=ct.optimize.coreml.OpLinearQuantizationMode.linear_symmetric,
            dtype=np.float16,
        )

    return mlmodel


# ---------------------------------------------------------------------------
# Metadata and Saving
# ---------------------------------------------------------------------------

def add_metadata(mlmodel: "ct.models.MLModel", model_size: str, quantized: bool) -> None:
    """Attach descriptive metadata to the CoreML model."""
    mlmodel.short_description = (
        f"OSNet-{model_size} person ReID embedding model. "
        f"Produces 512-dim L2-normalized feature vectors for "
        f"cosine-similarity person re-identification."
    )
    mlmodel.input_description["image"] = (
        "RGB image tensor, shape [1, 3, 256, 128], float32, "
        "pixel values normalized to [0.0, 1.0]"
    )
    mlmodel.output_description["embedding"] = (
        "512-dim L2-normalized embedding vector, shape [1, 512]. "
        "Cosine similarity between embeddings indicates visual similarity."
    )
    mlmodel.author = "Converted from torchreid OSNet (Kaiyang Zhou et al.)"
    mlmodel.license = (
        "OSNet: MIT License. "
        "See https://github.com/KaiyangZhou/torchreid for details."
    )
    mlmodel.version = "1.0.0"

    # Add user-defined metadata
    mlmodel.user_defined_metadata["model_size"] = model_size
    mlmodel.user_defined_metadata["quantized"] = str(quantized)
    mlmodel.user_defined_metadata["input_resolution"] = "256x128"
    mlmodel.user_defined_metadata["embedding_dim"] = "512"
    mlmodel.user_defined_metadata["normalization"] = "L2"


def get_model_size(model_path: str) -> int:
    """Return total size in bytes of the .mlpackage directory."""
    total = 0
    if os.path.isdir(model_path):
        for dirpath, _dirnames, filenames in os.walk(model_path):
            for f in filenames:
                fp = os.path.join(dirpath, f)
                total += os.path.getsize(fp)
    elif os.path.isfile(model_path):
        total = os.path.getsize(model_path)
    return total


def format_bytes(size: int) -> str:
    """Human-readable byte string."""
    if size < 1024:
        return f"{size} B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    else:
        return f"{size / (1024 * 1024):.1f} MB"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert OSNet person ReID model from PyTorch to CoreML",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  %(prog)s\n"
            "  %(prog)s --model-size x0_5 --quantize\n"
            "  %(prog)s --model-size x1_0 --output ./models --ios-version 16\n"
        ),
    )
    parser.add_argument(
        "--model-size",
        choices=["x0_25", "x0_5", "x1_0"],
        default="x0_25",
        help="OSNet model variant (default: x0_25, smallest and fastest)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default=None,
        help="Output directory for the .mlpackage (default: script directory)",
    )
    parser.add_argument(
        "--quantize",
        action="store_true",
        default=False,
        help="Quantize weights to float16 (halves model size, negligible accuracy loss)",
    )
    parser.add_argument(
        "--no-pretrained",
        action="store_true",
        default=False,
        help="Use random weights instead of pretrained Market-1501 weights",
    )
    parser.add_argument(
        "--ios-version",
        type=str,
        default="17",
        help="Minimum iOS deployment target (default: 17)",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    # --- Output path ---
    script_dir = Path(__file__).resolve().parent
    output_dir = Path(args.output) if args.output else script_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    model_filename = f"OSNet_{args.model_size}"
    if args.quantize:
        model_filename += "_fp16"
    output_path = output_dir / f"{model_filename}.mlpackage"

    print("=" * 60)
    print("OSNet -> CoreML Converter")
    print("=" * 60)
    print(f"  Model variant : OSNet-{args.model_size}")
    print(f"  Pretrained    : {not args.no_pretrained}")
    print(f"  Quantize fp16 : {args.quantize}")
    print(f"  iOS target    : {args.ios_version}")
    print(f"  Output        : {output_path}")
    print()

    # --- Load model ---
    model = load_osnet(args.model_size, pretrained=not args.no_pretrained)

    # Print parameter count
    num_params = sum(p.numel() for p in model.parameters())
    print(f"  Parameters    : {num_params:,}")
    print()

    # --- Wrap for embedding extraction ---
    wrapper = OSNetEmbedding(model)
    wrapper.eval()

    # --- Create example input ---
    # 256x128 is the standard OSNet input resolution for person ReID
    example_input = torch.randn(1, 3, 256, 128)

    # --- Convert ---
    mlmodel = convert_to_coreml(
        wrapper,
        example_input,
        quantize=args.quantize,
        ios_version=args.ios_version,
    )

    # --- Add metadata ---
    add_metadata(mlmodel, args.model_size, args.quantize)

    # --- Verify CoreML output ---
    print("Verifying CoreML output...")
    coreml_prediction = mlmodel.predict({"image": example_input.numpy()})
    embedding = coreml_prediction["embedding"]
    print(f"  CoreML output shape : {embedding.shape}")
    print(f"  L2 norm (should be ~1.0): {np.linalg.norm(embedding, axis=1)[0]:.6f}")
    print()

    # --- Save ---
    print(f"Saving to {output_path}...")
    mlmodel.save(str(output_path))

    # --- Report ---
    package_size = get_model_size(str(output_path))
    print()
    print("=" * 60)
    print("Conversion complete")
    print("=" * 60)
    print(f"  File          : {output_path}")
    print(f"  Size          : {format_bytes(package_size)}")
    print(f"  Parameters    : {num_params:,}")
    print(f"  Input         : image [1, 3, 256, 128] float32 [0, 1]")
    print(f"  Output        : embedding [1, 512] float32 L2-normalized")
    print(f"  Compute units : ALL (Neural Engine preferred)")
    print()

    # --- Usage hint ---
    print("Usage in Swift:")
    print(
        """
    // Load model
    let config = MLModelConfiguration()
    config.computeUnits = .all
    let model = try OSNet_x0_25(configuration: config)

    // Prepare input (CVPixelBuffer -> 256x128 RGB float [0,1])
    // ... or use VNCoreMLModel for Vision pipeline integration

    // Run inference
    let output = try model.prediction(image: inputTensor)
    let embedding = output.embedding  // [512] Float32 array

    // Match by cosine similarity (L2-normalized, so dot product = cosine)
    let similarity = zip(embedding, referenceEmbedding).map(*).reduce(0, +)
    """
    )


if __name__ == "__main__":
    main()
