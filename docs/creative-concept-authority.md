# Creative Concept authority contract

Strategy-linked Creative Concept generation treats the immutable `CreativeInputSnapshot` as the authority boundary.

| Concept data | Authority | Behavior |
| --- | --- | --- |
| `angle` | `CANONICAL_FROM_STRATEGY` | Copied from `selectedStrategy.coreAngle`; absent from the provider execution schema. |
| `hook` | `CANONICAL_FROM_STRATEGY` | Copied from the strategic hook. Scene overlay and narration may paraphrase it without changing the proposition. |
| Strategy CTA intent | `CANONICAL_FROM_STRATEGY` | Retained inside `selectedStrategy.ctaStrategy` for validation and provenance. |
| `cta` copy | `CANONICAL_FROM_PRODUCT` | Copied from snapshot `defaultCta`; the provider controls placement, not current offer authority. |
| Product claims and restrictions | `CANONICAL_FROM_PRODUCT` | Provider execution is checked for unsupported claims and cannot add authority. |
| Product reference assets and fidelity constraints | `CANONICAL_FROM_PRODUCT` | Only selected assets may be referenced; fidelity requirements are injected into scene accuracy requirements. |
| Winner DNA | `CANONICAL_FROM_WINNER_DNA / provenance` | Exact approved revision remains snapshotted. It controls execution tendencies only. |
| `strategyExecutionSummary`, narration, scene purpose/prompt/overlay, editing and music | `PROVIDER_EXECUTION` | Generated under structural, semantic, truth, SKU, offer, and Winner-DNA validation. |
| Target duration and merged scene accuracy requirements | `DERIVED_APPLICATION_FIELD` | Duration comes from the snapshot when present; accuracy requirements merge deterministic canonical constraints. |

Assembly order is: validate immutable snapshot checksum, call the execution-only provider schema, validate structure and execution semantics, mechanically normalize, inject canonical fields, persist the reviewed concept. A rejected result is stored only as bounded sanitized provider-operation evidence and never becomes a Creative Concept or scene workflow.
