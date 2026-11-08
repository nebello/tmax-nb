import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { CopilotSessionStatus } from '../shared/copilot-types';

/** Extract first text from message content (string or array of blocks). */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text' && block.text) return block.text.trim() || null;
    }
  }
  return null;
}

/**
 * Turn a raw first-prompt string into a summary suitable for the session list.
 * Handles the slash-command case: Claude Code injects the full command template
 * as the first "user message", producing garbage like
 * `<command-message>video-dub</command-message><command-name>video-dub</command-name>...`
 * which is useless as a title. When detected, surface it as `/<name> — <rest>`.
 */
function formatFirstPromptSummary(raw: string): string {
  let out = raw;
  const nameMatch = out.match(/<command-name>([^<]+)<\/command-name>/);
  if (nameMatch) {
    // Claude Code's tag content may or may not already include a leading slash
    // (e.g. "/video-dub" vs "video-dub"); normalize it.
    const name = nameMatch[1].replace(/^\/+/, '');
    const rest = stripCommandXml(out).replace(/^\/+/, '').trim();
    out = rest ? `/${name} — ${rest}` : `/${name}`;
  } else {
    // No command-name, but the message might still be a local-command-caveat
    // wrapper, local-command-stdout (logged after a /model or /clear), etc.
    // Strip those. If nothing is left after stripping, the message was
    // entirely meta - return empty so callers treat it as "no real prompt"
    // instead of dumping the raw XML into the UI.
    const stripped = stripCommandXml(out).trim();
    if (!stripped) return '';
    out = stripped;
  }
  // Drop ANSI escape sequences that Claude Code sometimes embeds in its
  // command-stdout payloads (e.g. "[1mOpus 4.7[22m"). The actual ESC byte
  // won't render, leaving visible bracket codes that look like garbage.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/\x1b?\[[0-9;]*[A-Za-z]/g, '');
  return out.slice(0, 120).replace(/\n/g, ' ').trim();
}

/**
 * Strip Claude-Code's internal XML wrappers - command-message, command-name,
 * local-command-stdout, local-command-caveat, task-summary, executive-summary,
 * system-reminder, user-prompt-submit-hook, and the next one Anthropic adds.
 * These show up as "user messages" in the .jsonl but they're agent metadata,
 * not real user prompts. We strip any balanced tag pair so we don't have to
 * keep a hand-maintained allowlist.
 */
function stripCommandXml(s: string): string {
  return s.replace(/<([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>[\s\S]*?<\/\1>/g, '');
}

export interface ClaudeCodeParsedSession {
  sessionId: string;
  slug: string;
  cwd: string;
  gitBranch: string;
  model: string;
  status: CopilotSessionStatus;
  messageCount: number;
  toolCallCount: number;
  lastActivityTime: number;
  firstPrompt: string;
  /** Most recent user prompt text (same cleanup as firstPrompt, skipping interruptions) */
  latestPrompt: string;
  /** Timestamp (ms since epoch) of the most recent user prompt */
  latestPromptTime: number;
}

interface CacheEntry {
  byteOffset: number;
  metaExtracted: boolean;
  sessionId: string;
  slug: string;
  cwd: string;
  gitBranch: string;
  model: string;
  messageCount: number;
  toolCallCount: number;
  lastActivityTime: number;
  firstPrompt: string;
  latestPrompt: string;
  latestPromptTime: number;
  lastLineType: string;
  lastLineHasEndTurn: boolean;
  awaitingInput: boolean; // true after end_turn, cleared on next user message
}

const READ_CHUNK = 8 * 1024 * 1024;

/**
 * Yields each complete line ('\n'-terminated) of a JSONL file from `start`,
 * reading 8 MB at a time. Transcripts can pass 1 GB; reading them whole blew
 * the main-process heap (OOM at startup) and overflows V8's max string length.
 * A trailing partial line (mid-write) is not yielded; `out.end` is the byte
 * offset just past the last yielded line, so callers can resume from it.
 */
export function* readJsonlLines(filePath: string, start = 0, out?: { end: number }): Generator<string> {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    let carry = Buffer.alloc(0);
    let pos = start; // next byte to read
    let lineStartOffset = start; // file offset of carry[0]
    if (out) out.end = start;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, READ_CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0;
      let nl: number;
      while ((nl = chunk.indexOf(0x0a, from)) !== -1) {
        const line = chunk.toString('utf-8', from, nl);
        from = nl + 1;
        if (out) out.end = lineStartOffset + from;
        yield line;
      }
      lineStartOffset += from;
      carry = Buffer.from(chunk.subarray(from)); // copy: buf is reused
    }
  } finally {
    fs.closeSync(fd);
  }
}

