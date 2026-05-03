# JEPA Research Timeline

## Key Publications and Events

### 2022

| Date | Event | Significance |
|------|-------|-------------|
| Jun 2022 | LeCun publishes "A Path Towards Autonomous Machine Intelligence" | Position paper proposing JEPA as alternative to generative AI. Introduced the concept of predicting in latent space rather than pixel/token space. |

### 2023

| Date | Event | Significance |
|------|-------|-------------|
| Jun 2023 | **I-JEPA** published (Assran et al.) | First practical JEPA implementation for images. Learned semantic image representations without generating pixels. Demonstrated the concept works. |

### 2024

| Date | Event | Significance |
|------|-------|-------------|
| Feb 2024 | **V-JEPA** published (Bardes et al.) | Extended JEPA to video. Learned physics from video without labels. Showed object permanence and motion understanding. |

### 2025

| Date | Event | Significance |
|------|-------|-------------|
| Jun 2025 | **V-JEPA 2** published (Assran et al., Meta FAIR) | Major leap. 1M+ hours video, 1.2B params. State-of-the-art on action anticipation (Epic-Kitchens-100), video QA, and zero-shot robot control. MIT-licensed code and weights released. |
| Jun 2025 | V-JEPA 2-AC variant | Post-trained with 62 hours of robot data for zero-shot physical planning. |
| Nov 2025 | **LEGA** published | New regularization approach constraining embedding geometry to isotropic Gaussian. |
| Nov 2025 | **LeJEPA** released (community) | Open-source JEPA implementation by galilai-group. 993 GitHub stars. |
| Dec 2025 | **VL-JEPA** published | Vision-Language JEPA. Predicts text embeddings instead of generating tokens. Designed for streaming video understanding. |
| Dec 2025 | **EB-JEPA** library released (Meta FAIR) | Open-source reference library for JEPA training. Modular examples for image, video, and action-conditioned models. 543 GitHub stars. |
| Late 2025 | Yann LeCun leaves Meta FAIR | Founded AMI Labs to pursue world model research. |

### 2026

| Date | Event | Significance |
|------|-------|-------------|
| Feb 2026 | **ST-A2** published (Shchybovyk) | 4x attention reduction in V-JEPA 2 with 97.4% accuracy retained. Drop-in compatible with Meta's pretrained weights. Makes inference practical for edge. |
| Mar 2026 | **LeWorldModel** published (Maes et al.) | First stable end-to-end JEPA from raw pixels. 15M params, single GPU, 2 loss terms, 1 hyperparameter. 48x faster planning. Authored by LeCun + team from Mila/NYU/Samsung. |
| Mar 2026 | **AMI Labs raises $1.03B** | Europe's largest seed round. $3.5B valuation. Backed by Bezos Expeditions, NVIDIA, Samsung, Toyota Ventures. First year on pure research. |
| Mar 2026 | World Labs (Fei-Fei Li) raises $1B | Competing world model company. Signals major investment in the space. |
| Apr 2026 | General Intuition raises $133.7M | Another world model startup. |
| Apr 2026 | Decart raises $100M at $3.1B | World model / generative AI company. |

## Investment Landscape (as of April 2026)

| Company | Founder | Funding | Valuation | Focus |
|---------|---------|---------|-----------|-------|
| AMI Labs | Yann LeCun | $1.03B seed | $3.5B | World models, JEPA |
| World Labs | Fei-Fei Li | $1B+ | Undisclosed | Spatial intelligence |
| Decart | Undisclosed | $100M | $3.1B | Generative AI, world models |
| General Intuition | Undisclosed | $133.7M | Undisclosed | World models |

## Code Ecosystem

| Repository | Org | Stars | Focus | License |
|-----------|-----|-------|-------|---------|
| [vjepa2](https://github.com/facebookresearch/vjepa2) | Meta FAIR | 3,500 | V-JEPA 2 training + inference | MIT |
| [eb_jepa](https://github.com/facebookresearch/eb_jepa) | Meta FAIR | 543 | JEPA training library | Research |
| [le-wm](https://github.com/lucas-maes/le-wm) | Lucas Maes | New | LeWorldModel implementation | Public |
| [lejepa](https://github.com/galilai-group/lejepa) | galilai-group | 993 | Community JEPA implementation | Custom |
| [I-JEPA](https://github.com/facebookresearch/ijepa) | Meta FAIR | ~2k | Image JEPA | MIT |
| [V-JEPA](https://github.com/facebookresearch/vjepa) | Meta FAIR | ~1.5k | Original video JEPA | MIT |

## Hugging Face Models

| Model ID | Variant | Size | Resolution | Frames |
|----------|---------|------|-----------|--------|
| `facebook/vjepa2-vitl-fpc64-256` | ViT-L | ~300M | 256x256 | 64 |
| `facebook/vjepa2-vitl-fpc16-384` | ViT-L | ~300M | 384x384 | 16 |
| `facebook/vjepa2-vitg-fpc64-384` | ViT-G | ~1.2B | 384x384 | 64 |

## Key Research Questions (Open)

1. **Scaling SIGReg** -- Does LeWorldModel's Gaussian regularization hold at 1B+ parameters?
2. **Real-world deployment** -- How do JEPA embeddings handle real camera noise, motion blur, low light?
3. **Mobile-friendly backbones** -- Will Meta or community release MobileViT / EfficientFormer JEPA variants?
4. **IMU fusion** -- Can accelerometer/gyroscope data improve JEPA predictions for head-mounted cameras?
5. **Continuous learning** -- Can LeWorldModel fine-tune on-device without catastrophic forgetting?
6. **Language grounding** -- How to efficiently bridge JEPA embeddings to natural language on edge devices?

## Recommended Reading Order

1. LeCun (2022) -- "A Path Towards Autonomous Machine Intelligence" (position paper, conceptual)
2. I-JEPA (2023) -- First practical demonstration
3. V-JEPA 2 (2025) -- State-of-the-art, relevant to egocentric video
4. LeWorldModel (2026) -- Edge-optimized, stable training breakthrough
5. ST-A2 (2026) -- Practical optimization for deployment
