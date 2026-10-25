# AI Flow

A local coding workflow with an implementer, an independent reviewer, automated checks, and a live web dashboard.

Give it a Markdown task or a directory of related tasks. It investigates and implements, runs your repository’s checks, requests an independent review, and repairs blocking findings until approved or a configured limit is reached. Completed changes stay on a separate Git branch.

## Quick start

Requires **Node.js 22.13+**, npm, and Git. The real agent runtime also needs the Codex CLI and an authenticated account.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:3000**. Click **Try a demo** to exercise the complete loop without model calls. The demo writes real code, runs real Node unit tests, rejects the first implementation, repairs the defect, approves two dependent tasks, and performs a final combined review. Demo reviews are deterministic and explicitly labeled.

For a production build on your machine:

```sh
npm run build
npm start
```

The dashboard listens on port `3000`; the local controller listens on `4310`. Both bind to loopback by default. Change ports with `FLOW_WEB_PORT` and `FLOW_API_PORT` when starting **and building** the application; the Next.js API proxy captures its destination at build time.

## Run real coding agents

1. Install [Codex CLI](https://learn.chatgpt.com/docs/cli) and run `codex login`. If the executable is not on PATH, set `CODEX_BIN` to its absolute path.
2. Open **Agents → Refresh Codex catalog**. Select the model and reasoning effort for each role, then save. GPT-6.1 Sol and Ultra are selectable when advertised by your runtime. Unsupported combinations fail explicitly; they are never silently replaced. A catalog entry is not an entitlement guarantee—actual model access is confirmed by a successful invocation.
3. Open **Settings**. Choose an absolute repository path and task path. The repository must have a clean working tree and at least one commit. The task path can be one `.md` file or a directory of `.md` files.
4. Set the repository’s actual checks. At least one must be a unit-test check. Configure active runtime, reported token, check-repair, and review-round limits.
5. Click **New run**. Preview or select tasks if desired; required dependencies are included automatically. Start the run and follow Activity, Reviews, Checks, Changes, and Usage.

You can keep working in the source repository: execution takes place in managed Git worktrees. AI Flow does not switch your source branch, automatically merge into it, push code, or deploy the result.

### Markdown task format

```markdown
---
id: create-users
depends_on: []
---

# Add user creation

## Requirements

- Add POST /users using the repository’s existing conventions.
- Validate input and reject duplicate email addresses.

## Acceptance criteria

- Valid input creates and returns a user.
- Invalid input returns the established validation response.
- Duplicate email returns HTTP 409.
- Existing behavior remains compatible.

## Required tests

- Successful creation.
- Invalid input.
- Duplicate email.
- Repository failure.
```

For a dependent task, use `depends_on: [create-users]`. IDs must be unique and contain only letters, digits, underscores, and hyphens. Missing dependencies and cycles are rejected before execution. Tasks run sequentially in dependency order; parallel scheduling is not part of this first version.

Examples are in [`examples/tasks`](examples/tasks). Test command recipes for JavaScript, TypeScript, React, NestJS, Next.js, CDK, Docker, GitHub Actions, and GitLab CI are in [`docs/check-recipes.md`](docs/check-recipes.md).

## What the loop guarantees

- The controller owns scheduling, snapshots, budgets, and completion decisions.
- The implementer and reviewer use separate Codex sessions with independent model/effort settings.
- The implementer works in its assigned workspace. The reviewer receives read-only repository access and a structured output schema.
- Configured commands run independently of the agents. Command output, exit codes, durations, and the tested commit are recorded.
- A reviewer approval cannot contain blocking findings. A rejection must contain an actionable blocking finding.
- Approval is bound to an exact clean commit. A changed snapshot cannot pass on a stale approval.
- Every task is checked and reviewed; the combined plan receives checks and a final independent review.
- Run configuration and task content are captured when the run is created. Later edits to defaults apply to new runs. Limits can be explicitly adjusted for a paused or stopped run, with an audit event.

Passing commands alone do not establish test quality. The reviewer is instructed to inspect meaningful unit coverage for behavior added or changed, acceptance criteria, and relevant failure cases. AI reviews can still miss defects; normal repository review and CI remain useful.

## Pause, resume, and recovery

Pause interrupts the active agent/check process and preserves work. Resume continues from stored workspaces and checkpoints; an unfinished invocation starts a new session with task requirements and available feedback. Restarting the controller turns previously active runs into paused runs. It does not silently restart model calls.

When a limit or error stops progress, the run becomes **Needs attention**. Inspect the logs and checks, fix environmental issues if necessary, or use the run’s **Adjust limits** control before resuming. A cancelled run retains artifacts but cannot be resumed. Only one plan runs at a time in this version.

Review reports and check results are written outside the agent workspace:

```text
.ai-flow/
  flow.sqlite
  reports/<run-id>/<task-id>/
    round-01-<unique-id>.md
    round-01-<unique-id>.json
    checks-round-1-attempt-0-<unique-id>.json
  worktrees/<run-id>/
    integration/
    tasks/<task-id>/
```

The plan’s final branch is `ai-flow/<run-id>`. Task branches use `ai-flow-tasks/<run-id>/<task-id>`. The dashboard provides the exact final commit, a combined diff, and downloadable review Markdown. Inspect and merge the output branch through your normal process.

## Usage accounting

The Usage tab records runtime-reported input, cached input, output, reasoning output, and total tokens per invocation. Cumulative notifications replace the current invocation snapshot instead of being added repeatedly. Cached input is not added a second time to input; reasoning output is not added a second time to output.

Unknown usage is displayed as unknown. Demo agents make no model calls and do not fabricate token usage. Reported token budgets are checked as events arrive and can overshoot during an in-flight request. Nested-agent usage depends on what Codex reports for the primary thread; the app does not invent missing usage. This is an activity ledger, not a billing invoice. API charges and ChatGPT plan credits differ.

## Configuration and environment

| Variable        | Default              | Purpose                                                     |
| --------------- | -------------------- | ----------------------------------------------------------- |
| `FLOW_WEB_PORT` | `3000`               | Dashboard port                                              |
| `FLOW_API_PORT` | `4310`               | Controller port and Next.js proxy destination               |
| `FLOW_DATA_DIR` | `<project>/.ai-flow` | SQLite, artifacts, demos, worktrees                         |
| `CODEX_BIN`     | `codex`              | Codex executable                                            |
| `FLOW_WEB_HOST` | `127.0.0.1`          | Production web bind address; container setup uses `0.0.0.0` |

The `.env.example` documents the variables. Root scripts load an optional root `.env` file. Keep credentials out of task files and the repository. Codex uses its normal local authentication; AI Flow does not require entering a key in the browser.

This is a trusted, local, single-user development tool. It executes repository code and configured shell commands. Common model/cloud credential variables are removed from verifier processes, but this is not a hardened sandbox for malicious repositories. Do not expose the controller or dashboard to an untrusted network. Codex’s app-server protocol is version-dependent and currently documented as experimental; the integration is deliberately isolated in [`runtime.ts`](apps/server/src/runtime.ts).

## Development and checks

```sh
npm test
npm run typecheck
npm run build
npm audit
```

Unit and integration tests cover dependency validation, review contracts, persistent recovery, commit integrity, actual check execution, timeouts, cancellation, repair rounds, limits, configuration capture, and reported usage. Normal tests use no model calls.

With the app running, the optional command below runs a real, small Codex workflow using GPT-6.1 Sol at Low effort. It creates an isolated fixture repository, captures a single-task run, restores the default configuration, and records real usage in the dashboard. **It makes real model calls.**

```sh
npm run verify:live
```

`npm run demo` starts the no-model-call demo from the terminal.

## Docker and CI

```sh
docker compose up --build
```

Open http://127.0.0.1:3000. Data and optional Codex authentication use named volumes. For real work, set `FLOW_REPOSITORIES_DIR` to a host directory containing your repositories; they appear under `/workspace/repos` in the container. Configure those **container paths** in Settings.

Authenticate inside the container when needed:

```sh
docker compose exec ai-flow codex login --device-auth
```

The controller is not published as a separate host port. Native execution is the simplest setup for real coding; nested Codex sandbox support in Docker depends on the host kernel/container environment. The demo requires no Codex authentication.

GitHub Actions and GitLab CI definitions run dependency installation, tests, type checks, the production build, and dependency auditing. They do not call paid models or publish changes.

## Layout

```text
apps/server/src/   NestJS API, SQLite store, controller, Codex transport, Git workspaces
apps/server/test/  Controller, contract, persistence, runtime, and workspace tests
apps/web/app/      Next.js dashboard, settings, run controls, and detail views
packages/shared/  Shared TypeScript contracts
examples/tasks/   Markdown task and dependency examples
docs/             Architecture and repository-specific check recipes
```

See [`docs/architecture.md`](docs/architecture.md) for the state machine, contracts, and implementation boundaries.

The tested workflows and observed results are recorded in [`docs/verification.md`](docs/verification.md).