const cache = new Map<string, CacheEntry>();

interface PromptsCacheEntry {
  mtimeMs: number;
  size: number;
  limit: number;
  prompts: string[];
}
const promptsCache = new Map<string, PromptsCacheEntry>();

export function parseClaudeCodeSession(filePath: string): ClaudeCodeParsedSession | null {
  try {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    if (fileSize === 0) return null;

    const cached = cache.get(filePath);
    const startOffset = cached?.byteOffset ?? 0;

    if (cached && startOffset >= fileSize) {
      return deriveResult(cached, stat.mtimeMs);
    }

    const state: CacheEntry = cached
      ? { ...cached }
      : {
          byteOffset: 0,
          metaExtracted: false,
          sessionId: '',
          slug: '',
          cwd: '',
          gitBranch: '',
          model: '',
          messageCount: 0,
          toolCallCount: 0,
          lastActivityTime: 0,
          firstPrompt: '',
          latestPrompt: '',
          latestPromptTime: 0,
          lastLineType: '',
          lastLineHasEndTurn: false,
          awaitingInput: false,
        };

    // Only complete lines are processed: a half-written last line would
    // JSON.parse-fail AND advance byteOffset past it, losing it next poll.
    const out = { end: startOffset };
    for (const line of readJsonlLines(filePath, startOffset, out)) {
      if (line.trim()) processLine(line, state);
    }

    state.byteOffset = out.end;
    cache.set(filePath, state);

    return deriveResult(state, stat.mtimeMs);
  } catch {
    return null;
  }
}

function extractType(line: string): string | null {
  // Fast extraction: match the first "type" field in the JSON line
  const m = line.match(/^\s*\{\s*"type"\s*:\s*"([^"]+)"/);
  if (m) return m[1];
  // Fallback for lines where "type" isn't the first field
  const m2 = line.match(/"type"\s*:\s*"([^"]+)"/);
  return m2 ? m2[1] : null;
}

function processLine(line: string, state: CacheEntry): void {
  const type = extractType(line);
  if (!type) return;

  state.lastLineType = type;
  state.lastLineHasEndTurn = false;
  // GH #118: clear awaitingInput by default on every line. Previously only
  // user events cleared it, so a `progress` / `system` / non-end_turn
  // `assistant` event after an `end_turn` would leave the flag stuck true.
  // deriveResult's early-return then locked the pane on `waitingForUser`
  // for 10 minutes even though the session was actively executing tools.
  // The `assistant` branch below re-sets the flag when the line is a real
  // end_turn, so the only state that survives is "we genuinely just ended
  // a turn and no other event has come in since".
  state.awaitingInput = false;

  // Extract timestamp
  let lineTs = 0;
  const tsMatch = line.match(/"timestamp"\s*:\s*"([^"]+)"/);
  if (tsMatch) {
    const ts = new Date(tsMatch[1]).getTime();
    if (!isNaN(ts)) {
      lineTs = ts;
      if (ts > state.lastActivityTime) state.lastActivityTime = ts;
    }
  }

  switch (type) {
    case 'user': {
      state.messageCount++;

      // Pull the user-message text once and let both firstPrompt (set only if
      // empty) and latestPrompt (always updated on new input) consume it.
      // tool_result user messages don't have a readable text content, so
      // extractText returns null and we skip - otherwise every tool response
      // would clobber latestPrompt with an empty string.
      let userText: string | null = null;
      try {
        const parsed = JSON.parse(line);
        if (!state.metaExtracted) {
          state.cwd = parsed.cwd || '';
          state.gitBranch = parsed.gitBranch || '';
          state.slug = parsed.slug || '';
          state.sessionId = parsed.sessionId || '';
          state.metaExtracted = true;
        } else if (parsed.gitBranch) {
          // Branch may change during session
          state.gitBranch = parsed.gitBranch;
        }
        if (parsed.message?.content) {
          userText = extractText(parsed.message.content);
        }
      } catch {
        // Fallback: regex-based extraction (no user text available here)
        if (!state.metaExtracted) {
          const cwdMatch = line.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          if (cwdMatch) {
            try { state.cwd = JSON.parse(`"${cwdMatch[1]}"`); }
            catch { state.cwd = cwdMatch[1]; }
          }
          const slugMatch = line.match(/"slug"\s*:\s*"([^"]+)"/);
          if (slugMatch) state.slug = slugMatch[1];
          const branchMatch = line.match(/"gitBranch"\s*:\s*"([^"]+)"/);
          if (branchMatch) state.gitBranch = branchMatch[1];
          const sessionMatch = line.match(/"sessionId"\s*:\s*"([^"]+)"/);
          if (sessionMatch) state.sessionId = sessionMatch[1];
          state.metaExtracted = true;
        }
      }

      if (userText && !userText.startsWith('[Request interrupted')) {
        const summary = formatFirstPromptSummary(userText);
        if (summary) {
          if (!state.firstPrompt) state.firstPrompt = summary;
          state.latestPrompt = summary;
          if (lineTs > 0) state.latestPromptTime = lineTs;
        }
      }
      break;
    }
    case 'assistant': {
      // Extract model
      const modelMatch = line.match(/"model"\s*:\s*"([^"]+)"/);
      if (modelMatch) state.model = modelMatch[1];

      // Count tool_use blocks (skip the outer "type":"assistant")
      const toolMatches = line.match(/"type"\s*:\s*"tool_use"/g);
      if (toolMatches) state.toolCallCount += toolMatches.length;

      // Check for end_turn
      if (line.includes('"end_turn"')) {
        state.lastLineHasEndTurn = true;
        state.awaitingInput = true;
      }
      break;
    }
    // progress, system, queue-operation, file-history-snapshot are not counted as messages
  }
}

