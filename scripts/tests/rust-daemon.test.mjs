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
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const exited = pid => until(async () => alive(pid), value => !value, 'owned process exit');
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
    for (let index = 0; index < 50; index++) {
      assert.equal((await op.request('sendMessage',{sessionId:other.sessionId,message:'Independent turn',requestId:`independent-send-${index}`})).status,'delivered');
      await until(()=>op.request('getSession',{sessionId:other.sessionId}),d=>!d.session.activeTurnId,`independent session completion ${index}`);
      assert.equal((await details()).session.activeTurnId,active);
    }
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

test('Rust recovery verifies stale ownership and recovers abrupt exits', { timeout: 120000 }, async () => {
  const env = await prepare();
  const original = await fs.readFile(join(env.state, 'config.json'), 'utf8');
  const instancePath = join(env.state, 'instance.json');
  const writeRecord = record => fs.writeFile(instancePath, JSON.stringify(record));
  let running;
  try {
    running = JSON.parse(invoke(env.state, 'daemon', 'start'));
    const previous = running;
    invoke(env.state, 'daemon', 'stop'); running = undefined;
    const stale = { instanceId: previous.instanceId, pid: previous.pid, port: env.port };

    await writeRecord({ ...stale, pid: process.pid });
    assert.throws(() => invoke(env.state, 'daemon', 'start'), /still alive/);
    assert.equal(alive(process.pid), true);
    assert.equal(JSON.parse(await fs.readFile(instancePath, 'utf8')).pid, process.pid);

    await writeRecord(stale);
    assert.throws(() => invoke(env.state, 'daemon', 'status'));
    assert.deepEqual(JSON.parse(await fs.readFile(instancePath, 'utf8')), stale);
    const listener = createServer(socket => socket.destroy());
    await new Promise(resolve => listener.listen(env.port, '127.0.0.1', resolve));
    try {
      assert.throws(() => invoke(env.state, 'daemon', 'stop'), /occupied/);
      assert.deepEqual(JSON.parse(await fs.readFile(instancePath, 'utf8')), stale);
    } finally { await new Promise(resolve => listener.close(resolve)); }

    const journal = new DatabaseSync(join(env.state, 'daemon.sqlite'));
    journal.prepare("UPDATE records SET data=? WHERE kind='meta' AND id='owner'").run(JSON.stringify({ pid: process.pid }));
    journal.close();
    assert.throws(() => invoke(env.state, 'daemon', 'start'), /native process is still alive/);
    assert.deepEqual(JSON.parse(await fs.readFile(instancePath, 'utf8')), stale);
    const restored = new DatabaseSync(join(env.state, 'daemon.sqlite'));
    restored.exec("UPDATE records SET data='null' WHERE kind='meta' AND id='owner'"); restored.close();

    await writeRecord({});
    assert.throws(() => invoke(env.state, 'daemon', 'start'), /Invalid daemon ownership/);
    await writeRecord({ ...stale, port: env.port === 65535 ? 65534 : env.port + 1 });
    assert.throws(() => invoke(env.state, 'daemon', 'start'), /ports differ/);
    await writeRecord(stale);
    assert.match(invoke(env.state, 'daemon', 'stop'), /Stopped/);
    await assert.rejects(fs.access(instancePath), { code: 'ENOENT' });

    console.log('Rust recovery: forced daemon exit and restart');
    running = JSON.parse(invoke(env.state, 'daemon', 'start'));
    const killed = running;
    process.kill(killed.pid, 'SIGKILL');
    await exited(killed.pid); await exited(killed.runtimePid); running = undefined;
    await fs.access(instancePath); // Forced exit bypasses cleanup.
    running = JSON.parse(invoke(env.state, 'daemon', 'start'));
    assert.notEqual(running.instanceId, killed.instanceId);
    invoke(env.state, 'daemon', 'stop'); running = undefined;

    assert.equal(await fs.readFile(join(env.state, 'config.json'), 'utf8'), original);
    assert.equal(await fs.readFile(join(env.home, 'synthetic.fixture'), 'utf8'), 'synthetic');
  } finally {
    if (running && alive(running.pid)) invoke(env.state, 'daemon', 'stop');
    await fs.rm(env.state, { recursive: true, force: true });
  }
});

