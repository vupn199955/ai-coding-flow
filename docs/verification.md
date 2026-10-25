# Verification record

Verified locally on **2026-10-25** with Node.js 22.13.0.

## Automated checks

- **42 tests passed** across eight files.
- TypeScript checks passed for the server, dashboard, and shared contracts.
- The production build passed.
- Formatting checks passed.
- Dependency audit: zero reported vulnerabilities.

Tests exercise the Codex JSON-RPC handshake with a fake executable, model/effort validation, review schema invariants, Markdown dependency graphs, configuration capture, SQLite recovery, actual process exits/timeouts/cancellation, clean-commit checks, blocking review repairs, failed-check repairs, final-plan repairs, pause/resume after integration, token limits, API validation/origin restrictions, and live-stream shutdown.

## Project workflow update

- Registered an external repository through the dashboard folder browser and confirmed its canonical path becomes the project repository path.
- Confirmed model dropdowns use the installed Codex catalog, including supported reasoning efforts; no model turns were started during this check.
- Created a queued workflow through the UI with a separately entered task-directory path. Confirmed its Markdown documents appear under the selected project's `.ai-flow/runs/<id>`.
- Started a deterministic demo as a second project, switched back to the first project, and confirmed each project shows only its own workflows. The demo completed with real checks and automatic commits.
- Automated tests run two projects concurrently, pause/resume one independently, reject simultaneous starts within the same project, preserve ignored root/scoped instructions and local skills in worktrees, and verify descriptive commits and exact review hashes.
- Automated API/store tests cover project settings capture, canonical path deduplication, directory browsing, legacy workflow association, and workflow removal across restart while preserving project artifacts.
- Read effective configuration layers from the installed native Codex app-server in an isolated worktree. It reported an untrusted project layer as disabled. A runtime regression test verifies AI Flow reports that trust issue and stops before `thread/start`.

These update checks used temporary repositories and a separate controller database. They made no paid model calls and did not modify the user's global Codex trust settings. The real Codex execution and container checks below are earlier baseline evidence; they were not repeated for this update.

## Real Codex execution

The installed runtime advertised GPT-6.1 Sol with Low, Medium, High, Extra High, Max, and Ultra efforts. A real single-task run used **GPT-6.1 Sol at Low effort** in an isolated fixture repository. It generated a greeting utility and four passing unit tests, received task approval, passed combined verification, and received final plan approval.

The first review invocation reached the initial 100,000-token run budget. The controller interrupted it, preserved its reported usage, and entered `needs_attention`. After an explicit increase to 400,000 tokens, the run resumed and completed.

| Invocation                  | Status                      | Reported tokens |
| --------------------------- | --------------------------- | --------------: |
| Implementer                 | Completed                   |          69,349 |
| First reviewer invocation   | Interrupted at budget limit |          35,037 |
| Resumed reviewer invocation | Completed                   |          51,560 |
| Final plan reviewer         | Completed                   |          69,694 |
| **Total**                   |                             |     **225,640** |

Reported totals include repeated/cached input context. They are not unique text volume or a monetary invoice. The dashboard displayed 224,164 input tokens, of which 165,632 were cached, and 1,476 output tokens. Cached tokens were not added twice.

The fixture source branch remained unchanged. The reviewed output commit was `85db5b54dd0db357c4fe911a5def250d84c2cda7` on `ai-flow/5a935c6d-8b41-45a1-bc6c-18c09c8fe207` in the isolated live-verification repository. The locally retained dashboard history includes that run and its Markdown reviews.

## Dashboard and container checks

- Opened the local dashboard in Chrome and started the complete demo through the UI.
- Confirmed the demo’s initial rejection, requested change, subsequent approval, dependency order, and final review.
- Checked the live usage table against recorded invocation totals.
- Refreshed the Codex model catalog and selected Ultra through the implementer’s effort menu, then restored High without changing saved defaults.
- Built the Docker image and validated the Compose configuration.
- Started the image on a loopback-only test port and completed the two-task no-model-call demo inside the container.

The demo exercises real file writes, Git commits, and unit tests; its agents and review verdicts are deterministic. The live Codex run is separate evidence for actual model execution. Remote GitHub/GitLab pipelines, real infrastructure deployment, and real Codex execution inside Docker were not exercised.
