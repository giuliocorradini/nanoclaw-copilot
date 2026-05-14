# Copilot CLI provider

This fork includes an in-tree `copilot` agent provider for the container runner.

## What it does

- Adds a provider named `copilot` in `container/agent-runner/src/providers/`
- Spawns `copilot app-server` over stdio JSON-RPC
- Writes MCP server wiring into `~/.copilot/config.toml`
- Keeps provider selection per group/session through the existing `provider` field

## Configure a group to use Copilot

Use `ncl`:

```bash
ncl groups config update --id <group-id> --provider copilot
ncl groups restart --id <group-id> --message "Switched to Copilot provider"
```

Or set `"provider": "copilot"` in the group container config and restart that group.

## Host authentication and runtime inputs

The host-side provider contribution (`src/providers/copilot.ts`) prepares a per-session Copilot home and forwards selected env vars:

- `GITHUB_TOKEN`
- `COPILOT_MODEL`
- `COPILOT_APP_SERVER_BIN`
- `COPILOT_CONFIG_OVERRIDES`
- `COPILOT_SANDBOX` (default: `workspace-write`)
- `COPILOT_APPROVAL_POLICY` (default: `on-request`)

It also sets `COPILOT_HOME=/home/node/.copilot` in the container.

## Migration from `claude` to `copilot`

1. Pick one non-critical group first.
2. Switch provider for that group only.
3. Restart the group and validate real traffic.
4. Roll out group-by-group.
5. Keep `claude` as fallback during rollout (`ncl groups config update --provider claude` + restart).

## Compatibility notes

- MCP tool wiring remains provider-agnostic at the NanoClaw layer.
- Prompt fragments are still authored in Claude-oriented files (`CLAUDE.md` + imports); the Copilot provider resolves and inlines those imports before sending instructions.
- If your local Copilot binary does not support `app-server`, set `COPILOT_APP_SERVER_BIN` to a compatible wrapper/binary.