test('Rust stop signals release the owned runtime, instance record and listener', { timeout: 60000 }, async () => {
  const env = await prepare();
  let running;
  try {
    running = JSON.parse(invoke(env.state, 'daemon', 'start'));
    const stale = { instanceId: running.instanceId, pid: running.pid, port: env.port };
    invoke(env.state, 'daemon', 'stop'); running = undefined;
    await fs.writeFile(join(env.state, 'instance.json'), JSON.stringify(stale));
    for (const signal of process.platform === 'win32' ? ['CTRL_BREAK'] : ['SIGTERM', 'SIGHUP', 'SIGINT']) {
      if (process.platform === 'win32') {
        // Give only this synthetic foreground daemon a dedicated, hidden console.
        // A separate sender attaches to it, so the test runner's console is untouched.
        const { default: koffi } = await import('koffi');
        const kernel = koffi.load('kernel32.dll');
        const startup = koffi.struct('RecoveryStartup', {
          cb: 'uint32_t', reserved: 'void *', desktop: 'void *', title: 'void *',
          x: 'uint32_t', y: 'uint32_t', width: 'uint32_t', height: 'uint32_t',
          columns: 'uint32_t', rows: 'uint32_t', fill: 'uint32_t', flags: 'uint32_t',
          show: 'uint16_t', reservedSize: 'uint16_t', reservedData: 'void *',
          stdin: 'void *', stdout: 'void *', stderr: 'void *',
        });
        koffi.struct('RecoveryProcess', { process: 'void *', thread: 'void *', pid: 'uint32_t', tid: 'uint32_t' });
        const create = kernel.func('int __stdcall CreateProcessW(str16 app, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, str16 cwd, const RecoveryStartup *startup, _Out_ RecoveryProcess *process)');
        const close = kernel.func('int __stdcall CloseHandle(void *handle)');
        const child = {};
        const command = Buffer.from(`"${binary}" --state-dir "${env.state}" daemon run\0`, 'utf16le');
        const createNewConsole = 0x10, createNewProcessGroup = 0x200;
        assert.ok(create(binary, command, null, null, 0, createNewConsole | createNewProcessGroup, null, null, { cb: koffi.sizeof(startup), flags: 1, show: 0 }, child));
        close(child.thread); close(child.process);
        running = { pid: child.pid };
        running = await until(async () => { try { return JSON.parse(invoke(env.state, 'daemon', 'status')); } catch { return null; } }, value => value?.status === 'ready', 'foreground daemon readiness');
        assert.equal(running.pid, child.pid);
        execFileSync(process.execPath, ['-e', `
          const kernel = require('koffi').load('kernel32.dll');
          const free = kernel.func('int __stdcall FreeConsole()');
          const attach = kernel.func('int __stdcall AttachConsole(uint32_t pid)');
          const send = kernel.func('int __stdcall GenerateConsoleCtrlEvent(uint32_t event, uint32_t group)');
          free();
          if (!attach(Number(process.argv[1]))) throw new Error('Cannot attach to the synthetic console');
          try { if (!send(1, Number(process.argv[1]))) throw new Error('Cannot send Ctrl+Break'); }
          finally { free(); }
        `, String(child.pid)], { windowsHide: true, timeout: 5000, stdio: 'pipe' });
      } else {
        const child = spawn(binary, ['--state-dir', env.state, 'daemon', 'run'], { stdio: 'ignore' });
        running = { pid: child.pid };
        running = await until(async () => { try { return JSON.parse(invoke(env.state, 'daemon', 'status')); } catch { return null; } }, value => value?.status === 'ready', 'foreground daemon readiness');
        assert.equal(running.pid, child.pid);
        process.kill(running.pid, signal);
      }
      console.log(`Rust recovery: graceful ${signal}`);
      await exited(running.pid); await exited(running.runtimePid); running = undefined;
      await assert.rejects(fs.access(join(env.state, 'instance.json')), { code: 'ENOENT' });
      const owner = new DatabaseSync(join(env.state, 'daemon.sqlite'), { readOnly: true });
      assert.equal(owner.prepare("SELECT data FROM records WHERE kind='meta' AND id='owner'").get().data, 'null'); owner.close();
      const listener = createServer();
      await new Promise(resolve => listener.listen(env.port, '127.0.0.1', resolve));
      await new Promise(resolve => listener.close(resolve));
    }
  } finally {
    if (running && alive(running.pid)) {
      try { invoke(env.state, 'daemon', 'stop'); }
      catch { process.kill(running.pid, 'SIGKILL'); await exited(running.pid); }
    }
    await fs.rm(env.state, { recursive: true, force: true });
  }
});