const ACTIVE_THRESHOLD_MS = 30_000;

function deriveResult(
  state: CacheEntry,
  mtimeMs: number,
): ClaudeCodeParsedSession {
  const isRecent = Date.now() - mtimeMs < ACTIVE_THRESHOLD_MS;
  const isRecentWaiting = Date.now() - mtimeMs < 10 * 60_000; // 10 min for waiting states

  let status: CopilotSessionStatus = 'idle';

  if (isRecent || isRecentWaiting) {
    if (state.awaitingInput && isRecentWaiting) {
      // Assistant finished (end_turn) and no new user message — waiting for input
      status = 'waitingForUser';
    } else if (isRecent) {
      switch (state.lastLineType) {
        case 'progress':
          status = state.awaitingInput ? 'waitingForUser' : 'executingTool';
          break;
        case 'user':
          status = 'thinking';
          break;
        case 'assistant':
          status = state.lastLineHasEndTurn ? 'waitingForUser' : 'thinking';
          break;
        case 'system':
          status = 'waitingForUser';
          break;
        default:
          status = 'thinking';
          break;
      }
    }
  }

  return {
    sessionId: state.sessionId,
    slug: state.slug,
    cwd: state.cwd,
    gitBranch: state.gitBranch,
    model: state.model,
    status,
    messageCount: state.messageCount,
    toolCallCount: state.toolCallCount,
    lastActivityTime: state.lastActivityTime,
    firstPrompt: state.firstPrompt,
    latestPrompt: state.latestPrompt,
    latestPromptTime: state.latestPromptTime,
  };
}

// TASK-85: default cap of 10 (was 20). See extractCopilotPrompts for rationale.
export function extractClaudeCodePrompts(filePath: string, limit = 10): string[] {
  try {
    const stat = fs.statSync(filePath);
    const cached = promptsCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.limit === limit) {
      return cached.prompts;
    }
    const prompts: string[] = [];
    for (const line of readJsonlLines(filePath)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'user' || !o.message?.content) continue;
        const text = extractText(o.message.content);
        if (!text) continue;
        if (text.startsWith('[Request interrupted')) continue;
        // Skip meta-only messages (entirely wrapped in command-message /
        // task-summary / system-reminder / etc.) - those are agent state,
        // not user prompts.
        const stripped = stripCommandXml(text).trim();
        if (!stripped) continue;
        // Slash commands: surface as /name with the rest tacked on, same
        // shape as the title summary path so the history reads cleanly.
        const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
        const display = nameMatch
          ? `/${nameMatch[1].replace(/^\/+/, '')}${stripped ? ` — ${stripped}` : ''}`
          : stripped;
        prompts.push(display.slice(0, 300).replace(/\n/g, ' '));
      } catch { /* skip */ }
    }
    const result = prompts.slice(-limit);
    promptsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, limit, prompts: result });
    return result;
  } catch {
    return [];
  }
}

