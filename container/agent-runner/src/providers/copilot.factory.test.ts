import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'bun:test';

import { createProvider } from './factory.js';
import { CopilotProvider, resolvePromptImports } from './copilot.js';

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

describe('resolvePromptImports (copilot)', () => {
  function scratchDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-imports-'));
  }

  it('keeps regular text when there are no import directives', () => {
    expect(resolvePromptImports('hello @team', '/tmp')).toBe('hello @team');
  });

  it('inlines a single relative import', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'fragment.md'), 'FRAGMENT');
    const resolved = resolvePromptImports('before\n@./fragment.md\nafter', dir);
    expect(resolved).toContain('FRAGMENT');
    expect(resolved).not.toContain('@./fragment.md');
  });

  it('expands nested imports', () => {
    const dir = scratchDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'inner.md'), 'INNER');
    fs.writeFileSync(path.join(dir, 'sub', 'outer.md'), '@./inner.md');
    const resolved = resolvePromptImports('@./sub/outer.md', dir);
    expect(resolved).toBe('INNER');
  });

  it('drops missing imports', () => {
    const dir = scratchDir();
    const resolved = resolvePromptImports('a\n@./missing.md\nb', dir);
    expect(resolved).not.toContain('@./missing.md');
    expect(resolved).toContain('a');
    expect(resolved).toContain('b');
  });

  it('breaks cycles', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(dir, 'b.md'), '@./a.md');
    const resolved = resolvePromptImports('@./a.md', dir);
    expect(typeof resolved).toBe('string');
  });
});
