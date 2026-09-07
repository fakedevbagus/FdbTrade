# FdbTrade — Cline Workflow Rules

## Plan mode
Use Plan mode for repository discovery, architecture decisions, impact analysis, test strategy, and task planning. Do not modify files in Plan mode.

## Act mode
Use Act mode only after the active prompt is understood. Implement exactly the approved scope, run verification, and produce the completion report.

## One prompt = one bounded change
- Execute only one prompt/task at a time.
- Do not pull work from later prompts “because it is easier”.
- If a later-phase dependency is missing, create the minimum interface/stub needed only when the active prompt explicitly permits it; otherwise report the blocker.
- Never mark a task complete because future prompts will fix it.

## Recovery after interruption
When context is lost or a task is resumed:
1. Read `.clinerules/`.
2. Read `00_CONTROL/RUN_ORDER.md`.
3. Read `03_REFERENCE/BLUEPRINT_V2_FROZEN.md`.
4. Read the latest completion report available in the repository.
5. Inspect git status and the current working tree.
6. Reconstruct the active prompt's acceptance criteria before changing files.

## Git discipline
- Inspect `git status` before work.
- Prefer a focused commit for each prompt when the repository workflow permits it.
- Never reset, clean, force-checkout, or rewrite history without explicit user approval.
