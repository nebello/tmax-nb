import React from 'react';
import { useTerminalStore, findSessionById, getEffectiveCwd } from '../state/terminal-store';
import type { CopilotSessionStatus } from '../../shared/copilot-types';
import type { TerminalId } from '../state/types';
import { getTerminalEntry } from '../terminal-registry';

// Session list view: one card per open terminal, scrollable, so a narrow
// tmax window next to the browser still shows every session at a glance.
// Wide window: a column beside the focused terminal. Narrow window: the list
// fills the area; picking a card shows that terminal with a back bar.

const STATUS: Record<CopilotSessionStatus, { label: string; cls: string }> = {
  waitingForUser: { label: 'waiting for you', cls: 'waiting' },
  awaitingApproval: { label: 'needs approval', cls: 'waiting' },
  thinking: { label: 'working', cls: 'working' },
  executingTool: { label: 'working', cls: 'working' },
  idle: { label: 'idle', cls: 'idle' },
};

export function shortPath(p: string, home: string): string {
  if (!p) return '';
  const rel = home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : rel;
}

export function timeAgo(ms: number | undefined, now = Date.now()): string {
  if (!ms) return '';
  const m = Math.floor((now - ms) / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// Buttons must not take focus on click, or the terminal loses its cursor
// (same fix as the status bar, GH #128).
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function openSession(id: TerminalId): void {
  useTerminalStore.getState().openSessionFromList(id);
  // Re-picking the already-focused pane doesn't change focusedTerminalId, so
  // the pane's own focus effect won't fire; focus xterm directly.
  requestAnimationFrame(() => getTerminalEntry(id)?.terminal.focus());
}

function showList(): void {
  useTerminalStore.setState({ sessionsShowTerminal: false });
  // The terminal stays mounted under the list: drop its keyboard focus so
  // typing doesn't land in a pane the user can't see.
  (document.activeElement as HTMLElement | null)?.blur();
}

const SessionCard: React.FC<{ id: TerminalId; active: boolean }> = ({ id, active }) => {
  const t = useTerminalStore((s) => s.terminals.get(id));
  const copilot = useTerminalStore((s) => s.copilotSessions);
  const claude = useTerminalStore((s) => s.claudeCodeSessions);
  if (!t) return null;
  const session = t.aiSessionId ? findSessionById(copilot, claude, t.aiSessionId) : null;
  const status = session ? STATUS[session.status] : { label: t.mode === 'dormant' ? 'hidden' : 'shell', cls: 'shell' };
  const home = (window as any).platformInfo?.homeDir ?? '';
  const cwd = getEffectiveCwd(t, copilot, claude);
  const prompt = session?.latestPrompt || session?.summary || '';
  const ago = timeAgo(session?.lastActivityTime);
  return (
    <button
      type="button"
      className={`session-card status-${status.cls}${active ? ' active' : ''}`}
      onMouseDown={keepFocus}
      onClick={() => openSession(id)}
      title={cwd}
    >
      <span className="session-card-row">
        <span className="session-card-dot" aria-hidden="true" />
        <span className="session-card-title">{t.title || 'Terminal'}</span>
        <span className="session-card-status">{status.label}{ago ? ` · ${ago}` : ''}</span>
      </span>
      {cwd && <span className="session-card-path">{shortPath(cwd, home)}</span>}
      {prompt && prompt !== t.title && <span className="session-card-prompt">{prompt}</span>}
    </button>
  );
};

const SessionList: React.FC = () => {
  const terminals = useTerminalStore((s) => s.terminals);
  const workspaces = useTerminalStore((s) => s.workspaces);
  const activeWorkspaceId = useTerminalStore((s) => s.activeWorkspaceId);
  const tabMode = useTerminalStore((s) => s.config?.tabMode) ?? 'flat';
  const focusedId = useTerminalStore((s) => s.focusedTerminalId);
  const narrow = useTerminalStore((s) => s.windowNarrow);
  const showTerminal = useTerminalStore((s) => s.sessionsShowTerminal);
  const copilot = useTerminalStore((s) => s.copilotSessions);
  const claude = useTerminalStore((s) => s.claudeCodeSessions);

  const ids = [...terminals.keys()];
  const waiting = ids.filter((id) => {
    const sid = terminals.get(id)?.aiSessionId;
    const st = sid ? findSessionById(copilot, claude, sid)?.status : undefined;
    return id !== focusedId && (st === 'waitingForUser' || st === 'awaitingApproval');
  });

  if (narrow && showTerminal) {
    return (
      <div className="session-list-back">
        <button type="button" className="session-list-back-btn" onMouseDown={keepFocus} onClick={showList}>
          &#8592; Sessions
        </button>
        {waiting.length > 0 && (
          <button type="button" className="session-list-badge" onMouseDown={keepFocus} onClick={() => openSession(waiting[0])} title="Open the next session waiting for you">
            {waiting.length} waiting
          </button>
        )}
      </div>
    );
  }

  const groups = tabMode === 'workspaces'
    ? [...workspaces.values()].map((ws) => ({
        key: ws.id,
        name: ws.name,
        color: ws.color,
        ids: ids.filter((id) => (terminals.get(id)?.workspaceId ?? activeWorkspaceId) === ws.id),
      })).filter((g) => g.ids.length > 0)
    : [{ key: 'all', name: '', color: undefined as string | undefined, ids }];

  return (
    <aside className="session-list" aria-label="Sessions">
      <div className="session-list-header">
        <span>Sessions ({ids.length})</span>
        <button type="button" onMouseDown={keepFocus} onClick={async () => {
          await useTerminalStore.getState().createTerminal();
          useTerminalStore.setState({ sessionsShowTerminal: true });
        }} title="New terminal">+</button>
      </div>
      <div className="session-list-scroll">
        {groups.map((g) => (
          <section key={g.key}>
            {g.name && (
              <div className="session-list-group" style={g.color ? { borderLeftColor: g.color } : undefined}>{g.name}</div>
            )}
            {g.ids.map((id) => <SessionCard key={id} id={id} active={id === focusedId} />)}
          </section>
        ))}
      </div>
    </aside>
  );
};

export default SessionList;
