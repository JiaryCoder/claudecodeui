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
 * Which provider session a run ends up on is decided by what it is handed.
 * A run with an id to resume keeps it. A run with none starts a new provider
 * session and has to report the new id, because that report is the only
 * thing that maps it onto the app session; otherwise the next message
 * resumes whatever the row still points at.
 *
 * An edit of a session's very first prompt depends on this: the gateway
 * detaches the session and the run starts with no id. These tests drive
 * `queryClaudeSDK` with a scripted SDK stream (the seam is
 * `context.createQuery`) and record what the runtime asks the SDK for and
 * which id it hands its writer.
 */

const SESSION_ID = 'app-capture-session';
const OLD_NATIVE_ID = 'native-before-edit';
const NEW_NATIVE_ID = 'native-after-edit';

async function runOneTurn(resumeId: string | null, streamedId: string): Promise<{
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
    resolveProviderSessionId: () => resumeId,
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
    await queryClaudeSDK('hello', { sessionId: SESSION_ID, cwd }, writer as never, context);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  return { sdkOptions, reportedIds, sent };
}

test('a run with nothing to resume reports the provider session it started', async () => {
  const { sdkOptions, reportedIds, sent } = await runOneTurn(null, NEW_NATIVE_ID);

  const options = sdkOptions as AnyRecord | null;
  assert.equal(options?.resume, undefined);
  assert.equal(options?.resumeSessionAt, undefined);
  assert.deepEqual(reportedIds, [NEW_NATIVE_ID]);
  assert.ok(
    sent.some((message) => message.kind === 'session_created' && (message as AnyRecord).newSessionId === NEW_NATIVE_ID),
    'the new provider session is announced',
  );
});

test('a run that resumes stays on that provider session and announces nothing new', async () => {
  const { sdkOptions, reportedIds, sent } = await runOneTurn(OLD_NATIVE_ID, OLD_NATIVE_ID);

  assert.equal((sdkOptions as AnyRecord | null)?.resume, OLD_NATIVE_ID);
  // The runtime already holds the id it resumed, so it does not report one
  // again. That is why a run that must land on a new provider session has to
  // start from a detached row instead of from one still holding the old id.
  assert.deepEqual(reportedIds, []);
  assert.equal(sent.some((message) => message.kind === 'session_created'), false);
});
