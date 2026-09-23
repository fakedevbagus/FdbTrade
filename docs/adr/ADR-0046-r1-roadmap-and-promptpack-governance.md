# ADR-0046: R1 roadmap and prompt-pack governance

- Status: Accepted
- Date: 2026-09-24
- Deciders: FdbTrade private operator
- Supersedes: future scheduling in `POST_PHASE2_BLUEPRINT_PROMPT_PACK.md`
- Related: ADR-0037, ADR-0038, ADR-0039, ADR-0040, ADR-0041, ADR-0042, ADR-0043, ADR-0044, ADR-0045
- Work unit: R1.0

## Context

The post-Phase-2 pack planned M44-M53, but the selective rebuild subsequently
established a different and stronger R0.1-R0.12 authority chain. Continuing the
old sequence would duplicate completed work and could incorrectly promote the
quarantined M48 provider code or legacy fixture surfaces.

Development also needs a durable handoff mechanism: one small unit per chat,
with enough local context that a new agent can verify the actual predecessor
instead of relying on conversational history.

## Decision

1. `docs/roadmap/FDBTRADE_R1_BLUEPRINT_PROMPT_PACK.md` is the canonical R1
   roadmap and prompt source.
2. R1 remains a Linux-local, private single-user decision-support and
   operator-confirmed paper-trading product. Demo/live execution, remote access
   and provider-order transport are outside R1.
3. Work proceeds in the recorded R1.1-R1.24 dependency order. Each unit needs
   separate explicit authorization and exactly one atomic commit.
4. A unit starts by verifying checkout, predecessor authority, the canonical
   gate, migration order, safety flags and all ten M48 hashes.
5. A unit closes only with observable focused evidence, the complete 15-command
   toolchain gate, an authority artifact, checkpoint and `NEXT.md` handoff.
6. The prompt pack never grants standing authorization. Ambiguous continuation
   language cannot start a later unit.
7. Provider and macro-source choice units produce decision dossiers and stop;
   integration prompts are invalid until the operator names the exact source.
8. The old post-Phase-2 pack remains historical evidence but no longer
   controls future milestone order.

## Consequences

- New chats can resume from repository authority instead of copied chat history.
- The roadmap is longer but each change is bounded, reviewable and reversible.
- Later units may be re-planned only through an explicit blueprint amendment;
  implementations cannot silently expand their own scope.
- R0 authorities, M48 quarantine and all execution safety defaults remain
  intact.

## Verification

`tests/test_r10_blueprint_promptpack_contracts.py` verifies the canonical file,
ordered prompt set, safety language, machine-readable authority, checkpoint and
handoff. The final acceptance command remains `make toolchain-gate`.
