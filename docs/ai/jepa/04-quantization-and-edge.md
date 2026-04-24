# JEPA Quantization and Edge Deployment

## Overview

Running JEPA models on smart glasses requires aggressive optimization. This document covers the quantization path from research models to on-device inference.

## Starting Point: V-JEPA 2 ViT-L

| Property | Value |
|----------|-------|
| Architecture | Vision Transformer (ViT-Large) |
| Parameters | ~300M |
| Uncompressed size | ~1.2GB (FP32) |
| Input | 16-64 frames at 256x256 or 384x384 |
| Tokens per clip | 2,048 - 18,432 (depends on resolution + frame count) |
| Embedding output | 1024-dim vector |
| Attention cost | O(N^2) where N = token count |

## Optimization Step 1: Spatiotemporal Area Attention (ST-A2)

**Source:** Taras Shchybovyk, February 2026
**Code:** [github.com/tarassh/vjepa2](https://github.com/tarassh/vjepa2) (feat/st-a2-area-attention branch)

### What It Does

Replaces global self-attention (every token attends to every other token) with spatiotemporal neighborhood attention. Tokens only attend to tokens in their spatial-temporal area.

### Architecture Change

```
Original V-JEPA 2 (24 layers):
  All 24 layers: full global attention (N^2)

ST-A2 Modified:
  Layers 1-18:  area attention (4 groups, N/4 per group)
  Layers 19-24: full global attention (preserves high-level reasoning)
```

### Grouping Strategy

With `spatial_splits=2, temporal_splits=2`:
- 2 spatial halves (top / bottom of frame)
- 2 temporal segments (early / late frames)
- 4 total areas

Tokens are sorted into their area, padded for equal size, attention runs within each area, then unsorted back.

### Results

| Metric | Baseline | ST-A2 (zero-shot) | ST-A2 (finetuned 1k steps) |
|--------|----------|-------------------|----------------------------|
| K400 accuracy | 84.97% | 82.85% (97.4% retained) | 82.70% |
| Attention compute | 1.0x | 0.25x (4x reduction) | 0.25x |
| Overhead (sorting) | 0 | +0.4% at 4608 tokens | +0.4% |
| Weight compatibility | -- | Drop-in with Meta checkpoints | Drop-in |

### Key Insight

97.4% accuracy retained with **zero fine-tuning**. The model was trained for thousands of GPU-hours with global attention, yet works nearly as well when you simply swap in area attention. This means no retraining cost for deployment.

### Inference Impact (Projected)

At training time with 75% masking (~4,600 tokens), sorting overhead roughly cancels attention savings. But at **inference time with no masking (18,000+ tokens)**, the quadratic cost explodes and area attention savings become dominant. Not yet benchmarked but the math is compelling.

---

## Optimization Step 2: Model Quantization

### Quantization Methods Comparison

| Method | Tool | Size Reduction | Speedup | Accuracy Impact | Difficulty |
|--------|------|---------------|---------|----------------|------------|
| Dynamic Quantization | PyTorch native | ~2-4x | ~2x | Minimal (<1%) | Easy |
| Static PTQ (INT8) | ONNX Runtime | ~4x | ~4x | Small (1-3%) | Medium |
| QAT (INT8) | PyTorch | ~4x | ~4x | Minimal | Hard |
| INT4 Quantization | bitsandbytes / GPTQ | ~8x | ~2x | Significant (5-15%) | Hard |

### Recommended Path: Dynamic -> Static -> Validate

```python
import torch
from transformers import AutoModel

# Step 1: Load model
model = AutoModel.from_pretrained("facebook/vjepa2-vitl-fpc16-384", trust_remote_code=True)
model.eval()

# Step 2: Dynamic quantization (quick win)
quantized_model = torch.quantization.quantize_dynamic(
    model, {torch.nn.Linear}, dtype=torch.qint8
)

# Step 3: Measure size
original_size = sum(p.nelement() * p.element_size() for p in model.parameters())
quantized_size = sum(p.nelement() * p.element_size() for p in quantized_model.parameters())
print(f"Original: {original_size / 1e9:.2f} GB")
print(f"Quantized: {quantized_size / 1e9:.2f} GB")
print(f"Reduction: {original_size / quantized_size:.1f}x")

# Step 4: Validate accuracy on your task before proceeding
```

### Export to ONNX

```python
import torch

dummy_input = torch.randn(1, 16, 3, 384, 384)  # batch, frames, channels, H, W

torch.onnx.export(
    quantized_model,
    dummy_input,
    "vjepa2-vitl-quantized.onnx",
    opset_version=17,
    input_names=["video"],
    output_names=["embedding"],
    dynamic_axes={"video": {0: "batch"}, "embedding": {0: "batch"}}
)
```

### Optimize with ONNX Runtime

```python
from onnxruntime.transformers import optimizer

optimized_model = optimizer.optimize_model(
    "vjepa2-vitl-quantized.onnx",
    model_type="vit",
    num_heads=16,
    hidden_size=1024
)
optimized_model.save_model_to_file("vjepa2-vitl-optimized.onnx")
```

---

## Optimization Step 3: Edge Runtime Deployment

### Apple Silicon (CoreML)

For iOS deployment on Apple Neural Engine:

```bash
# Convert ONNX -> CoreML
pip install coremltools
python -c "
import coremltools as ct
model = ct.converters.onnx.convert(
    model='vjepa2-vitl-optimized.onnx',
    convert_to='mlprogram',
    compute_units=ct.ComputeUnit.ALL
)
model.save('vjepa2-vitl.mlpackage')
"
```

### Qualcomm Snapdragon (TFLite)

For Android / Snapdragon NPUs:

```bash
# Convert ONNX -> TFLite via onnx-tf
pip install onnx-tf
python -c "
import onnx
from onnx_tf.backend import prepare
onnx_model = onnx.load('vjepa2-vitl-optimized.onnx')
tf_rep = prepare(onnx_model)
tf_rep.export_graph('vjepa2_tf')
"
# Then convert TF -> TFLite with INT8 quantization
```

### Target Performance

| Target Device | Model Size Target | Inference Time Target | Compute Unit |
|---------------|------------------|----------------------|-------------|
| Apple A17 Pro (iPhone 15 Pro) | ~100-150MB | <50ms | Neural Engine |
| Apple M2 (MacBook) | ~200MB | <30ms | GPU / Neural Engine |
| Qualcomm Snapdragon 8 Gen 3 | ~100-150MB | <80ms | Hexagon DSP |
| Smart glasses (future NPUs) | ~50-80MB | <100ms | Dedicated NPU |

---

## Optimization Step 4: LeWorldModel Native Edge

LeWorldModel at 15M parameters is already edge-sized without quantization:

| State | Size | Inference (estimated) |
|-------|------|----------------------|
| FP32 (uncompressed) | ~60MB | ~20ms on mobile NPU |
| INT8 quantized | ~15MB | ~5-10ms on mobile NPU |
| INT4 quantized | ~8MB | ~3-5ms on mobile NPU |

This model would fit on current smart glasses hardware without any optimization tricks. The barrier is not size -- it's that the model has only been validated in simulation.

---

## Practical Size Estimates: V-JEPA 2 ViT-L Pipeline

```
Step 0: Original model         ~1,200 MB (FP32, full precision)
Step 1: ST-A2 attention        ~1,200 MB (same weights, different attention)
Step 2: FP16                   ~  600 MB (half precision, no quality loss)
Step 3: Dynamic INT8           ~  300 MB (quantized linear layers)
Step 4: ONNX optimization      ~  250 MB (graph optimizations, fusion)
Step 5: CoreML/NNAPI compile   ~  200 MB (hardware-specific optimizations)

Final estimate: ~200-300 MB for V-JEPA 2 ViT-L on edge
```

For ViT-Small or MobileViT variants (not yet released by Meta), expect 50-100 MB.

---

## Batch Processing Strategy for Glasses

Smart glasses don't process video frame-by-frame. They buffer and batch:

```
Camera (30fps)
  -> Rolling buffer of 16 frames (0.5s at 30fps)
  -> Process every 500ms
  -> Embedding output
  -> Task heads (always running)
  -> Alert if needed

Compute budget:
  - 16 frames x 256x256 = ~3.1M pixels
  - After patch embedding: 2,048 tokens
  - With ST-A2: 4 areas of 512 tokens each
  - ViT-L forward pass: ~50ms on mobile NPU (estimated)
  - Total pipeline: ~80ms including pre/post processing
  - Leaves ~420ms idle before next batch
```

---

## Tools Summary

| Tool | Purpose | Link |
|------|---------|------|
| PyTorch | Quantization, training | pytorch.org |
| ONNX Runtime | Cross-platform inference | onnxruntime.ai |
| CoreML Tools | Apple deployment | developer.apple.com |
| TFLite | Android/Snapdragon deployment | tensorflow.org/lite |
| Hugging Face Transformers | Model loading and inference | huggingface.co |
| ST-A2 | Attention optimization | github.com/tarassh/vjepa2 |
