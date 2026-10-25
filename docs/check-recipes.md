# Repository check recipes

Configure commands that already work in your target repository. These are starting points, not assumptions about package managers, test runners, or scripts. Checks execute in an isolated worktree, where ignored `node_modules` are not copied from the source checkout. The implementer must install dependencies when necessary; enable its network access for installation or use a repository-managed offline cache.

## JavaScript and TypeScript

| Purpose                   | Example command           | Check type  |
| ------------------------- | ------------------------- | ----------- |
| Vitest                    | `npm test -- --run`       | `unit`      |
| Jest                      | `npm test -- --runInBand` | `unit`      |
| Node built-in test runner | `node --test`             | `unit`      |
| TypeScript                | `npm run typecheck`       | `typecheck` |
| ESLint                    | `npm run lint`            | `lint`      |
| Build                     | `npm run build`           | `build`     |

Do not use watch mode. Prefer project scripts to globally installed tools. For a pnpm or Yarn repository use its own lockfile and scripts.

## React and Next.js

Use the existing Vitest/Jest and component-testing setup. Require behavior tests for components, hooks, utilities, server actions, and request handlers affected by the task. Configure the production build separately; a build is not a unit test. Add browser/integration checks when cross-component or navigation behavior warrants them.

## Node.js and NestJS

Use the project’s test runner. Cover services, validation, error paths, controllers, and dependency interactions at an appropriate level. Add integration tests for persistence or request wiring when a unit test cannot establish the behavior. Keep unit tests independent of production accounts and deployed services.

## AWS CDK

Keep construct/template assertions in the unit-test gate and synthesis in a separate check:

```text
npm test -- --runInBand
npx cdk synth --quiet
```

Use commands appropriate to the repository. Context lookups may need pre-recorded context or dedicated development credentials. The verifier strips inherited AWS credential variables by default. Do not configure `cdk deploy` as a validation check; delivery stays in Git for normal review/deployment.

## GitHub Actions and GitLab pipelines

Use repository-approved configuration validators if installed, such as an existing actionlint command or YAML/schema checks. Exercise the scripts called by modified jobs and add unit tests for changed JavaScript/TypeScript pipeline helpers. A syntax-valid pipeline does not establish that remote runners, secrets, or provider permissions work.

The application’s own CI definitions validate AI Flow without model calls. Real agent runs should be explicitly triggered in a trusted environment with appropriate authentication and budgets.

## Docker

Use `docker build` and a bounded smoke test for affected images when a Docker daemon is available. Add unit tests for application behavior independently of container build checks. Do not mount the Docker socket merely to satisfy an unrelated task. Docker availability and network access depend on the execution environment.

## Keep verification meaningful

- Mark at least one command as `unit`; the configuration validator enforces this.
- Choose a timeout suitable for each command.
- Make generated build, coverage, cache, and dependency paths ignored by Git. Checks must leave the recorded source snapshot clean.
- Do not replace test commands or remove assertions just to get a passing exit code. The reviewer is instructed to block this behavior.
- Include clear acceptance criteria and relevant edge/failure cases in the task Markdown.
