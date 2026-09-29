# ADR-0057: Local web security authority

- Status: Accepted
- Date: 2026-09-30
- Deciders: FdbTrade private operator
- Supersedes: fragmented local web security assumptions
- Related: ADR-0008, ADR-0024, ADR-0025, ADR-0037, ADR-0038, ADR-0043
- Work unit: R1.11

## Context

The private web application already used loopback launch commands, opaque durable
sessions, restricted local files and middleware headers, but mutation origin,
login abuse, session rotation and response redaction were not one behavior-tested
authority. Forwarded client headers and process restart could not be treated as
identity evidence.

## Decision

1. Every API wrapper rejects non-loopback targets and rejects cross-site or
   mismatched-Origin unsafe methods before route logic executes.
2. Login failures are throttled by a bounded, hashed normalized-user key; no
   username, password, token or address is retained by the throttle.
3. Successful login atomically revokes older sessions; password provisioning
   also revokes every durable session. Rotated sessions remain durable on restart.
4. API responses receive restrictive CSP, framing, MIME, referrer, permission
   and cross-origin-resource headers even when middleware is bypassed.
5. Structured error details recursively redact secret-shaped keys and unknown
   exceptions remain generic.
6. Runtime services remain bound to `127.0.0.1`; SQLite/data/artifact/runtime
   files retain 0700 directories and 0600 files.

## Consequences

Cross-origin browser mutations and LAN-target requests fail before business
logic. A successful login invalidates previous browser sessions by design.
Process-local login throttle state may reset on restart, while session revocation
and rotation remain durable in SQLite.

## Verification

Adversarial tests cover cross-origin, cross-site and non-loopback requests,
secret response details, throttling, session rotation/restart and file modes.
Static contracts lock loopback launch commands, redaction, headers, progression,
preservation and the canonical gate.
