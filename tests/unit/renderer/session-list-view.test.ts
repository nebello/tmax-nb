// Session list view: picking a card in another workspace switches to it,
// focuses the pane and (narrow window) shows the terminal.
import { describe, test, expect, beforeAll } from 'vitest';

(globalThis as any).window = (globalThis as any).window ?? {};
(globalThis as any).window.terminalAPI = (globalThis as any).window.terminalAPI ?? {};
(globalThis as any).document = (globalThis as any).document ?? {
  hasFocus: () => true,
  documentElement: { style: { setProperty: () => {} } },
};

let useTerminalStore: typeof import('../../../src/renderer/state/terminal-store').useTerminalStore;
let shortPath: typeof import('../../../src/renderer/components/SessionList').shortPath;
let timeAgo: typeof import('../../../src/renderer/components/SessionList').timeAgo;

beforeAll(async () => {
  ({ useTerminalStore } = await import('../../../src/renderer/state/terminal-store'));
  ({ shortPath, timeAgo } = await import('../../../src/renderer/components/SessionList'));
});

const leaf = (terminalId: string) => ({ tilingRoot: { kind: 'leaf', terminalId }, floatingPanels: [] });
const pane = (id: string, workspaceId: string) =>
  ({ id, title: id, shellProfileId: 'zsh', cwd: '/x', mode: 'tiled', pid: 1, lastProcess: '', startupCommand: '', workspaceId }) as any;

describe('openSessionFromList', () => {
  test('switches workspace, focuses the pane and shows the terminal', () => {
    useTerminalStore.setState({
      config: { tabMode: 'workspaces' },
      activeWorkspaceId: 'w1',
      workspaces: new Map([
        ['w1', { id: 'w1', name: 'A', layout: leaf('p1') }],
        ['w2', { id: 'w2', name: 'B', layout: leaf('p2') }],
      ]),
      layout: leaf('p1'),
      terminals: new Map([['p1', pane('p1', 'w1')], ['p2', pane('p2', 'w2')]]),
      focusedTerminalId: 'p1',
      sessionsShowTerminal: false,
    } as any);

    useTerminalStore.getState().openSessionFromList('p2');

    const s = useTerminalStore.getState();
    expect(s.activeWorkspaceId).toBe('w2');
    expect(s.focusedTerminalId).toBe('p2');
    expect(s.sessionsShowTerminal).toBe(true);
  });
});

describe('card helpers', () => {
  test('shortPath shortens home and long paths', () => {
    expect(shortPath('/Users/me', '/Users/me')).toBe('~');
    expect(shortPath('/Users/me/dev/app', '/Users/me')).toBe('~/dev/app');
    expect(shortPath('/Users/me/a/b/c/d', '/Users/me')).toBe('…/c/d');
    expect(shortPath('/Users/meow/x', '/Users/me')).toBe('/Users/meow/x'); // not under home
  });

  test('timeAgo', () => {
    const now = 10 * 86_400_000;
    expect(timeAgo(undefined, now)).toBe('');
    expect(timeAgo(now - 30_000, now)).toBe('now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d');
  });
});
