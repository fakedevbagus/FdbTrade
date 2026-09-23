# ADR-0044: Crash-consistent local recovery

- Status: Accepted
- Date: 2026-09-23
- Deciders: FdbTrade private-beta owner
- Supersedes: Publication protocol details in ADR-0043 decisions 5 and 6
- Related: ADR-0005, ADR-0025, ADR-0037, ADR-0039, ADR-0041, ADR-0042, ADR-0043
- Work unit: R0.11

## Context

R0.10 established a correct logical SQLite/artifact backup and restore set, but
its publication sequence did not prove crash durability. A backup directory
was renamed before its complete verification, restore copied directly into the
visible target, file and directory fsync ordering was not explicit, and the
manifest parser accepted fields and filesystem shapes outside its contract.
The operational UI also needed route-level evidence, while the health test
still exercised an obsolete process-local risk store despite production using
the R0.9 SQLite latch.

R0.11 closes only those integrity and evidence gaps. It does not add a product,
provider, model-promotion path, execution authority or migration.

## Decision

1. A backup is assembled entirely in a private staging directory created
   beneath the requested output root. The SQLite online snapshot and every
   R0.6 market-data and R0.8 research artifact are copied there. The exact
   migration ledger, database integrity, foreign keys, artifact set, manifest
   and literal-false safety flags are verified before publication.
2. The database snapshot, every artifact, the manifest, every relevant staging
   directory and the output parent are fsynced before one atomic rename. The
   output parent is fsynced again after rename. Any pre-rename failure removes
   only the exact generated staging root and cannot create a final backup path.
3. `backup_created` is appended to SQLite only after the durable rename. A
   crash after rename but before that transaction leaves a valid evidence set,
   but SQLite has not claimed the backup. The directory is immutable evidence,
   never mutable metadata authority.
4. Restore verifies the complete backup before touching the target. The target
   must be absolute and either absent or a real, genuinely empty directory. A
   sibling staging root is populated on the target filesystem, verified,
   given its `restore_verified` event, checkpointed, closed and fsynced before
   one atomic rename. A non-empty target is never removed or overwritten, and
   no partial restore becomes visible.
5. Manifest schema version 2 is emitted by R0.11. It strictly fixes object
   fields, types, migration rows, artifact authorities and paths, safety flags,
   the exact filesystem entry set and the interpretation of SHA-256 as
   integrity evidence only—not cryptographic authenticity. Strict R0.10
   schema-version-1 manifests remain readable for local recovery, but their
   historical publication is not retroactively claimed to be crash-durable.
   The two known SQLite sidecars that R0.10 verification could leave are
   recognized as ignored legacy residue; they are neither trusted nor copied.
6. Absolute or escaping manifest paths, non-canonical paths, symbolic-link
   leaves or parent components, unlisted files/directories, and non-regular
   entries fail closed. Recursive cleanup is limited to roots created by the
   current operation with `mkdtemp`; no broad data-root deletion is allowed.
7. Health reads the R0.9 SQLite risk event stream. File-backed behavior proves
   green, durable kill across close/reopen, and explicit release to red. The
   operations overview remains read-only; durable controls remain limited to
   engage kill, release kill and force non-kill state.
8. SQLite remains the only mutable durable metadata authority. Universe,
   timeframe, R0.6–R0.9 authority, persisted risk-before-paper requirement,
   latched kill behavior and the R0.10 projection boundary remain unchanged.
   Live execution, provider-order transport and credentialed provider
   selection remain off.

## Consequences

- A successful command now means its local evidence set crossed a tested
  verify/fsync/rename boundary; failures before that boundary expose no final
  path.
- A published but unclaimed backup is intentionally distinguishable from a
  SQLite-claimed backup. Operators may verify and restore it, but must not infer
  a missing operational event.
- Empty existing restore directories may briefly be absent at the final rename
  boundary; if publication fails after removing that empty directory, it is
  recreated empty. Operator content is never replaced.
- Version-1 compatibility is a format and integrity claim only. R0.11 makes no
  authenticity, remote-disaster-recovery, availability or profitability claim.

## Verification

- Python behavior tests inject faults after snapshot, artifact copy, manifest,
  verification, before rename, after rename/before event, and before restore
  publication. They prove absence of partial final paths and the unclaimed
  post-rename state.
- Trace-backed tests prove verification and fsync of the database, both R0.6
  and R0.8 artifacts, manifest and directories precede rename.
- Negative tests cover database tamper, malformed or extended manifests,
  literal-true safety flags, absolute/escaping paths, symlinks, non-empty
  targets, migration drift and strict R0.10 compatibility.
- Backend tests exercise authenticated operations and durable-control routes,
  plus file-backed risk health across close/reopen without the process store.
- Migration count and order remain nine through
  `0009_operational_hardening`; `make toolchain-gate` is the final authority.
