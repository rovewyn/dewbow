import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, sessionUpdatesPath } from '../src/apiRoutes.ts';

test('resource transport keeps retry input intact and escapes opaque identities and cursors', () => {
  const input = { sessionId: 'synthetic/session #1', turnId: 'turn?1', interactionId: 'callback/1', requestId: 'same-request', decision: 'allow' };
  const original = structuredClone(input);
  const first = apiRequest('decideApproval', input);
  assert.equal(first.method, 'POST');
  assert.equal(first.path, '/api/v1/sessions/synthetic%2Fsession%20%231/turns/turn%3F1/interactions/callback%2F1/decisions');
  assert.deepEqual(first.input, { requestId: 'same-request', decision: 'allow' });
  assert.deepEqual(input, original);
  assert.deepEqual(apiRequest('decideApproval', input), first);
  const page = apiRequest('readSessionContent', { sessionId: input.sessionId, contentId: 'opaque/ref', contentCursor: 'cursor+/?=&', limitBytes: 65536 });
  assert.equal(page.method, 'GET'); assert.equal(page.input, undefined);
  const url = new URL(page.path, 'http://127.0.0.1');
  assert.equal(url.pathname, '/api/v1/sessions/synthetic%2Fsession%20%231/contents/opaque%2Fref');
  assert.equal(url.searchParams.get('contentCursor'), 'cursor+/?=&');
  assert.equal(url.searchParams.get('limitBytes'), '65536');
  assert.equal(url.searchParams.has('sessionId'), false);
  assert.equal(sessionUpdatesPath(input.sessionId), '/api/v1/sessions/synthetic%2Fsession%20%231/updates');
});
