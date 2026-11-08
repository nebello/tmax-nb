// An active Claude session must not attach to a plain shell pane just because
// the cwd matches: the session may be running in another terminal app. The
// pane needs the claude process seen in its tree (aiProcessKind).
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';

(globalThis as any).window = (globalThis as any).window ?? {};
(globalThis as any).window.terminalAPI = (globalThis as any).window.terminalAPI ?? {};
(globalThis as any).document = (globalThis as any).document ?? {
  hasFocus: () => true,
  documentElement: { style: { setProperty: () => {} } },
};

let useTerminalStore: typeof import('../../../src/renderer/state/terminal-store').useTerminalStore;

beforeAll(async () => {
  ({ useTerminalStore } = await import('../../../src/renderer/state/terminal-store'));
});

const session = {
  id: '11111111-2222-3333-4444-555555555555',
  provider: 'claude-code',
  status: 'thinking',
  cwd: '/Users/me',
  summary: 'altra finestra',
  messageCount: 40,
  toolCallCount: 0,
  lastActivityTime: Date.now(),
} as any;

function pane(extra: Record<string, unknown> = {}) {
  return { id: 'p1', title: 'zsh', shellProfileId: 'zsh', cwd: '/Users/me', mode: 'tiled', pid: 1, lastProcess: '', startupCommand: '', ...extra } as any;
}

beforeEach(() => {
  useTerminalStore.setState({ terminals: new Map([['p1', pane()]]), focusedTerminalId: 'p1' } as any);
});

describe('AI session auto-link', () => {
  test('a shell pane in the same cwd without claude running stays unlinked', () => {
    useTerminalStore.getState().updateTerminalTitleFromSession(session, 'claude');
    expect(useTerminalStore.getState().terminals.get('p1')?.aiSessionId).toBeUndefined();
  });

  test('a pane where claude was detected links by cwd', () => {
    useTerminalStore.setState({
      terminals: new Map([['p1', pane({ aiProcessKind: 'claude-code', aiProcessDetectedAt: Date.now() })]]),
    } as any);
    useTerminalStore.getState().updateTerminalTitleFromSession(session, 'claude');
    expect(useTerminalStore.getState().terminals.get('p1')?.aiSessionId).toBe(session.id);
  });
});
