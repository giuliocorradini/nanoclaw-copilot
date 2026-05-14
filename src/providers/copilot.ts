import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

function copyDirRecursive(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

registerProviderContainerConfig('copilot', (ctx) => {
  const copilotDir = path.join(ctx.sessionDir, 'copilot');
  fs.mkdirSync(copilotDir, { recursive: true });

  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const candidates = [path.join(hostHome, '.copilot'), path.join(hostHome, '.config', 'github-copilot')];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        copyDirRecursive(c, copilotDir);
        break;
      }
    }
  }

  const env: Record<string, string> = {
    COPILOT_HOME: '/home/node/.copilot',
  };
  for (const key of ['GITHUB_TOKEN', 'COPILOT_MODEL', 'COPILOT_APP_SERVER_BIN', 'COPILOT_CONFIG_OVERRIDES'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: copilotDir, containerPath: '/home/node/.copilot', readonly: false }],
    env,
  };
});
