import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * An edit of a session's very first prompt runs with `resumeFromScratch`
 * while the session row still holds the conversation being replaced. The run
 * has to report the provider session it starts, because that report is the
 * only thing that moves the row. These drive `queryClaudeSDK` with a scripted
 * SDK stream (the seam is `context.createQuery`).
 */

const SESSION_ID = 'app-capture-session';
const OLD_NATIVE_ID = 'native-before-edit';
const NEW_NATIVE_ID = 'native-after-edit';

async function runOneTurn(streamedId: string, runOptions: AnyRecord = {}): Promise<{
  sdkOptions: AnyRecord | null;
  reportedIds: string[];
  sent: NormalizedMessage[];
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-session-capture-'));
  let sdkOptions: AnyRecord | null = null;
  const reportedIds: string[] = [];
  const sent: NormalizedMessage[] = [];

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    sdkOptions = options;
    void (async () => {
      for await (const _message of prompt) { /* the CLI reads its stdin */ }
    })();
    const iterator = (async function* () {
      yield { type: 'system', subtype: 'init', session_id: streamedId };
      yield { type: 'result', subtype: 'success', session_id: streamedId, result: 'ok', duration_ms: 1, num_turns: 1 };
    })();
    return Object.assign(iterator, { interrupt: async () => {}, stopTask: async () => {} });
  };

  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    // The row still names the old conversation in both cases.
    resolveProviderSessionId: () => OLD_NATIVE_ID,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
  const writer = {
    send: (message: NormalizedMessage) => { sent.push(message); },
    setSessionId: (id: string) => { reportedIds.push(id); },
    userId: null,
  };

  try {
    await queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd, ...runOptions }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  return { sdkOptions, reportedIds, sent };
}

test('a first-prompt edit reports the provider session it started', async () => {
  const { sdkOptions, reportedIds, sent } = await runOneTurn(NEW_NATIVE_ID, { resumeFromScratch: true });

  assert.equal((sdkOptions as AnyRecord | null)?.resume, undefined);
  assert.deepEqual(reportedIds, [NEW_NATIVE_ID]);
  assert.ok(sent.some((message) => message.kind === 'session_created'));
});

test('an ordinary run resumes the session it was given and reports nothing new', async () => {
  const { sdkOptions, reportedIds, sent } = await runOneTurn(OLD_NATIVE_ID);

  assert.equal((sdkOptions as AnyRecord | null)?.resume, OLD_NATIVE_ID);
  assert.deepEqual(reportedIds, []);
  assert.equal(sent.some((message) => message.kind === 'session_created'), false);
});
