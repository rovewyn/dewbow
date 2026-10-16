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
  const pending = await until(() => control(issuer, 'listNetworkJoins'), value => value.joins.length === 1, 'pending join');
  const request = pending.joins[0];
  assert.equal(request.hostId, joiner.config.hostId);
  assert.equal(request.publicKey, joined.publicKey);
  assert.equal(request.publicKeyFingerprint, joined.publicKeyFingerprint);
  assert.throws(() => network(issuer, 'confirm', request.joinAttemptId, '--public-key', Buffer.alloc(32, 7).toString('base64url')), /INVALID_INPUT/);
  network(issuer, 'confirm', request.joinAttemptId, '--public-key', request.publicKey);
  const ready = await until(() => control(joiner, 'getNetwork'), value => value.localStatus === 'active', 'joiner ready');
  const member = ready.membershipId;
  network(issuer, 'set-peer-address', member, joiner.endpoint);
  return invitation;
}

async function operator(node) {
  const { ticket } = await control(node, 'ticket');
  const response = await fetch(`${node.origin}/auth/login`, { method: 'POST', headers: { Origin: node.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
const sessionId = '00000000-0000-4000-8000-000000000041';
const largeText = 'Synthetic remote text 中文🙂 '.repeat(35000);
function seed(node, title) {
  const state = new DatabaseSync(join(node.home, 'state_1.sqlite'));
  state.prepare("INSERT INTO threads VALUES(?,?,?,?,?,0,0,'{}')").run(sessionId, title, '/synthetic/work', 'cli', 0);
  state.close();
  const db = new DatabaseSync(join(node.home, 'thread_history_1.sqlite'));
  db.prepare('INSERT INTO thread_turns VALUES(?,?,?)').run(sessionId, 'synthetic-turn', 'completed');
  const insert = db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)');
  const items = [
    { id: 'message', type: 'agentMessage', text: title, phase: 'final_answer' },
    { id: 'large', type: 'agentMessage', text: largeText, phase: 'final_answer' },
    { id: 'command', type: 'commandExecution', status: 'completed', command: 'synthetic', aggregatedOutput: '中文🙂\n'.repeat(15000) },
    { id: 'diff', type: 'fileChange', status: 'completed', changes: [{ path: 'synthetic.txt', diff: '@@ -0,0 +1 @@\n+中文🙂\n' }] },
  ];
  items.forEach((item, i) => insert.run(sessionId, 'synthetic-turn', item.id, i + 1, i + 1, 1, 2, JSON.stringify(item), item.type));
  db.close();
}
function records(node) {
  const db = new DatabaseSync(join(node.state, 'daemon.sqlite'), { readOnly: true });
  const value = db.prepare('SELECT * FROM records ORDER BY kind,id').all(); db.close(); return value;
}
async function request(node, cookie, path, status = 200) {
  const response = await fetch(`${node.origin}${path}`, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(20000) });
  const body = await response.json(); assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return body.result ?? body.error;
}
async function stream(node, cookie, path) {
  const controller = new AbortController();
  const response = await fetch(`${node.origin}${path}`, { headers: { Cookie: cookie }, signal: controller.signal });
  assert.equal(response.status, 200, await (response.status === 200 ? '' : response.text()));
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
  return {
    close() { controller.abort(); },
    async next() {
      const deadline = setTimeout(() => controller.abort(), 15000);
      try {
        for (;;) {
          const end = buffer.indexOf('\n\n');
          if (end >= 0) {
            const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const kind = event.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
            const data = event.split('\n').find(line => line.startsWith('data:'))?.slice(5).trim();
            if (kind && data) return { kind, value: JSON.parse(data) };
            continue;
          }
          const { value, done } = await reader.read();
          if (done) return null;
          buffer += decoder.decode(value, { stream: true });
        }
      } finally { clearTimeout(deadline); }
    },
  };
}
async function terminalEvent(stream) {
  // Complete events already handed to HTTP before revocation cannot be retracted.
  for (let i = 0; i < 50; i++) {
    const event = await stream.next();
    if (event === null || event.kind === 'streamError') return event;
  }
  throw new Error('Subscription did not terminate');
}

test('direct Network reads preserve native data, independent targets, subscriptions and revocation', { timeout: 240000 }, async () => {
  const nodes = [], streams = [];
  try {
    for (let i = 0; i < 3; i++) nodes.push(await makeNode());
    const [a, b, c] = nodes;
    seed(b, 'Synthetic B'); seed(c, 'Synthetic C');
    network(a, 'create', 'Synthetic reads', ...settings(a));
    await admit(a, b); await admit(a, c);
    await until(() => control(b, 'listNetworkMembers'), value => value.members.length === 3, 'all members');
    console.log('Network read acceptance: members ready');
    network(c, 'set-peer-address', network(b, 'status').membershipId, b.endpoint);
    network(b, 'set-peer-address', network(c, 'status').membershipId, c.endpoint);
    const net = network(a, 'status').networkId;
    const base = target => `/api/v1/networks/${net}/hosts/${target.config.hostId}`;
    const path = target => `${base(target)}/sessions/${sessionId}`;
    let cookies = await Promise.all(nodes.map(operator));
    const ca = cookies[0]; let cc = cookies[2];
    const before = nodes.map(records);
    assert.equal((await fetch(`${a.origin}${base(b)}`)).status, 401);
    assert.equal((await request(a, ca, base(b))).hosts[0].hostId, b.config.hostId);
    assert.equal((await request(a, ca, `${base(b)}/sessions`)).sessions[0].managed, false);
    assert.equal((await request(a, ca, path(b))).session.name, 'Synthetic B');
    assert.equal((await request(c, cc, path(b))).session.name, 'Synthetic B');
    assert.equal((await request(b, cookies[1], path(c))).session.name, 'Synthetic C');
    assert.equal((await request(b, cookies[1], base(b))).hosts[0].hostId, b.config.hostId, 'explicit local target uses the same authorization');
    const history = await request(a, ca, `${path(b)}/history`);
    assert.equal(history.historyError, null);
    assert.equal(history.messages.find(m => m.id === 'large').text, largeText, 'NDJSON preserves a native value above 1 MiB');
    const page = await request(c, cc, `${path(b)}/history?limit=1`);
    assert.ok(page.beforeCursor);
    const previous = await request(c, cc, `${path(b)}/history?limit=1&beforeCursor=${encodeURIComponent(page.beforeCursor)}`);
    assert.ok(previous.activities.length + previous.messages.length);
    const wrongCursor = await request(b, cookies[1], `${path(c)}/history?beforeCursor=${encodeURIComponent(page.beforeCursor)}`);
    assert.equal(wrongCursor.historyError.code, 'INVALID_INPUT', 'native cursors bind the actual target home');
    const activity = await request(c, cc, `${path(b)}/activities/command`);
    assert.equal(activity.contents[0].completeness, 'unknown');
    let output = '', cursor;
    do {
      const result = await request(c, cc, `${path(b)}/contents/${activity.contents[0].contentId}?limitBytes=65537${cursor ? `&contentCursor=${encodeURIComponent(cursor)}` : ''}`);
      output += result.text; cursor = result.nextCursor; assert.equal(result.completeness, 'unknown');
    } while (cursor);
    assert.equal(output, '中文🙂\n'.repeat(15000));
    const diff = await request(a, ca, `${path(b)}/activities/diff`);
    assert.equal((await request(a, ca, `${path(b)}/contents/${diff.contents[0].contentId}`)).text, '@@ -0,0 +1 @@\n+中文🙂\n');
    for (const query of ['?hostId=other', '?limit=1&limit=2', '?unknown=1']) {
      assert.equal((await request(a, ca, `${base(b)}/sessions${query}`, 400)).code, 'INVALID_INPUT');
    }
    assert.equal((await request(a, ca, `${path(b)}/updates?cursor=0`, 400)).code, 'INVALID_INPUT');
    assert.equal((await request(a, ca, `/api/v1/networks/${Buffer.alloc(32, 8).toString('base64url')}/hosts/${b.config.hostId}`, 403)).code, 'FORBIDDEN');
    console.log('Network read acceptance: inventory, history and content verified');
    const live = await stream(c, cc, `${path(b)}/updates`); streams.push(live);
    const first = await live.next(); assert.equal(first.kind, 'snapshot');
    assert.equal(first.value.hostId, b.config.hostId);
    assert.equal(first.value.runtimeId, first.value.payload.instanceId);
    assert.equal(first.value.payload.history.messages.find(m => m.id === 'large').text, largeText);
    const db = new DatabaseSync(join(b.home, 'thread_history_1.sqlite'));
    const item = { id: 'update', type: 'agentMessage', text: 'Synthetic persisted update', phase: 'final_answer' };
    db.prepare('INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?,?)').run(sessionId, 'synthetic-turn', item.id, 5, 5, 3, 4, JSON.stringify(item), item.type); db.close();
    let update;
    for (let i = 0; i < 5; i++) { update = await live.next(); if (update.value.payload.history.messages.some(m => m.id === 'update')) break; }
    assert.equal(update.kind, 'update');
    assert.ok(update.value.payload.history.messages.some(m => m.id === 'update'));
    assert.equal(update.value.subscriptionId, first.value.subscriptionId);
    live.close();
    const reconnect = await stream(c, cc, `${path(b)}/updates`); streams.push(reconnect);
    const snapshot = await reconnect.next();
    assert.equal(snapshot.kind, 'snapshot'); assert.equal(snapshot.value.eventId, 1);
    assert.notEqual(snapshot.value.subscriptionId, first.value.subscriptionId);
    reconnect.close();
    const logoutStream = await stream(c, cc, `${path(b)}/updates`); streams.push(logoutStream);
    await logoutStream.next();
    assert.equal((await fetch(`${c.origin}/auth/logout`, { method: 'POST', headers: { Cookie: cc, Origin: c.origin } })).status, 200);
    const signedOut = await terminalEvent(logoutStream);
    assert.equal(signedOut.kind, 'streamError'); assert.equal(signedOut.value.code, 'UNAUTHORIZED');
    cc = await operator(c);
    const maintenanceStream = await stream(c, cc, `${path(b)}/updates`); streams.push(maintenanceStream);
    await maintenanceStream.next();
    const ownership = { instanceId: (await control(b, 'status')).instanceId, token: crypto.randomUUID() };
    await control(b, 'beginUpgrade', ownership);
    const maintenance = await terminalEvent(maintenanceStream);
    assert.equal(maintenance.kind, 'streamError'); assert.equal(maintenance.value.code, 'UNAVAILABLE');
    await control(b, 'cancelUpgrade', ownership);
    nodes.forEach((node, i) => assert.deepEqual(records(node), before[i], 'reads do not write management records or adopt native sessions'));
    console.log('Network read acceptance: updates, reconnect, logout and maintenance verified');
    const membershipStream = await stream(c, cc, `${path(c)}/updates`); streams.push(membershipStream);
    assert.equal((await membershipStream.next()).value.hostId, c.config.hostId);
    await stop(b);
    network(a, 'leave');
    await until(() => control(c, 'listNetworkMembers'), value => value.members.length === 2, 'founder leaves');
    const contextChanged = await terminalEvent(membershipStream);
    assert.equal(contextChanged.kind, 'streamError'); assert.equal(contextChanged.value.code, 'SYNC_REQUIRED');
    await stop(a);
    await start(b);
    assert.equal((await request(c, cc, path(b))).session.name, 'Synthetic B', 'an offline target catches up without the founder');
    await stop(c); await start(c); cc = await operator(c);
    assert.equal((await request(c, cc, path(b))).session.name, 'Synthetic B', 'entry restart reconstructs direct reads');
    const restarted = await stream(c, cc, `${path(b)}/updates`); streams.push(restarted);
    const afterRestart = await restarted.next();
    assert.equal(afterRestart.kind, 'snapshot'); assert.notEqual(afterRestart.value.runtimeId, first.value.runtimeId);
    console.log('Network read acceptance: founder exit and entry/target restarts verified');
    network(b, 'remove', network(c, 'status').membershipId);
    const terminal = await terminalEvent(restarted);
    assert.ok(terminal === null || terminal.kind === 'streamError');
    // A denied reconnect fetches exclusion proof. Do not race the background
    // 30-second reconciliation interval (which also has protocol jitter).
    assert.equal((await request(c, cc, path(b), 403)).code, 'FORBIDDEN');
    await until(() => control(c, 'getNetwork'), value => value.localStatus === 'removed', 'reader removed');
    assert.equal((await request(b, await operator(b), `/api/v1/sessions/${sessionId}`)).session.name, 'Synthetic B', 'local reads survive Network removal');
  } finally {
    streams.forEach(s => s.close());
    for (const node of nodes) {
      try { await stop(node); } finally {
        if (node.child?.exitCode === null) { node.child.kill(); await until(() => node.child.exitCode, value => value !== null, 'cleanup'); }
      }
      await fs.rm(node.state, { recursive: true, force: true });
    }
  }
});
