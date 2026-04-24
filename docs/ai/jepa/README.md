# JEPA Research for Smart Glasses

Joint-Embedding Predictive Architecture (JEPA) research documentation for integration with the MWDAT iOS app and Meta Ray-Ban smart glasses.

## What is JEPA?

JEPA is an AI architecture proposed by Yann LeCun that learns by predicting abstract representations (embeddings) of data rather than reconstructing raw pixels or tokens. Instead of asking "what will the next pixel look like?", JEPA asks "what is the semantic state of the next frame?"

This makes it fundamentally more efficient than generative models for real-time video understanding on edge devices like smart glasses.

## Documents

| Document | Description |
|----------|-------------|
| [01-jepa-explained.md](01-jepa-explained.md) | Core JEPA concepts, architecture, and why it matters |
| [02-active-models.md](02-active-models.md) | V-JEPA 2, LeWorldModel, EB-JEPA -- status, params, code links |
| [03-smart-glasses-application.md](03-smart-glasses-application.md) | How JEPA applies to live streaming smart glasses (MWDAT) |
| [04-quantization-and-edge.md](04-quantization-and-edge.md) | Optimization path: ST-A2, INT8, ONNX, CoreML deployment |
| [05-integration-pipeline.md](05-integration-pipeline.md) | Practical integration with MWDAT iOS StreamSession pipeline |
| [06-research-timeline.md](06-research-timeline.md) | Timeline of JEPA publications, AMI Labs, and ecosystem |
| [07-use-cases-and-cloud-architecture.md](07-use-cases-and-cloud-architecture.md) | 9 concrete use cases with revenue models + cloud GPU architecture |

## Key Takeaways

1. **V-JEPA 2 is production-ready** -- 1.2B params, proven on egocentric video (Epic-Kitchens-100), MIT-licensed code and weights available
2. **LeWorldModel is the edge play** -- 15M params, single GPU training, 48x faster planning, but only tested in simulation
3. **Quantization path exists** -- ST-A2 achieves 4x attention reduction with 97.4% accuracy retention
4. **Egocentric video is proven** -- V-JEPA 2's action anticipation on Epic-Kitchens-100 directly validates the glasses use case
5. **Cloud GPU is the right deployment** -- relay server already receives video, add GPU sidecar. ~$0.10-0.15/stream/hour. 150-280ms latency.
6. **JEPA is not GPT-4V** -- continuous stream understanding + prediction, not snapshot Q&A. They complement each other.

## PRD

- [PRD-020: JEPA Vision Node](../../prds/infrastructure/PRD-020-jepa-vision-node.md) -- Full spec for integrating JEPA as a parallel workflow node

## Links

- [V-JEPA 2 Paper](https://arxiv.org/abs/2506.09985) (June 2025)
- [LeWorldModel Paper](https://arxiv.org/abs/2603.19312) (March 2026)
- [V-JEPA 2 Code](https://github.com/facebookresearch/vjepa2) (3.5k stars, MIT)
- [EB-JEPA Library](https://github.com/facebookresearch/eb_jepa) (543 stars)
- [LeWorldModel Code](https://github.com/lucas-maes/le-wm)
- [LeCun's AMI Labs](https://techcrunch.com/2026/03/09/yann-lecuns-ami-labs-raises-1-03-billion-to-build-world-models/) ($1.03B raised, March 2026)
