import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, sessionUpdatesPath } from '../src/apiRoutes.ts';
import { selectionKey, selectionInput, selectionFragment, readSelection } from '../src/targets.ts';
import { RemoteUpdates } from '../src/remoteUpdates.ts';

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

test('remote routes preserve original targets and retry bodies across every mutation', () => {
  const base = { networkId: 'network/1', hostId: 'host#1', sessionId: 'same-session', turnId: 'turn', interactionId: 'question', requestId: 'original' };
  for (const operation of ['createSession', 'connectSession', 'sendMessage', 'steerTurn', 'interruptTurn', 'answerQuestions', 'decideApproval']) {
    const input = structuredClone(base), route = apiRequest(operation, input);
    assert.equal(route.method, 'POST');
    assert.ok(route.path.startsWith('/api/v1/networks/network%2F1/hosts/host%231/sessions'));
    assert.equal(route.input.networkId, undefined); assert.equal(route.input.hostId, undefined);
    assert.deepEqual(input, base); assert.deepEqual(apiRequest(operation, input), route);
  }
  const target = { networkId: base.networkId, hostId: base.hostId, membershipId: 'generation-1' };
  const key = selectionKey({ sessionId: base.sessionId, target });
  assert.notEqual(key, base.sessionId);
  assert.notEqual(key, selectionKey({ sessionId: base.sessionId, target: { ...target, hostId: 'other-host' } }));
  assert.notEqual(key, selectionKey({ sessionId: base.sessionId, target: { ...target, membershipId: 'generation-2' } }));
  assert.equal(readSelection(selectionFragment(key)), key);
  assert.deepEqual(selectionInput(key), { networkId: base.networkId, hostId: base.hostId, sessionId: base.sessionId });
  assert.equal(readSelection('session=legacy'), 'legacy');
  assert.equal(sessionUpdatesPath(base.sessionId, target), '/api/v1/networks/network%2F1/hosts/host%231/sessions/same-session/updates');
  const receipt = apiRequest('getRequestReceipt', { networkId: base.networkId, hostId: base.hostId, sourceHostId: 'original-source', requestId: 'original' });
  assert.equal(receipt.path, '/api/v1/hosts/host%231/request-receipts/original?networkId=network%2F1&sourceHostId=original-source');
});

test('remote subscriptions reject changed identities, generations, runtime and replayed events', () => {
  const target = { networkId: 'network', hostId: 'host', membershipId: 'member' };
  const event = { ...target, subscriptionId: 'subscription', eventId: 1, runtimeId: 'runtime', historyId: 'history', payload: { instanceId: 'runtime', details: { session: { sessionId: 'session', hostId: 'host' } } } };
  const updates = new RemoteUpdates(target, 'session');
  assert.equal(updates.consume(event).reset, true);
  assert.throws(() => updates.consume(event), /order/);
  for (const field of ['networkId', 'hostId', 'membershipId', 'runtimeId', 'historyId']) assert.throws(() => updates.consume({ ...event, eventId: 2, [field]: 'changed' }));
  assert.equal(updates.consume({ ...event, eventId: 2 }).reset, false);
  assert.throws(() => updates.consume({ ...event, subscriptionId: 'reconnect', eventId: 3 }), /snapshot/);
  assert.equal(updates.consume({ ...event, subscriptionId: 'reconnect' }).reset, true);
});
