# Active JEPA Models: Status and Availability

## Overview

Three active JEPA model families, each at a different maturity level for smart glasses deployment.

## V-JEPA 2 (June 2025) -- Production Ready

**Paper:** [arXiv:2506.09985](https://arxiv.org/abs/2506.09985)
**Code:** [github.com/facebookresearch/vjepa2](https://github.com/facebookresearch/vjepa2) (3.5k stars, MIT license)
**Authors:** Mido Assran, Adrien Bardes, Yann LeCun, Nicolas Ballas, + 20 others (Meta FAIR)

### Architecture

- **Backbone:** Vision Transformer (ViT)
- **Training data:** 1M+ hours of internet video
- **Training method:** Self-supervised with 75% masking, no labels
- **Prediction target:** Embeddings (not pixels)

### Available Checkpoints

| Model | Backbone | Resolution | Frames | Params | HuggingFace ID |
|-------|----------|-----------|--------|--------|---------------|
| V-JEPA 2 ViT-L | ViT-Large | 256x256 | 64 | ~300M | `facebook/vjepa2-vitl-fpc64-256` |
| V-JEPA 2 ViT-L | ViT-Large | 384x384 | 16 | ~300M | `facebook/vjepa2-vitl-fpc16-384` |
| V-JEPA 2 ViT-G | ViT-Giant | 384x384 | 64 | ~1.2B | `facebook/vjepa2-vitg-fpc64-384` |

### Benchmark Results

| Task | Dataset | Score | Notes |
|------|---------|-------|-------|
| Motion understanding | Something-Something v2 | 77.3 top-1 | |
| Action anticipation | Epic-Kitchens-100 | 39.7 recall-at-5 | **Directly relevant to glasses** |
| Video QA | PerceptionTest | 84.0 | With LLM alignment |
| Video QA | TempCompass | 76.9 | With LLM alignment |
| Robot control | Franka arm pick-and-place | Zero-shot | No environment-specific training |

### Key Capabilities

1. **Action anticipation** -- predicts what action will happen next from egocentric video
2. **Video understanding** -- classifies actions, answers questions about video content
3. **Zero-shot robot control** -- V-JEPA 2-AC variant plans physical actions without training in the target environment
4. **Feature extraction** -- frozen encoder outputs 1024-dim embeddings usable for any downstream task

### Architecture Details

```
Video Input (64 frames, 256x256)
  -> Patch embedding: 2 frames x 16px x 16px tubelets
  -> 8,192 tokens, each 1024-dim
  -> 24-layer ViT encoder with 3D-RoPE position encoding
  -> Global average pooling
  -> 1024-dim embedding vector
```

### Variants

- **V-JEPA 2** -- Base model, action-free pre-training
- **V-JEPA 2-AC** -- Post-trained with latent action conditioning using 62 hours of Droid robot videos. Enables zero-shot robot planning.

---

## LeWorldModel / LeWM (March 2026) -- Edge-Optimized Future

**Paper:** [arXiv:2603.19312](https://arxiv.org/abs/2603.19312)
**Code:** [github.com/lucas-maes/le-wm](https://github.com/lucas-maes/le-wm)
**Project:** [le-wm.github.io](https://le-wm.github.io/)
**Authors:** Lucas Maes, Quentin Le Lidec, Damien Scieur, Yann LeCun, Randall Balestriero (Mila, NYU, Samsung SAIL, Brown)

### Architecture

- **Parameters:** ~15M (200x smaller than V-JEPA 2)
- **Training:** Single GPU, few hours
- **Loss:** Only 2 terms (prediction + Gaussian regularizer)
- **Hyperparameters:** 1 tunable (vs 6 in prior work)
- **No hacks:** No EMAs, no frozen encoders, no auxiliary losses

### The SIGReg Innovation

LeWM prevents representation collapse with SIGReg (Simplicity is Good Regularization):
- Enforces latent embeddings to follow an isotropic Gaussian distribution
- Based on the Cramer-Wold theorem: if all 1D projections match, the full distribution matches
- Uses Epps-Pulley test statistic for normality checking
- Hyperparameter tuning: O(log n) bisection search (vs O(n^6) grid search in prior work)

### Benchmark Results

| Environment | Type | LeWM vs PLDM | LeWM vs DINO-WM | Notes |
|-------------|------|-------------|-----------------|-------|
| Two-Room | 2D navigation | Mixed | -- | Struggles with low intrinsic dimensionality |
| Reacher | 2-joint arm | Better | Better | |
| Push-T | Block manipulation | Better | Better | Even without proprioceptive inputs |
| OGBench-Cube | 3D robotic pick-place | Better | Worse | DINOv2 encoder has richer visual priors |

### Planning Speed

- LeWM: ~1 second per planning step (each frame = single 192-dim token)
- DINO-WM: ~47 seconds per planning step (~200x more tokens)
- **48x speedup**

### Limitations

- Tested only in simulated environments
- Struggles with very simple (low-dimensional) and very complex (real-world visual) scenes
- SIGReg behavior at billion-parameter scale is unknown
- No real-world sensor data validation yet

### Why It Matters for Smart Glasses

The 15M parameter count is the key. At ~60MB unquantized, potentially ~15-20MB with INT8, this fits comfortably on a mobile NPU. The planning speed (1 second) means real-time reactive behavior is achievable.

---

## EB-JEPA Library (December 2025) -- Training Framework

**Code:** [github.com/facebookresearch/eb_jepa](https://github.com/facebookresearch/eb_jepa) (543 stars)
**Authors:** Meta FAIR

### What It Is

An open-source reference library for JEPA training, not a deployable model. Contains modular examples for:

- Image representation learning (I-JEPA style)
- Video representation learning (V-JEPA style)
- Action-conditioned video world models
- Planning with JEPA-based world models

### Key Properties

- All examples trainable on single GPU in a few hours
- Modular and well-documented for research and education
- Demonstrates energy-based self-supervised learning patterns

### Use Case

For training custom JEPA models on your own data (e.g., egocentric glasses footage). Not for direct deployment.

---

## Comparison Matrix

| Property | V-JEPA 2 | LeWorldModel | EB-JEPA |
|----------|----------|-------------|---------|
| Parameters | 300M-1.2B | ~15M | Varies |
| Pre-trained weights | Yes (HF) | Yes (sim only) | No (training lib) |
| Real-world tested | Yes | No (sim only) | N/A |
| Egocentric video | Yes (Epic-Kitchens) | No | N/A |
| Edge-deployable | With quantization | Potentially native | N/A |
| License | MIT | Public | Research |
| Code maturity | High (3.5k stars) | Low (new) | Medium (543 stars) |
| Smart glasses ready | Closest | Future | Training only |

---

## Other Notable JEPA Variants

| Model | Date | Focus | Key Contribution |
|-------|------|-------|-----------------|
| I-JEPA | 2023 | Images | Original image JEPA, semantic representation learning |
| V-JEPA | 2024 | Video | Video JEPA, learned physics from video |
| VL-JEPA | Dec 2025 | Vision-Language | Predicts text embeddings instead of generating tokens |
| EchoJEPA | 2025 | Medical | Ultrasound video analysis |
| LeJEPA | Nov 2025 | General | Community implementation, 993 stars |
| Drive-JEPA | 2025 | Autonomous driving | Trajectory prediction for self-driving |
| LEGA | Nov 2025 | Training stability | Gaussian geometry constraint for embeddings |
