# ADR 0007: Template contract-1 baseline

Status: accepted. Implements #92 C and D.

## Decision

`contract: 1` guarantees all features in `contract1Capabilities` in `src/runtime-exports.ts`. This includes the calendar's editor context and document editors, and the map's network declarations and asynchronous rendered images. Shipped templates and authoring examples omit `requires` for these features.

That baseline is fixed. Later additive extensions are appended to `capabilities` and declared in a template's optional `requires` list. An app rejects an unsupported extension at template load, with an update hint. A breaking change needs a new contract.

Older templates' explicit lists of baseline features remain accepted. The runtime `capabilities` export keeps all baseline names, and MCP authoring context reports both the guaranteed `baseline` and all supported `capabilities`. Earlier development builds are not supported implementations of the frozen v1 contract; no minimum-runtime field is introduced for those builds.

Type 3 fonts and fonts outside the template bundle are always rejected by print preflight. The old `output.fonts` field is deprecated because its only valid values express those same platform rules. Existing declarations with both flags set to `false` still load, while `true` remains invalid. Templates omit the field; their saved content and format selection are not rewritten.

## Consequences

- Template authors select a coherent API with `contract: 1` instead of copying feature lists.
- The baseline, authoring declarations, complete examples and API documentation must agree.
- Network features still require user approval. A contract guarantee is not a permission grant.
- Text fallback, generated authoring declarations, scaling helpers, enum shorthand and editor geometry remain separate additive work from #92. Persistent offline snapshots remain in #94.
