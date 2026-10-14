import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const suffix = process.platform === 'win32' ? '.exe' : '';
const binary = resolve(`target/debug/dewbow${suffix}`);
const fixture = resolve(`target/debug/examples/fixture${suffix}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (state, ...args) => execFileSync(binary, ['--state-dir', state, ...args], { encoding:'utf8', timeout:100000, windowsHide:true,
  env:{...process.env,CODEX_APP_TOOLS_PIPE_PATH:'synthetic-pipe',CODEX_SESSION_ID:'synthetic-parent-session',CODEX_THREAD_ID:'synthetic-parent-thread',DEWBOW_TEST_CANARY:'synthetic-value'} });
async function freePort() { const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
async function prepare() {
  await fs.access(binary); await fs.access(fixture);
  const root = resolve('state'); await fs.mkdir(root, { recursive: true });
  const state = await fs.mkdtemp(join(root, 'rust-test space-'));
  const home = join(state, 'native'), work = join(state, 'work');
  await fs.mkdir(home); await fs.mkdir(work); await fs.writeFile(join(home, 'synthetic.fixture'), 'synthetic');
  const port = await freePort(); invoke(state, 'init', '--codex-executable', fixture, '--codex-home', home, '--port', String(port));
  const config = JSON.parse(await fs.readFile(join(state, 'config.json'), 'utf8'));
  return { state, home, work, port, config, origin: `http://127.0.0.1:${port}` };
}
async function until(read, predicate, description) { for (let i = 0; i < 100; i++) { const value = await read(); if (predicate(value)) return value; await delay(100); } throw new Error(`Timed out: ${description}`); }
async function operator(env) {
  const control = async name => { const response = await fetch(`${env.origin}/internal/${name}`, { method: 'POST', headers: { Connection: 'close', Authorization: `Bearer ${env.config.controlToken}` } }); return (await response.json()).result; };
  const { ticket } = await control('ticket');
  const response = await fetch(`${env.origin}/auth/login`, { method: 'POST', headers: { Connection: 'close', Origin: env.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const request = async (operation, input = {}) => { const response = await fetch(`${env.origin}/api/${operation}`, { method: 'POST', headers: { Connection: 'close', Origin: env.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); const data = await response.json(); if (data.error) throw Object.assign(new Error(data.error.message), data.error); return data.result; };
  return { request, cookie, ticket, control };
}

test('Rust lifecycle, operator authority, execution, callback identity and recovery', { timeout: 180000 }, async () => {
  const env = await prepare(); let started = false, passed = false;
  try {
    console.log('Rust test: starting daemon');
    const first = JSON.parse(invoke(env.state, 'daemon', 'start')); started = true;
    console.log('Rust test: duplicate startup');
    assert.equal(first.status, 'ready'); assert.equal(JSON.parse(invoke(env.state, 'daemon', 'start')).instanceId, first.instanceId);
    const instancePath = join(env.state, 'instance.json');
    const actualInstance = await fs.readFile(instancePath, 'utf8');
    const wrongInstance = JSON.parse(actualInstance); wrongInstance.instanceId = 'synthetic-wrong-instance';
    await fs.writeFile(instancePath, JSON.stringify(wrongInstance));
    assert.throws(() => invoke(env.state, 'daemon', 'stop'), /identity|Identity|RECOVERY_REQUIRED/);
    await fs.writeFile(instancePath, actualInstance);
    assert.equal(JSON.parse(invoke(env.state, 'daemon', 'status')).instanceId, first.instanceId);
    assert.throws(() => execFileSync(binary, ['--state-dir', env.state, 'daemon', 'run'], { encoding: 'utf8', timeout: 5000, windowsHide: true }));
    console.log('Rust test: operator login');
    const op = await operator(env);
    const expiringTicket = (await op.control('ticket')).ticket, ticketIssuedAt = Date.now();
    const nativeParent = crypto.randomUUID(), nativeChild = crypto.randomUUID();
    const nativeState = new DatabaseSync(join(env.home, 'state_1.sqlite'));
    const insertNative = nativeState.prepare("INSERT INTO threads VALUES(?,?,?,?,?,0,0,'{}')");
    insertNative.run(nativeParent,'Archived synthetic parent',env.work,'cli',1);
    insertNative.run(nativeChild,'Synthetic child',env.work,JSON.stringify({subagent:{thread_spawn:{parent_thread_id:nativeParent}}}),0);
    nativeState.close();
    const inventory = await op.request('listSessions');
    assert.equal(inventory.sessions.find(s => s.sessionId === nativeParent).native.archived, true);
    assert.equal(inventory.sessions.find(s => s.sessionId === nativeChild).native.parentId, nativeParent);
    assert.equal(inventory.sessions.find(s => s.sessionId === nativeChild).native.kind, 'child_session');
    await fs.writeFile(join(env.home, `${nativeParent}.writer`),'synthetic busy writer');
    assert.equal((await op.request('connectSession',{sessionId:nativeParent,requestId:'writer-conflict'})).error.code,'SESSION_IN_USE');
    await fs.unlink(join(env.home,`${nativeParent}.writer`));
    const reused = await fetch(`${env.origin}/auth/login`, { method: 'POST', headers: { Origin: env.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: op.ticket }) }); assert.equal(reused.status, 401);
    assert.equal((await fetch(`${env.origin}/internal/status`, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${env.origin}/api/listHosts`, { method: 'POST', headers: { Origin: 'http://foreign.invalid', Cookie: op.cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(`${env.origin}/`)).status, 200);
    assert.equal((await fetch(`${env.origin}/api/subscribeSessionUpdates?sessionId=${nativeChild}&cursor=invalid`,{headers:{Cookie:op.cookie}})).status,400);
    const input = { hostId: env.config.hostId, workDir: env.work, requestId: 'create-a' };
    console.log('Rust test: create session');
    const created = await op.request('createSession', input); assert.equal(created.status, 'delivered', JSON.stringify(created.error));
    const sid = created.sessionId; assert.equal((await op.request('createSession', input)).sessionId, sid);
    await assert.rejects(op.request('createSession', { ...input, workDir: env.home }), { code: 'REQUEST_CONFLICT' });
    const send = message => op.request('sendMessage', { sessionId: sid, message, requestId: crypto.randomUUID() });
    const details = () => op.request('getSession', { sessionId: sid });
    let result = await send('USER_CANARY'); assert.equal(result.status, 'delivered');
    await until(details, d => !d.session.activeTurnId, 'completed native turn');
    let history = await op.request('readSessionHistory', { sessionId: sid }); assert.ok(history.messages.some(m => m.text.includes('USER_CANARY')));
    const thread = (await details()).session.codexThreadId;
    console.log('Rust test: native question');
    result = await send('QUESTIONS'); assert.equal(result.status, 'delivered');
    let detail = await until(details, d => d.interactions.some(i => i.status === 'pending' && i.kind === 'questions'), 'native question');
    const question = detail.interactions.find(i => i.status === 'pending');
    result = await op.request('answerQuestions', { sessionId: sid, turnId: detail.session.activeTurnId, interactionId: question.interactionId, requestId: 'answer-a', answers: [{ questionId: 'choice', answers: ['One'] }] }); assert.equal(result.status, 'delivered', JSON.stringify(result.error));
    await until(details, d => !d.session.activeTurnId, 'question response completion');
    console.log('Rust test: native approval');
    result = await send('APPROVAL'); assert.equal(result.status, 'delivered');
    detail = await until(details, d => d.interactions.some(i => i.status === 'pending' && i.kind === 'approval'), 'native approval');
    const approval = detail.interactions.find(i => i.status === 'pending');
    result = await op.request('decideApproval', { sessionId: sid, turnId: detail.session.activeTurnId, interactionId: approval.interactionId, requestId: 'deny-a', decision: 'deny' }); assert.equal(result.status, 'delivered');
    await until(details, d => !d.session.activeTurnId, 'denied callback completion');
    result = await send('OUTPUT'); assert.equal(result.status, 'delivered');
    await until(details, d => !d.session.activeTurnId, 'captured output completion');
    const activity = (await op.request('readSessionHistory', {sessionId:sid})).activities.find(a => a.type === 'commandExecution');
    assert.equal(activity.contents[0].completeness, 'complete');
    let output='', contentCursor;
    do { const page=await op.request('readSessionContent',{sessionId:sid,contentId:activity.contents[0].contentId,limitBytes:65537,...(contentCursor?{contentCursor}:{})}); output+=page.text;contentCursor=page.nextCursor; } while(contentCursor);
    assert.equal(output,'中文 🚀\n'.repeat(30000));
    await assert.rejects(op.request('readSessionContent',{sessionId:'other-session',contentId:activity.contents[0].contentId}),{code:'NOT_FOUND'});
    const latest = await op.request('readSessionHistory',{sessionId:sid,limit:2});
    assert.ok(latest.beforeCursor);
    const previous = await op.request('readSessionHistory',{sessionId:sid,beforeCursor:latest.beforeCursor,limit:2});
    const latestIds = new Set([...latest.messages,...latest.activities].map(item=>item.id));
    assert.ok([...previous.messages,...previous.activities].every(item=>!latestIds.has(item.id)));
    assert.equal((await op.request('readSessionHistory',{sessionId:nativeChild,beforeCursor:latest.beforeCursor,limit:2})).historyError.code,'INVALID_INPUT');
    console.log('Rust test: active turn and SSE');
    result = await send('WAIT'); const active = (await details()).session.activeTurnId;
    assert.equal((await send('second busy send')).error.code, 'SESSION_BUSY');
    const other = await op.request('createSession',{...input,requestId:'create-independent'});
    assert.equal((await op.request('sendMessage',{sessionId:other.sessionId,message:'Independent turn',requestId:'independent-send'})).status,'delivered');
    await until(()=>op.request('getSession',{sessionId:other.sessionId}),d=>!d.session.activeTurnId,'independent session completion');
    assert.equal((await details()).session.activeTurnId,active);
    assert.equal((await op.request('decideApproval', { sessionId: sid, turnId: active, interactionId: approval.interactionId, requestId: 'stale-approval', decision: 'allow' })).error.code, 'STALE_INTERACTION');
    assert.equal((await op.request('steerTurn', { sessionId: sid, turnId: active, message: 'Steer', requestId: 'steer-a' })).status, 'delivered');
    const streamAbort = new AbortController(); const stream = await fetch(`${env.origin}/api/subscribeSessionUpdates?sessionId=${sid}`, { headers: { Cookie: op.cookie }, signal: streamAbort.signal });
    assert.equal(stream.status, 200); const chunk = await stream.body.getReader().read(); assert.match(new TextDecoder().decode(chunk.value), /event: snapshot/); streamAbort.abort();
    assert.equal((await op.request('interruptTurn', { sessionId: sid, turnId: active, requestId: 'interrupt-a' })).status, 'delivered');
    await until(details, d => !d.session.activeTurnId && d.turns.at(-1).state === 'interrupted', 'native interruption');
    console.log('Rust test: one-use ticket expiry');
    await delay(Math.max(0,61000 - (Date.now() - ticketIssuedAt)));
    assert.equal((await fetch(`${env.origin}/auth/login`,{method:'POST',headers:{Origin:env.origin,'Content-Type':'application/json'},body:JSON.stringify({ticket:expiringTicket})})).status,401);
    console.log('Rust test: stop and restart');
    invoke(env.state, 'daemon', 'stop'); started = false;
    const journal = new DatabaseSync(join(env.state, 'daemon.sqlite'), { readOnly: true });
    const records = journal.prepare('SELECT data FROM records').all().map(r => r.data).join('\n'); const events = journal.prepare('SELECT data FROM events').all().map(r => r.data).join('\n'); journal.close();
    assert.ok(!records.includes('USER_CANARY') && !events.includes('USER_CANARY'), 'Journal must not copy native messages');
    invoke(env.state, 'daemon', 'start'); started = true;
    const again = await operator(env); const recovered = await again.request('getSession', { sessionId: sid });
    assert.equal(recovered.session.codexThreadId, thread); assert.equal(recovered.session.connectionState, 'connected');
    assert.equal((await again.request('sendMessage', { sessionId: sid, message: 'WAIT', requestId: 'uncertain-turn' })).status, 'delivered');
    invoke(env.state, 'daemon', 'stop'); started = false;
    invoke(env.state, 'daemon', 'start'); started = true;
    const final = await operator(env); const unresolved = await final.request('getSession', { sessionId: sid });
    assert.equal(unresolved.session.runtimeState, 'unknown'); assert.ok(unresolved.session.activeTurnId);
    assert.equal((await fetch(`${env.origin}/auth/logout`,{method:'POST',headers:{Origin:env.origin,Cookie:final.cookie}})).status,200);
    await assert.rejects(final.request('listHosts'),{code:'UNAUTHORIZED'});
    passed = true;
  } finally { if (started) invoke(env.state, 'daemon', 'stop'); assert.ok(env.state.startsWith(`${resolve('state')}/`) || env.state.startsWith(`${resolve('state')}\\`)); if (passed) await fs.rm(env.state, { recursive: true, force: true }); }
});

test('Rust startup refuses occupied ports and preserves initialization', { timeout: 60000 }, async () => {
  const env = await prepare(); const original = await fs.readFile(join(env.state, 'config.json'), 'utf8'); const server = createServer();
  try { await new Promise(resolve => server.listen(env.port, '127.0.0.1', resolve)); assert.throws(() => invoke(env.state, 'daemon', 'start')); invoke(env.state, 'init'); assert.equal(await fs.readFile(join(env.state, 'config.json'), 'utf8'), original); assert.equal(await fs.readFile(join(env.home, 'synthetic.fixture'), 'utf8'), 'synthetic'); }
  finally { await new Promise(resolve => server.close(resolve)); await fs.rm(env.state, { recursive: true, force: true }); }
});
