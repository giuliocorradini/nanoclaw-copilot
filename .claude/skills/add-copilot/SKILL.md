---
name: add-copilot
description: Add GitHub Copilot as an agent provider (CLI + app-server) via the provider-skill workflow. Installs provider files from the providers branch, registers host/container providers, and pins the Copilot CLI in the agent image.
---

# Copilot agent provider

NanoClaw runs agents in a long-lived **poll loop** inside the container. The backend is selected with **`AGENT_PROVIDER`** (`claude` | `opencode` | `codex` | `copilot` | `mock`).

Trunk keeps provider infrastructure minimal; provider capabilities are installed with skills. This skill applies the provider-skill workflow for Copilot by syncing provider files from the `providers` branch, wiring registrations, pinning CLI/runtime requirements, and rebuilding.

## Install

### Pre-flight

If all of the following are already present, skip to **Configuration**:

- `src/providers/copilot.ts`
- `container/agent-runner/src/providers/copilot.ts`
- `container/agent-runner/src/providers/copilot-app-server.ts`
- `container/agent-runner/src/providers/copilot.factory.test.ts`
- `import './copilot.js';` line in `src/providers/index.ts`
- `import './copilot.js';` line in `container/agent-runner/src/providers/index.ts`
- `ARG COPILOT_CLI_VERSION` and `"@github/copilot@${COPILOT_CLI_VERSION}"` in `container/Dockerfile`

Missing pieces — continue below. All steps are idempotent; re-running is safe.

### 1. Fetch the providers branch

```bash
git fetch origin providers
```

### 2. Copy the Copilot source files

Wholesale copies (owned by this skill — user edits to these files won't survive a re-run):

```bash
git show origin/providers:src/providers/copilot.ts                                        > src/providers/copilot.ts
git show origin/providers:container/agent-runner/src/providers/copilot.ts                 > container/agent-runner/src/providers/copilot.ts
git show origin/providers:container/agent-runner/src/providers/copilot-app-server.ts      > container/agent-runner/src/providers/copilot-app-server.ts
git show origin/providers:container/agent-runner/src/providers/copilot.factory.test.ts    > container/agent-runner/src/providers/copilot.factory.test.ts
git show origin/providers:src/container-runner.test.ts                                     > src/container-runner.test.ts
git show origin/providers:docs/copilot-provider.md                                         > docs/copilot-provider.md
```

### 3. Append self-registration imports

Each barrel gets one line (skip if already present):

`src/providers/index.ts`

```typescript
import './copilot.js';
```

`container/agent-runner/src/providers/index.ts`

```typescript
import './copilot.js';
```

### 4. Add Copilot CLI install to the container image

Two edits in `container/Dockerfile`, both idempotent:

1. Add in the CLI ARG block:

```dockerfile
ARG COPILOT_CLI_VERSION=0.34.1
```

2. Add a dedicated install layer:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g "@github/copilot@${COPILOT_CLI_VERSION}"
```

### 5. Build

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

## Configuration

Set provider per group and restart:

```bash
ncl groups config update --id <group-id> --provider copilot
ncl groups restart --id <group-id> --message "Switched to Copilot provider"
```

Host-side provider contribution (`src/providers/copilot.ts`) forwards:

- `GITHUB_TOKEN`
- `COPILOT_MODEL`
- `COPILOT_APP_SERVER_BIN`
- `COPILOT_CONFIG_OVERRIDES`
- `COPILOT_SANDBOX` (default: `workspace-write`)
- `COPILOT_APPROVAL_POLICY` (default: `on-request`)

See `docs/copilot-provider.md` for rollout and compatibility notes.

## Verify

```bash
grep -q "./copilot.js" container/agent-runner/src/providers/index.ts && echo "container barrel: OK"
grep -q "./copilot.js" src/providers/index.ts && echo "host barrel: OK"
grep -q "@github/copilot@" container/Dockerfile && echo "Dockerfile install: OK"
cd container/agent-runner && bun test src/providers/copilot.factory.test.ts && cd -
```
