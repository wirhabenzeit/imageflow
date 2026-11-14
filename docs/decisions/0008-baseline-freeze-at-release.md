# ADR 0008: The contract-1 baseline is fixed at the first public release

Status: accepted. Amends ADR 0007. Discussed in #115.

## Context

ADR 0007 fixed the contract-1 baseline at once, so every later feature became an extension that templates declare in `requires`. `inline-editors` (#102) was the first. No version of ImageFlow had been released: there were no release tags, and the only templates were the bundled samples and documentation examples. The freeze protected no template, while each new feature added a `requires` entry, `capabilities` bookkeeping and documentation about extensions.

## Decision

Contract 1 stays open until ImageFlow's first public release.

- Until then, additive features join `contract1Capabilities` in `src/runtime-exports.ts`. Templates and examples use them without `requires`. `inline-editors` is the first to move into the baseline.
- At the first public release the baseline is fixed. From then on, `requires` and `capabilities` work as ADR 0007 describes: additive extensions are appended to `capabilities` and declared in `requires`, and a breaking change needs a new contract.
- The baseline never shrinks. Names that were once extensions stay accepted in `requires`, like every baseline name.
- Development builds before the release are not supported implementations of contract 1, as ADR 0007 already states for earlier builds.

## Consequences

- New v1 features, such as list parameters (#115), ship as baseline features with no `requires` entry.
- The runtime, the authoring SDK's `Capability` type, the MCP authoring context and the API docs must agree with the baseline as it grows.
- The release process must record the frozen baseline, for example by tagging the release and treating `contract1Capabilities` at that tag as final.
