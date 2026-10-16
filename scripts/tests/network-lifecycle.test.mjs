import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

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
  const invitation = network(issuer, 'invite').invitation;
  const joined = JSON.parse(invoke(joiner, ['network', '--json', 'join', '--invitation-stdin', ...settings(joiner)], `${invitation}\n`));
  assert.equal(joined.status, 'prepared');
  const pending = await until(() => network(issuer, 'pending'), value => value.joins.length === 1, 'pending join');
  const request = pending.joins[0];
  assert.equal(request.hostId, joiner.config.hostId);
  assert.equal(request.publicKey, joined.publicKey);
  assert.equal(request.publicKeyFingerprint, joined.publicKeyFingerprint);
  assert.throws(() => network(issuer, 'confirm', request.joinAttemptId, '--public-key', Buffer.alloc(32, 7).toString('base64url')), /INVALID_INPUT/);
  network(issuer, 'confirm', request.joinAttemptId, '--public-key', request.publicKey);
  await until(() => network(joiner, 'status'), value => value.localStatus === 'active', 'joiner ready');
  const member = network(joiner, 'status').membershipId;
  network(issuer, 'set-peer-address', member, joiner.endpoint);
  return invitation;
}

test('CLI membership lifecycle survives founder exit, offline removal and daemon restart', { timeout: 240000 }, async () => {
  const nodes = [], invitations = [];
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
    const leave = network(a, 'leave', '--request-id', 'synthetic-founder-leave');
    assert.equal(leave.network.localStatus, 'left');
    network(a, 'leave', '--request-id', 'synthetic-founder-leave');
    await until(() => network(b, 'members'), value => !value.members.some(m => m.membershipId === founder), 'founder withdrawal');
    await stop(a);
    invitations.push(await admit(b, d));
    network(c, 'set-peer-address', network(b, 'status').membershipId, b.endpoint);
    await stop(c);
    network(b, 'remove', cMember, '--request-id', 'synthetic-offline-removal');
    network(b, 'remove', cMember, '--request-id', 'synthetic-offline-removal');
    assert.throws(() => network(b, 'remove', network(d, 'status').membershipId, '--request-id', 'synthetic-offline-removal'), /REQUEST_CONFLICT/);
    await start(c);
    await until(() => network(c, 'status'), value => value.localStatus === 'removed', 'offline target learns removal');
    network(c, 'leave');
    invitations.push(await admit(b, c));
    assert.notEqual(network(c, 'status').membershipId, cMember, 'readmission creates a new generation');
    network(b, 'remove', cMember, '--request-id', 'synthetic-offline-removal');
    assert.equal(network(c, 'status').localStatus, 'active', 'old removal retry cannot withdraw a fresh generation');
    network(c, 'leave');
    const own = network(d, 'status').membershipId;
    network(d, 'remove', own);
    assert.equal(network(d, 'status').localStatus, 'left');
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
    await start(a);
    for (const node of nodes) {
      const db = new DatabaseSync(join(node.state, 'daemon.sqlite'), { readOnly: true });
      assert.equal(db.prepare("SELECT count(*) AS count FROM records WHERE kind='session'").get().count, 0, 'membership alone starts no conversation');
      db.close();
      for (const secret of invitations) assert.ok(!node.diagnostics.includes(secret), 'invitation absent from diagnostics');
      assert.ok(!JSON.stringify(network(node, 'status')).includes('dewbow-network-v1.'));
    }
  } finally {
    for (const node of nodes) {
      try { await stop(node); } finally {
        if (node.child?.exitCode === null) { node.child.kill(); await until(() => node.child.exitCode, value => value !== null, 'fixture cleanup'); }
      }
      await fs.rm(node.state, { recursive: true, force: true });
    }
  }
});
