import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonlLines, parseClaudeCodeSession } from '../../../src/main/claude-code-events-parser';

// Transcripts over 1 GB used to be read whole and crashed the main process
// (heap OOM). The reader now streams 8 MB chunks; these check the edges.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmax-jsonl-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readJsonlLines', () => {
  it('yields every complete line across chunk boundaries, keeps multibyte text intact, skips a partial tail', () => {
    const file = path.join(dir, 'big.jsonl');
    const line = JSON.stringify({ type: 'assistant', text: 'è'.repeat(1000) + '日本' }); // multibyte straddles chunks
    const count = 10_000; // ~20 MB > one 8 MB chunk
    fs.writeFileSync(file, (line + '\n').repeat(count) + '{"type":"user","half');
    const out = { end: 0 };
    let n = 0;
    for (const l of readJsonlLines(file, 0, out)) {
      expect(l).toBe(line);
      n++;
    }
    expect(n).toBe(count);
    expect(out.end).toBe(Buffer.byteLength(line + '\n') * count);
  });
});

describe('parseClaudeCodeSession (incremental)', () => {
  it('resumes from the last complete line when a half-written line is finished later', () => {
    const file = path.join(dir, 'session.jsonl');
    const user = (t: string) =>
      JSON.stringify({ type: 'user', timestamp: '2026-11-08T08:00:00Z', cwd: '/x', sessionId: 's1', message: { content: t } });
    fs.writeFileSync(file, user('primo') + '\n' + user('secondo').slice(0, 20));
    expect(parseClaudeCodeSession(file)?.messageCount).toBe(1);
    fs.appendFileSync(file, user('secondo').slice(20) + '\n');
    const r = parseClaudeCodeSession(file);
    expect(r?.messageCount).toBe(2);
    expect(r?.latestPrompt).toContain('secondo');
  });
});
