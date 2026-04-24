# JEPA Explained: Core Concepts

## The Problem with Generative AI for Vision

Current AI vision models (Sora, DALL-E, etc.) predict raw pixels. Given a video of a tree swaying in wind, a generative model tries to predict exactly where every leaf will be. This is:

- **Computationally expensive** -- predicting millions of pixels per frame
- **Fundamentally wasteful** -- leaf positions are chaotic and unpredictable
- **Missing the point** -- what matters is "tree swaying," not exact leaf coordinates

## The JEPA Alternative

JEPA (Joint-Embedding Predictive Architecture) shifts the learning target from pixels to abstract representations (embeddings).

### How it works:

```
1. ENCODER turns video patches into embeddings (abstract summaries)
2. PREDICTOR tries to predict embeddings of hidden/future patches
3. TARGET ENCODER provides the "correct" embeddings for comparison
4. Loss = difference between predicted and actual embeddings
```

The key insight: two frames showing "a hand reaching for a cup" from different angles have very different pixels but nearly identical embeddings. JEPA learns in this meaning space.

### Core Components

| Component | Role | Analogy |
|-----------|------|---------|
| Context Encoder | Turns visible video patches into features | Your eyes processing what you can see |
| Predictor | Predicts features for hidden/future patches | Your brain filling in what's behind the obstruction |
| Target Encoder | Provides ground truth features (slowly updated copy) | The actual movie you're trying to follow |
| Embedding | Abstract vector representation of a video patch | A summary that captures meaning, not appearance |

### Training Method: Self-Supervised Masking

During training, 75% of the video is masked out. The model only sees 25% and must predict the hidden parts in embedding space. No labels required -- the hidden patches are the answer key.

After training on millions of videos, the encoder develops understanding of:
- Object permanence (things exist even when occluded)
- Physics (gravity, momentum, collisions)
- Cause and effect (actions and their consequences)
- Motion patterns (walking, reaching, falling)

### Avoiding Representation Collapse

The biggest challenge in JEPA training is **collapse** -- the model finds a shortcut where it maps everything to the same vector, achieving zero loss without learning anything.

Solutions evolved over time:

| Method | How It Prevents Collapse | Tradeoff |
|--------|------------------------|----------|
| EMA (Exponential Moving Average) | Target encoder updates slowly, creating a moving target | Fragile, requires careful tuning |
| VICReg / Barlow Twins | Regularizes embeddings to spread across dimensions | Multi-term loss, 6 hyperparameters |
| LEGA (Nov 2025) | Constrains geometry to isotropic Gaussian | Newer, less tested |
| SIGReg (LeWorldModel, Mar 2026) | Enforces Gaussian distribution via Cramer-Wold theorem | Simplest yet -- 1 hyperparameter |

## Why JEPA Matters for Smart Glasses

| Property | Generative Model | JEPA |
|----------|-----------------|------|
| Predicts | Raw pixels (millions of values) | Abstract embeddings (hundreds of values) |
| Compute needed | Very high (GPU required) | Much lower (potentially mobile NPU) |
| Handles camera shake | Poorly -- every pixel change is "important" | Well -- abstract representations are stable |
| Object permanence | None -- out of frame = gone | Retained in embedding space |
| Temporal understanding | Frame-by-frame | Continuous world model |
| Battery impact | High | Low |
| Privacy | Often requires cloud | Can run on-device |

## The "Car Behind a Tree" Analogy

A red car drives behind a large tree.

**Generative model:** Must hallucinate the exact shade of red, windshield reflections, and leaf patterns to generate the missing frames. Gets it slightly wrong = uncanny valley.

**JEPA model:** Updates its internal state: "solid object moving at constant velocity behind another solid object." No pixel generation. Just physics understanding.

## Key People and Organizations

- **Yann LeCun** -- Turing Award winner, proposed JEPA in 2022 ("A Path Towards Autonomous Machine Intelligence"), left Meta late 2025
- **AMI Labs** -- LeCun's new company, raised $1.03B at $3.5B valuation (March 2026), building world models
- **Meta FAIR** -- Published V-JEPA 2 (June 2025), EB-JEPA library, continues JEPA research
- **Mila / NYU / Samsung SAIL** -- Published LeWorldModel (March 2026)

## References

- LeCun, Y. (2022). "A Path Towards Autonomous Machine Intelligence." [OpenReview](https://openreview.net/pdf?id=BZ5a1r-kVsf)
- Assran, M. et al. (2025). "V-JEPA 2." [arXiv:2506.09985](https://arxiv.org/abs/2506.09985)
- Maes, L. et al. (2026). "LeWorldModel." [arXiv:2603.19312](https://arxiv.org/abs/2603.19312)
