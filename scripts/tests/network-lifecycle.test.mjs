import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { apiRequest } from '../../apps/web/src/apiRoutes.ts';

const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = resolve(`target/debug/dewbow${suffix}`);
const fixture = resolve(`target/debug/examples/fixture${suffix}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
const invoke = (node, args, input) => execFileSync(binary, ['--state-dir', node.state, ...args], {
  encoding: 'utf8', input, timeout: 40000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const network = (node, ...args) => JSON.parse(invoke(node, ['network', '--json', ...args]));
async function until(read, predicate, description) {
  for (let i = 0; i < 150; i++) { const value = await read(); if (predicate(value)) return value; await delay(200); }
  throw new Error(`Timed out: ${description}`);
}
async function control(node, name, input = {}) {
  const response = await fetch(`${node.origin}/internal/${name}`, { method: 'POST', headers: { Connection: 'close', Authorization: `Bearer ${node.config.controlToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const body = await response.json();
  if (body.error) throw Object.assign(new Error(body.error.message), body.error);
  return body.result;
}
async function start(node) {
  node.child = spawn(binary, ['--state-dir', node.state, 'daemon', 'run'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  node.child.stdout.on('data', data => { node.diagnostics += data; });
  node.child.stderr.on('data', data => { node.diagnostics += data; });
  await until(() => control(node, 'status').catch(() => null), value => value?.status === 'ready', 'daemon ready');
}
async function stop(node) {
  if (!node.child || node.child.exitCode !== null) return;
  const child = node.child;
  await control(node, 'stop');
  await until(() => child.exitCode, code => code !== null, 'daemon exit');
  assert.equal(child.exitCode, 0);
  // Both the operator and Peer socket must be reusable after owned shutdown.
  for (const number of [node.operatorPort, node.peerPort]) {
    const server = createServer();
    await new Promise((resolve, reject) => server.once('error', reject).listen(number, '127.0.0.1', resolve));
    await new Promise(resolve => server.close(resolve));
  }
}
async function crash(node) {
  // Fault injection is restricted to this test's freshly spawned daemon.
  const child = node.child;
  assert.equal(child.exitCode, null);
  child.kill('SIGKILL');
  await until(() => child.exitCode ?? child.signalCode, value => value !== null, 'abrupt daemon exit');
}
async function makeNode() {
  await fs.mkdir(resolve('state'), { recursive: true });
  const state = await fs.mkdtemp(resolve('state/network-cli-'));
  const home = join(state, 'native'); await fs.mkdir(home); await fs.writeFile(join(home, 'synthetic.fixture'), 'synthetic');
  const operatorPort = await port(), peerPort = await port();
  const node = { state, home, operatorPort, peerPort, origin: `http://127.0.0.1:${operatorPort}`, endpoint: `https://127.0.0.1:${peerPort}`, diagnostics: '' };
  invoke(node, ['init', '--codex-executable', fixture, '--codex-home', home, '--port', String(operatorPort)]);
  node.config = JSON.parse(await fs.readFile(join(state, 'config.json'), 'utf8'));
  await start(node);
  return node;
}
const settings = node => ['--listen-endpoint', node.endpoint, '--advertised-endpoint', node.endpoint];
async function admit(issuer, joiner) {
  const issuing = await operator(issuer), joining = await operator(joiner);
  const { networkId } = await issuing.request('getNetwork', {});
  const invitation = (await issuing.request('createInvitation', { networkId, requestId: crypto.randomUUID() })).invitation;
  const input = { invitation, requestId: crypto.randomUUID(), listenEndpoint: joiner.endpoint, advertisedEndpoints: [joiner.endpoint] };
  const joined = await joining.request('joinNetwork', input);
  assert.equal(joined.status, 'prepared');
  assert.equal((await joining.request('joinNetwork', input)).joinAttemptId, joined.joinAttemptId);
  const pending = await until(() => issuing.request('listNetworkJoins', { networkId }), value => value.joins.length === 1, 'pending Web join');
  const request = pending.joins[0];
  assert.equal(request.hostId, joiner.config.hostId);
  assert.equal(request.publicKey, joined.publicKey);
  assert.equal(request.publicKeyFingerprint, joined.publicKeyFingerprint);
  const confirmation = { networkId, joinAttemptId: request.joinAttemptId, publicKey: request.publicKey, decision: 'allow', requestId: crypto.randomUUID() };
  await assert.rejects(issuing.request('confirmNetworkJoin', { ...confirmation, publicKey: Buffer.alloc(32, 7).toString('base64url') }), { code: 'INVALID_INPUT' });
  await issuing.request('confirmNetworkJoin', confirmation);
  await until(() => joining.request('getNetwork', {}), value => value.localStatus === 'active', 'joiner ready');
  const member = network(joiner, 'status').membershipId;
  await issuing.request('setNetworkPeerAddress', { networkId, membershipId: member, endpoint: joiner.endpoint, requestId: crypto.randomUUID() });
  return invitation;
}

async function operator(node, networkId) {
  const { ticket } = await control(node, 'ticket');
  const response = await fetch(`${node.origin}/auth/login`, { method: 'POST', headers: { Connection: 'close', Origin: node.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const raw = async (path, options = {}) => {
    const response = await fetch(`${node.origin}${path}`, { ...options, headers: { Connection: 'close', Origin: node.origin, Cookie: cookie, 'Content-Type': 'application/json', ...options.headers } });
    const body = await response.json();
    if (body.error) throw Object.assign(new Error(body.error.message), body.error);
    return { value: body.result, location: response.headers.get('location') };
  };
  const request = async (name, input) => {
    const scoped = networkId && input?.hostId && input.hostId !== node.config.hostId && name !== "getRequestReceipt" ? { ...input, networkId } : input;
    const route = apiRequest(name, scoped);
    return (await raw(route.path, { method: route.method, ...(route.input ? { body: JSON.stringify(route.input) } : {}) })).value;
  };
  return { raw, request };
}

function journal(node, sql, ...params) {
  const db = new DatabaseSync(join(node.state, 'daemon.sqlite'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

async function recoverOriginal(op, operation, input) {
  const deadline = Date.now() + 45000;
  for (;;) {
    try { return await op.request(operation, input); }
    catch (cause) {
      if (!['NOT_READY', 'DELIVERY_UNCERTAIN', 'SYNC_REQUIRED', 'UNAVAILABLE'].includes(cause.code) || Date.now() >= deadline) throw cause;
      await delay(200);
    }
  }
}

test('remote native operations retain scoped receipts, authority and recovery over real TLS', { timeout: 420000 }, async () => {
  const nodes = [];
  try {
    for (let i = 0; i < 3; i++) nodes.push(await makeNode());
    const [a, b, c] = nodes;
    const setup = await operator(a);
    assert.equal((await fetch(a.origin + '/api/v1/network')).status, 401);
    const beforeSetup = await setup.request('getNetwork', {});
    const badSetup = { networkName: 'Synthetic execution', listenEndpoint: a.endpoint, advertisedEndpoints: [a.endpoint], requestId: 'bad-web-setup', unexpected: true };
    await assert.rejects(setup.request('createNetwork', badSetup), { code: 'INVALID_INPUT' });
    assert.deepEqual((await setup.request('getNetwork', {})).peerSettings, beforeSetup.peerSettings, 'invalid input cannot reconfigure the Peer listener');
    await assert.rejects(setup.raw('/api/v1/networks', { method: 'POST', headers: { Origin: 'http://invalid.example' }, body: JSON.stringify(badSetup) }), { code: 'UNAUTHORIZED' });
    await setup.request('createNetwork', { networkName: 'Synthetic execution', listenEndpoint: a.endpoint, advertisedEndpoints: [a.endpoint], requestId: 'web-create-network' });
    await assert.rejects(setup.request('createNetwork', { ...badSetup, requestId: 'web-create-network' }), { code: 'REQUEST_CONFLICT' }, 'changed retries retain the original fingerprint conflict precedence');
    await admit(a, b); await admit(a, c);
    await until(() => nodes.map(node => network(node, 'members').members.length), counts => counts.every(n => n === 3), 'all admitted peers known');
    const member = node => network(node, 'status').membershipId;
    for (const source of nodes) for (const target of nodes) if (source !== target) network(source, 'set-peer-address', member(target), target.endpoint);
    await until(() => nodes.map(node => network(node, 'status').historyId), ids => new Set(ids).size === 1, 'compatible execution context');
    const networkId = network(a, 'status').networkId;
    let oa = await operator(a, networkId), ob = await operator(b);
    const oc = await operator(c, networkId), hostId = b.config.hostId;
    const creation = { hostId, workDir: b.state, requestId: 'shared-id' };
    await assert.rejects(oa.raw('/api/v1/network?networkId=unexpected'), { code: 'INVALID_INPUT' });
    await assert.rejects(oa.raw('/api/v1/networks/' + Buffer.alloc(32, 9).toString('base64url') + '/members'), { code: 'FORBIDDEN' });
    await assert.rejects(oa.raw('/api/v1/networks/' + networkId + '/hosts/' + hostId + '/sessions', { method: 'POST', body: JSON.stringify({ ...creation, hostId }) }), { code: 'INVALID_INPUT' });
    const created = await oa.request('createSession', creation);
    assert.equal(created.status, 'delivered', JSON.stringify(created));
    const racing = await Promise.all([0, 1].map(() => oa.request('createSession', { ...creation, requestId: 'same-entry-race' })));
    assert.equal(racing[0].commandId, racing[1].commandId, 'concurrent identical entry submissions share one receipt');
    assert.deepEqual(await oa.request('createSession', creation), created);
    const fromC = await oc.request('createSession', creation);
    const local = await ob.request('createSession', creation);
    assert.equal(new Set([created.commandId, fromC.commandId, local.commandId]).size, 3, 'local and two source scopes do not alias');
    assert.equal(journal(a, "SELECT count(*) AS n FROM records WHERE kind='session'")[0].n, 0, 'entry does not own remote conversations');
    await assert.rejects(oa.request('createSession', { ...creation, hostId: c.config.hostId }), { code: 'REQUEST_CONFLICT' });
    await assert.rejects(oa.request('createSession', { ...creation, hostId: a.config.hostId, workDir: a.state }), { code: 'REQUEST_CONFLICT' });
    await assert.rejects(oa.request('createSession', { ...creation, workDir: c.state }), { code: 'REQUEST_CONFLICT' });
    const sid = created.sessionId, details = () => ob.request('getSession', { sessionId: sid });
    const configuration = (await details()).session.sessionConfig;
    assert.equal(configuration.resolved.approvalPolicy, 'on-request');
    assert.equal(configuration.resolved.sandbox.type, 'workspaceWrite');
    assert.equal((await oa.request('connectSession', { hostId, sessionId: sid, requestId: 'connect' })).status, 'delivered');
    const send = (op, message, requestId, sessionId = sid) => op.request('sendMessage', { hostId, sessionId, message, requestId });
    await send(oa, 'WAIT', 'wait');
    const active = (await until(details, d => !!d.session.activeTurnId, 'remote active turn')).session.activeTurnId;
    assert.equal((await send(oc, 'competing turn', 'busy')).error.code, 'SESSION_BUSY');
    assert.equal((await oa.request('steerTurn', { hostId, sessionId: sid, turnId: active, message: 'Synthetic steering', requestId: 'steer' })).status, 'delivered');
    assert.equal((await oc.request('interruptTurn', { hostId, sessionId: sid, turnId: active, requestId: 'interrupt' })).status, 'delivered');
    await until(details, d => !d.session.activeTurnId, 'remote interrupt completion');
    for (const [message, kind] of [['QUESTIONS', 'questions'], ['APPROVAL', 'approval']]) {
      await send(oa, message, `send-${kind}`);
      const d = await until(details, d => d.interactions.some(i => i.kind === kind && i.status === 'pending'), kind);
      const interaction = d.interactions.find(i => i.kind === kind && i.status === 'pending');
      const name = kind === 'questions' ? 'answerQuestions' : 'decideApproval';
      const input = { hostId, sessionId: sid, turnId: d.session.activeTurnId, interactionId: interaction.interactionId, requestId: `resolve-${kind}`, ...(kind === 'questions' ? { answers: [{ questionId: 'choice', answers: ['One'] }] } : { decision: 'deny' }) };
      const receipt = await oc.request(name, input);
      assert.equal(receipt.status, 'delivered', JSON.stringify(receipt));
      assert.equal((await oc.request(name, input)).commandId, receipt.commandId, 'callback response is not replayed');
      await until(details, d => !d.session.activeTurnId, 'callback completion');
    }
    // Lose the entry HTTP response after target admission and native dispatch.
    await fs.writeFile(join(b.home, 'upgrade-slow-start-once'), 'synthetic');
    const aborted = new AbortController();
    const lostInput = { hostId, workDir: b.state, requestId: 'lost-response' };
    const route = apiRequest('createSession', lostInput);
    const lost = oa.raw(route.path, { method: 'POST', body: JSON.stringify(route.input), signal: aborted.signal }).catch(error => error);
    await until(() => fs.access(join(b.home, 'upgrade-slow-start-once')).then(() => false, () => true), Boolean, 'native received create');
    aborted.abort(); await lost;
    await until(() => journal(b, "SELECT receipt_json FROM network_request_receipts WHERE request_id='lost-response'"), rows => rows.length && JSON.parse(rows[0].receipt_json).status === 'delivered', 'target continues after entry disconnect');
    const original = JSON.parse(journal(b, "SELECT receipt_json FROM network_request_receipts WHERE request_id='lost-response'")[0].receipt_json);
    await crash(a); await start(a); oa = await operator(a, networkId);
    assert.equal((await oa.request('createSession', lostInput)).commandId, original.commandId, 'entry restart queries original target');
    const retryRoute = apiRequest('createSession', lostInput);
    const retry = await oa.raw(retryRoute.path, { method: 'POST', body: JSON.stringify(retryRoute.input) });
    assert.equal((await oa.raw(retry.location)).value.receipt.commandId, original.commandId);

    const scopePath = `/api/v1/hosts/${hostId}/request-receipts/shared-id?networkId=${networkId}&sourceHostId=${a.config.hostId}`;
    // Native persistence without its request acknowledgement must not trigger a second turn.
    const uncertain = await send(oa, 'UNCERTAIN_COMPLETE', 'native-uncertain', local.sessionId);
    assert.ok(['unknown', 'delivered'].includes(uncertain.status));
    const uncertainPath = scopePath.replace('shared-id', 'native-uncertain');
    await until(() => oa.raw(uncertainPath), r => r.value.receipt?.status === 'delivered', 'native persistence resolves delivery');
    const recovered = await send(oa, 'UNCERTAIN_COMPLETE', 'native-uncertain', local.sessionId);
    assert.equal(recovered.commandId, uncertain.commandId);
    const nativeHistory = await ob.request('readSessionHistory', { sessionId: local.sessionId });
    assert.equal(nativeHistory.messages.filter(m => m.clientId === uncertain.commandId).length, 1, 'native request was delivered once');
    const before = journal(b, 'SELECT receipt_json FROM network_request_receipts');
    assert.equal((await ob.raw(scopePath)).value.receipt.commandId, created.commandId);
    assert.deepEqual(journal(b, 'SELECT receipt_json FROM network_request_receipts'), before, 'receipt inspection does not write');
    // A target restart invalidates callbacks but retains all delivery receipts.
    await send(oa, 'QUESTIONS', 'before-target-restart');
    const pending = await until(details, d => d.interactions.some(i => i.status === 'pending'), 'restart callback');
    const question = pending.interactions.find(i => i.status === 'pending');
    await crash(b); await start(b); ob = await operator(b);
    assert.equal((await oa.raw(scopePath)).value.receipt.commandId, created.commandId);
    const stale = await oa.request('answerQuestions', { hostId, sessionId: sid, turnId: pending.session.activeTurnId, interactionId: question.interactionId, requestId: 'stale-callback', answers: [{ questionId: 'choice', answers: ['One'] }] });
    assert.equal(stale.error.code, 'STALE_INTERACTION');
    // Withdrawal revokes future access, leaves admitted work running, and permits another member to inspect it.
    await send(oa, 'WAIT', 'survives-removal', fromC.sessionId);
    const remoteDetails = () => ob.request('getSession', { sessionId: fromC.sessionId });
    const running = await until(remoteDetails, d => !!d.session.activeTurnId, 'turn before removal');
    const oldMember = member(a);
    network(b, 'remove', oldMember);
    await until(() => network(a, 'status'), s => s.localStatus === 'removed', 'caller exclusion');
    await until(() => network(c, 'status').historyId, history => history === network(b, 'status').historyId, 'inspecting member reconciled');
    assert.equal((await remoteDetails()).session.activeTurnId, running.session.activeTurnId);
    await assert.rejects(send(oa, 'denied', 'after-removal', fromC.sessionId), { code: 'FORBIDDEN' });
    const removedReceipt = scopePath.replace('shared-id', 'survives-removal');
    assert.equal((await oc.raw(removedReceipt)).value.receipt.requestId, 'survives-removal');
    assert.equal((await oc.request('interruptTurn', { hostId, sessionId: fromC.sessionId, turnId: running.session.activeTurnId, requestId: 'interrupt-after-removal' })).status, 'delivered');
    network(a, 'leave'); await admit(b, a);
    assert.notEqual(member(a), oldMember);
    // Admission can precede the next bounded handshake on a loaded runner. Every
    // recovery attempt retains the original identity, input and target.
    assert.equal((await recoverOriginal(oa, 'createSession', creation)).commandId, created.commandId, 'fresh admission does not bypass receipts');
    const encoded = journal(b, 'SELECT receipt_json,recovery_refs_json FROM network_request_receipts').map(row => JSON.stringify(row)).join('');
    for (const secret of ['Synthetic steering', '"answers"', '"nativeRequestId"', '"nativeMethod"']) assert.ok(!encoded.includes(secret), 'no callback or message bodies in receipts');
    assert.ok(journal(b, 'PRAGMA user_version')[0].user_version === 2);
    assert.deepEqual((await ob.request('getSession', { sessionId: sid })).session.sessionConfig, configuration);
    network(a, 'leave'); network(a, 'create', 'Synthetic independent Network', ...settings(a));
    await assert.rejects(oa.request('createSession', creation), { code: 'FORBIDDEN' }, 'a scoped Web request cannot follow a new Network selection');
    const legacy = await operator(a);
    await assert.rejects(legacy.request('createSession', creation), { code: 'REQUEST_CONFLICT' }, 'legacy requests retain their original outbound binding');
  } finally {
    for (const node of nodes.reverse()) {
      try { await stop(node); } catch (cause) { console.error(node.diagnostics); throw cause; }
      await fs.rm(node.state, { recursive: true, force: true });
    }
  }
});

test('CLI membership survives founder crash, stale snapshots, offline removal and readmission', { timeout: 300000 }, async () => {
  const nodes = [], invitations = [];
  let stale;
  try {
    for (let i = 0; i < 4; i++) nodes.push(await makeNode());
    const [a, b, c, d] = nodes;
    network(a, 'create', 'Synthetic Network', ...settings(a));
    const founder = network(a, 'status').membershipId;
    invitations.push(await admit(a, b));
    invitations.push(await admit(a, c));
    const cMember = network(c, 'status').membershipId;
    await until(() => network(b, 'members'), value => value.members.length === 3, 'membership synchronization');
    // Loopback advertisements are intentionally not learned from remote hints.
    network(b, 'set-peer-address', cMember, c.endpoint);
    await crash(a);
    invitations.push(await admit(b, d));
    const founderRemover = await operator(d);
    await until(() => network(d, 'members'), value => value.members.some(m => m.membershipId === founder), 'new member knows absent founder');
    network(d, 'set-peer-address', network(b, 'status').membershipId, b.endpoint);
    await founderRemover.request('removeNetworkMember', { networkId: network(d, 'status').networkId, membershipId: founder, requestId: 'remove-absent-founder' });
    await until(() => network(b, 'members'), value => !value.members.some(m => m.membershipId === founder), 'new member removes absent founder');
    await start(a);
    await until(() => network(a, 'status'), value => value.localStatus === 'removed', 'returning founder learns removal');
    network(c, 'set-peer-address', network(b, 'status').membershipId, b.endpoint);
    await stop(c);
    const staleState = await fs.mkdtemp(resolve('state/network-stale-'));
    stale = { ...c, state: staleState, child: undefined, diagnostics: '' };
    await fs.cp(c.state, stale.state, { recursive: true });
    assert.equal(journal(stale, "SELECT status FROM network_selections WHERE status='active'").length, 1, 'snapshot retains its old active admission');
    const oldKey = network(b, 'members').members.find(m => m.membershipId === cMember).publicKey;
    const removing = await operator(b);
    const removalInput = { networkId: network(b, 'status').networkId, membershipId: cMember, requestId: 'synthetic-offline-removal' };
    await removing.request('removeNetworkMember', removalInput);
    network(b, 'remove', cMember, '--request-id', 'synthetic-offline-removal');
    assert.throws(() => network(b, 'remove', network(d, 'status').membershipId, '--request-id', 'synthetic-offline-removal'), /REQUEST_CONFLICT/);
    await start(c);
    await until(() => network(c, 'status'), value => value.localStatus === 'removed', 'offline target learns removal');
    network(c, 'leave');
    invitations.push(await admit(b, c));
    const freshMember = network(c, 'status').membershipId;
    assert.notEqual(freshMember, cMember, 'readmission creates a new generation');
    const freshKey = network(c, 'members').members.find(m => m.membershipId === freshMember).publicKey;
    assert.equal(typeof freshKey, 'string');
    assert.notEqual(freshKey, oldKey, 'readmission replaces the revoked generation key');
    // Restore only a marked, offline synthetic copy. Other members retain the
    // accepted removal and fresh admission; the old private key grants no return.
    await stop(c);
    await start(stale);
    await until(() => network(stale, 'status'), value => value.localStatus === 'removed', 'old snapshot learns exact-generation removal');
    await assert.rejects(control(stale, 'createInvitation', { requestId: 'stale-key-invite' }), { code: 'UNAVAILABLE' });
    assert.ok(!network(b, 'members').members.some(m => m.membershipId === cMember));
    assert.equal(network(b, 'members').members.find(m => m.membershipId === freshMember).publicKey, freshKey);
    await stop(stale);
    await start(c);
    network(b, 'remove', cMember, '--request-id', 'synthetic-offline-removal');
    assert.equal(network(c, 'status').localStatus, 'active', 'old removal retry cannot withdraw a fresh generation');
    network(c, 'leave');
    const own = network(d, 'status').membershipId;
    const ownOperator = await operator(d);
    await stop(b);
    await ownOperator.request('removeNetworkMember', { networkId: network(d, 'status').networkId, membershipId: own, requestId: 'web-self-exit' });
    assert.equal(network(d, 'status').localStatus, 'left');
    await stop(d); await start(d);
    assert.equal(network(d, 'status').localStatus, 'left', 'offline self-exit persists across restart');
    await start(b);
    await until(() => network(b, 'members'), value => !value.members.some(m => m.membershipId === own), 'restarted departing node propagates offline self-exit');
    // Maintenance blocks membership writes without disabling status reads.
    const status = await control(b, 'status');
    const ownership = { instanceId: status.instanceId, token: crypto.randomUUID() };
    await control(b, 'beginUpgrade', ownership);
    await assert.rejects(control(b, 'leaveNetwork', { requestId: 'synthetic-maintenance-leave' }), { code: 'UNAVAILABLE' });
    assert.equal(network(b, 'status').localStatus, 'active');
    await control(b, 'cancelUpgrade', ownership);
    // Rejected, occupied listener settings remain inspectable and can be corrected by retry.
    const invalidRequest = { networkName: 'Synthetic occupied listener', requestId: 'synthetic-occupied', listenEndpoint: b.origin.replace('http:', 'https:'), advertisedEndpoints: [b.endpoint] };
    await assert.rejects(control(c, 'createNetwork', invalidRequest));
    assert.equal(network(c, 'status').peerListenerStatus, 'stopped');
    network(c, 'create', 'Synthetic replacement', ...settings(c));
    for (const node of nodes) {
      const db = new DatabaseSync(join(node.state, 'daemon.sqlite'), { readOnly: true });
      assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE kind='session'").get().count, 0, 'membership alone starts no conversation');
      db.close();
      for (const secret of invitations) assert.ok(!node.diagnostics.includes(secret), 'invitation absent from diagnostics');
      assert.ok(!JSON.stringify(network(node, 'status')).includes('dewbow-network-v1.'));
    }
  } finally {
    if (stale) {
      await stop(stale);
      await fs.rm(stale.state, { recursive: true, force: true });
    }
    for (const node of nodes) {
      try { await stop(node); } finally {
        if (node.child?.exitCode === null) { node.child.kill(); await until(() => node.child.exitCode, value => value !== null, 'fixture cleanup'); }
      }
      await fs.rm(node.state, { recursive: true, force: true });
    }
  }
});
