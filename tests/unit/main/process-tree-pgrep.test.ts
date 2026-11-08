import { describe, it, expect } from 'vitest';
import { parsePgrepOutput } from '../../../src/main/process-tree';

describe('parsePgrepOutput', () => {
  it('macOS -lf: uses argv[0], so the native Claude binary reads as "claude"', () => {
    const out = parsePgrepOutput('70321 claude --dangerously-skip-permissions\n70400 /opt/homebrew/bin/node /x/cli.js\n');
    expect(out).toEqual([{ pid: 70321, name: 'claude' }, { pid: 70400, name: 'node' }]);
  });

  it('Linux -lf: "<pid> <comm>"', () => {
    expect(parsePgrepOutput('12 copilot\n\n')).toEqual([{ pid: 12, name: 'copilot' }]);
  });
});
