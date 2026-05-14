import { describe, expect, it } from 'bun:test';

import { createProvider } from './factory.js';
import { CopilotProvider, resolveClaudeImports } from './copilot.js';

describe('createProvider (copilot)', () => {
  it('returns CopilotProvider for copilot', () => {
    expect(createProvider('copilot')).toBeInstanceOf(CopilotProvider);
  });

  it('flags stale thread errors as session-invalid', () => {
    const p = new CopilotProvider();
    expect(p.isSessionInvalid(new Error('thread not found'))).toBe(true);
    expect(p.isSessionInvalid(new Error('unknown thread 123'))).toBe(true);
  });

  it('declares no native slash command support', () => {
    const p = new CopilotProvider();
    expect(p.supportsNativeSlashCommands).toBe(false);
  });
});

describe('resolveClaudeImports (copilot)', () => {
  it('keeps regular text when there are no import directives', () => {
    expect(resolveClaudeImports('hello @team')).toBe('hello @team');
  });
});