/**
 * Async version of extractClaudeCodePrompts — streams the file with readline to
 * avoid blocking the main process event loop (GH #144).
 */
export async function extractClaudeCodePromptsAsync(filePath: string, limit = 10): Promise<string[]> {
  try {
    const stat = fs.statSync(filePath);
    const cached = promptsCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.limit === limit) {
      return cached.prompts;
    }
    const prompts: string[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'user' || !o.message?.content) continue;
        const text = extractText(o.message.content);
        if (!text) continue;
        if (text.startsWith('[Request interrupted')) continue;
        const stripped = stripCommandXml(text).trim();
        if (!stripped) continue;
        const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
        const display = nameMatch
          ? `/${nameMatch[1].replace(/^\/+/, '')}${stripped ? ` — ${stripped}` : ''}`
          : stripped;
        prompts.push(display.slice(0, 300).replace(/\n/g, ' '));
      } catch { /* skip */ }
    }
    const result = prompts.slice(-limit);
    promptsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, limit, prompts: result });
    return result;
  } catch {
    return [];
  }
}

/**
 * Like extractClaudeCodePrompts, but returns each user prompt paired with its
 * timestamp (epoch ms) for the session-timeline view. Not cached - the
 * timeline is opened on demand, not polled.
 */
export function extractClaudeCodePromptsWithTime(
  filePath: string,
  limit = 500,
): { text: string; time: number }[] {
  try {
    const out: { text: string; time: number }[] = [];
    for (const line of readJsonlLines(filePath)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'user' || !o.message?.content) continue;
        const text = extractText(o.message.content);
        if (!text) continue;
        if (text.startsWith('[Request interrupted')) continue;
        const stripped = stripCommandXml(text).trim();
        if (!stripped) continue;
        const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
        const display = nameMatch
          ? `/${nameMatch[1].replace(/^\/+/, '')}${stripped ? ` — ${stripped}` : ''}`
          : stripped;
        const time = o.timestamp ? new Date(o.timestamp).getTime() : 0;
        out.push({ text: display.slice(0, 2000).replace(/\n/g, ' '), time });
      } catch { /* skip */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

/** Join ALL text blocks of a message (assistant replies span several). */
function extractAllText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) parts.push(String(block.text));
    }
    return parts.join('\n').trim();
  }
  return '';
}

/**
 * Full two-sided transcript (user + assistant) with timestamps, for the chat
 * timeline panel. Claude Code stores assistant reply text in its .jsonl, so we
 * can show both sides (unlike Copilot, which only persists the user side).
 */
export function extractClaudeCodeTranscript(
  filePath: string,
  limit = 1000,
): { role: 'user' | 'assistant'; text: string; time: number }[] {
  try {
    const out: { role: 'user' | 'assistant'; text: string; time: number }[] = [];
    for (const line of readJsonlLines(filePath)) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        const time = o.timestamp ? new Date(o.timestamp).getTime() : 0;
        if (o.type === 'user' && o.message?.content) {
          const text = extractText(o.message.content);
          if (!text || text.startsWith('[Request interrupted')) continue;
          const stripped = stripCommandXml(text).trim();
          if (!stripped) continue; // tool_result / meta-only user turn
          const nameMatch = text.match(/<command-name>([^<]+)<\/command-name>/);
          const display = nameMatch
            ? `/${nameMatch[1].replace(/^\/+/, '')}${stripped ? ` — ${stripped}` : ''}`
            : stripped;
          out.push({ role: 'user', text: display, time });
        } else if (o.type === 'assistant' && o.message?.content) {
          const text = extractAllText(o.message.content);
          if (!text) continue; // tool_use-only / thinking-only turn
          out.push({ role: 'assistant', text, time });
        }
      } catch { /* skip */ }
    }
    return out.slice(-limit);
  } catch {
    return [];
  }
}

export function clearClaudeCodeCache(filePath: string): void {
  cache.delete(filePath);
  promptsCache.delete(filePath);
}
