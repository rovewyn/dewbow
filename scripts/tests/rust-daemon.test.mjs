import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
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
  const control = async (name, input) => { const response = await fetch(`${env.origin}/internal/${name}`, { method: 'POST', headers: { Connection: 'close', Authorization: `Bearer ${env.config.controlToken}`, ...(input ? { 'Content-Type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) }); const data = await response.json(); if (data.error) throw Object.assign(new Error(data.error.message), data.error); return data.result; };
  const { ticket } = await control('ticket');
  const response = await fetch(`${env.origin}/auth/login`, { method: 'POST', headers: { Connection: 'close', Origin: env.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const request = async (operation, input = {}) => { const response = await fetch(`${env.origin}/api/${operation}`, { method: 'POST', headers: { Connection: 'close', Origin: env.origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); const data = await response.json(); if (data.error) throw Object.assign(new Error(data.error.message), data.error); return data.result; };
  return { request, cookie, ticket, control };
}

test('upgrade preflight preserves service and maintenance drains admitted work', { timeout: 90000 }, async () => {
  const env = await prepare();
  try {
    const first = JSON.parse(invoke(env.state, 'daemon', 'start'));
    const op = await operator(env);
    const install = join(env.state, 'installation'); await fs.mkdir(install);
    const installed = join(install, `dewbow${suffix}`); await fs.copyFile(binary, installed); await fs.chmod(installed, 0o755);
    const archive = join(install, 'corrupt-release');
    await fs.writeFile(archive, 'synthetic interrupted download');
    await fs.writeFile(`${archive}.sha256`, `${'0'.repeat(64)}  archive\n`);
    assert.throws(() => execFileSync(installed, ['--state-dir', env.state, 'upgrade', '--version', '99.0.0', '--archive', archive], { encoding: 'utf8', timeout: 30000, windowsHide: true }), /checksum/);
    assert.equal((await op.control('status')).instanceId, first.instanceId, 'A preflight failure must not stop the live daemon');
    assert.equal((await op.control('status')).maintenance, false);
    const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' : process.platform === 'linux' ? 'x86_64-unknown-linux-gnu' : process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
    const releaseName = `dewbow-99.0.0-${target}`, packageRoot = join(install, releaseName);
    await fs.mkdir(packageRoot); await fs.copyFile(binary, join(packageRoot, `dewbow${suffix}`)); await fs.writeFile(join(packageRoot, 'CLI.md'), '# Synthetic release');
    const packagePath = join(install, `${releaseName}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`);
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    for (const rollbackSafe of [false, true]) {
      await fs.writeFile(join(packageRoot, 'release.json'), JSON.stringify({ version: '99.0.0', target, executable: `dewbow${suffix}`, binarySha256: hash(await fs.readFile(binary)), upgrade: { contractVersion: 'v1', stateSchema: 1, rollbackSafe } }));
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
      execFileSync(tar, [process.platform === 'win32' ? '-acf' : '-czf', packagePath, '-C', install, releaseName], { windowsHide: true });
      await fs.writeFile(`${packagePath}.sha256`, `${hash(await fs.readFile(packagePath))}  ${packagePath.slice(install.length + 1)}\n`);
      assert.throws(() => execFileSync(installed, ['--state-dir', env.state, 'upgrade', '--version', '99.0.0', '--archive', packagePath], { encoding: 'utf8', timeout: 30000, windowsHide: true }), rollbackSafe ? /wrong version/ : /manual state/);
      assert.equal((await op.control('status')).instanceId, first.instanceId);
      assert.equal((await op.control('status')).maintenance, false);
    }
    const ownership = { instanceId: first.instanceId, token: crypto.randomUUID() };
    await fs.writeFile(join(env.home, 'upgrade-slow-start-once'), 'synthetic');
    const connecting = op.request('createSession', { hostId: env.config.hostId, workDir: env.work, requestId: 'upgrade-create' });
    await until(async () => fs.access(join(env.home, 'upgrade-slow-start-once')).then(() => false, () => true), Boolean, 'admitted native create');
    assert.equal((await op.control('beginUpgrade', ownership)).inFlight, 1);
    await assert.rejects(op.control('stopUpgrade', ownership), { code: 'SESSION_BUSY' });
    await assert.rejects(op.control('pollUpgrade', { ...ownership, token: crypto.randomUUID() }), { code: 'UNAVAILABLE' });
    await assert.rejects(op.control('cancelUpgrade', { ...ownership, instanceId: 'another-instance' }), { code: 'RECOVERY_REQUIRED' });
    const created = await connecting; assert.equal(created.status, 'delivered');
    await op.control('cancelUpgrade', ownership);
    const sid = created.sessionId;
    const input = { sessionId: sid, message: 'QUESTIONS', requestId: 'upgrade-question' };
    await op.request('sendMessage', input);
    const detail = await until(() => op.request('getSession', { sessionId: sid }), d => d.interactions.some(i => i.status === 'pending'), 'draining question');
    assert.equal((await op.control('beginUpgrade', ownership)).activeTurns, 1);
    for (const [name, input] of [
      ['createSession', { hostId: env.config.hostId, workDir: env.work, requestId: 'blocked-create' }],
      ['connectSession', { sessionId: sid, requestId: 'blocked-connect' }],
      ['sendMessage', { sessionId: sid, message: 'blocked', requestId: 'blocked-send' }],
    ]) await assert.rejects(op.request(name, input), { code: 'UNAVAILABLE' });
    assert.equal((await op.request('sendMessage', input)).status, 'delivered', 'Idempotent reads do not execute new work');
    const question = detail.interactions.find(i => i.status === 'pending');
    assert.equal((await op.request('answerQuestions', { sessionId: sid, turnId: detail.session.activeTurnId, interactionId: question.interactionId, requestId: 'upgrade-answer', answers: [{ questionId: 'choice', answers: ['One'] }] })).status, 'delivered');
    await until(() => op.control('pollUpgrade', ownership), v => v.activeTurns === 0 && v.inFlight === 0, 'drained native work');
    await op.control('cancelUpgrade', ownership);
    assert.equal((await op.control('status')).maintenance, false);
    assert.equal((await op.request('sendMessage', { sessionId: sid, message: 'admission restored', requestId: 'upgrade-restored' })).status, 'delivered');
  } finally {
    try { invoke(env.state, 'daemon', 'stop'); } finally { await fs.rm(env.state, { recursive: true, force: true }); }
  }
});

test('receipt cleanup survives restart and permits new execution outside the retry window', { timeout: 90000 }, async () => {
  const env = await prepare(); let started = false;
  try {
    invoke(env.state, 'daemon', 'start'); started = true;
    let op = await operator(env);
    const created = await op.request('createSession', { hostId: env.config.hostId, workDir: env.work, requestId: 'retention-create' });
    const input = { sessionId: created.sessionId, message: 'Synthetic retained message', requestId: 'retention-send' };
    const first = await op.request('sendMessage', input);
    await until(() => op.request('getSession', { sessionId: created.sessionId }), d => !d.session.activeTurnId, 'first retention turn completion');
    assert.equal((await op.request('sendMessage', input)).commandId, first.commandId);
    invoke(env.state, 'daemon', 'stop'); started = false;
    const db = new DatabaseSync(join(env.state, 'daemon.sqlite'));
    try {
      const receipt = JSON.parse(db.prepare("SELECT data FROM records WHERE kind='operation' AND id=?").get(input.requestId).data);
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      receipt.createdAt = old;
      db.prepare("UPDATE records SET data=? WHERE kind='operation' AND id=?").run(JSON.stringify(receipt), input.requestId);
      for (const [requestId, status, createdAt] of [
        ['retention-accepted', 'accepted', old],
        ['retention-unknown', 'unknown', old],
        ['retention-recent', 'delivered', new Date().toISOString()],
      ]) {
        const retained = { ...receipt, requestId, commandId: `command-${requestId}`, operation: 'connectSession', turnId: null, status, createdAt };
        db.prepare("INSERT INTO records VALUES('operation',?,?)").run(requestId, JSON.stringify(retained));
      }
    } finally { db.close(); }
    invoke(env.state, 'daemon', 'start'); started = true; op = await operator(env);
    let detail = await op.request('getSession', { sessionId: created.sessionId });
    assert.ok(!detail.operations.some(r => r.requestId === input.requestId), 'Expired settled receipt is removed at startup');
    for (const requestId of ['retention-accepted', 'retention-unknown']) {
      assert.equal(detail.operations.find(r => r.requestId === requestId)?.status, 'unknown', 'Uncertain delivery remains durable beyond the window');
    }
    assert.ok(detail.operations.some(r => r.requestId === 'retention-recent'));
    const replay = await Promise.all([op.request('sendMessage', input), op.request('sendMessage', input)]);
    assert.equal(replay[0].status, 'delivered');
    assert.notEqual(replay[0].commandId, first.commandId, 'Reusing a pruned request ID creates a new operation');
    assert.equal(replay[0].commandId, replay[1].commandId, 'Concurrent retries still claim only one new operation');
    await assert.rejects(op.request('sendMessage', { ...input, message: 'Changed within the new window' }), { code: 'REQUEST_CONFLICT' });
    await until(() => op.request('getSession', { sessionId: created.sessionId }), d => !d.session.activeTurnId, 'new retention turn completion');
    const history = await op.request('readSessionHistory', { sessionId: created.sessionId });
    assert.equal(history.messages.filter(m => m.role === 'user' && m.text === input.message).length, 2);
    invoke(env.state, 'daemon', 'stop'); started = false;
    invoke(env.state, 'daemon', 'start'); started = true; op = await operator(env);
    assert.equal((await op.request('sendMessage', input)).commandId, replay[0].commandId, 'The new retry window survives another restart');
  } finally {
    if (started) invoke(env.state, 'daemon', 'stop');
    await fs.rm(env.state, { recursive: true, force: true });
  }
});

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
    const refreshed = await operator(env);
    assert.deepEqual((await refreshed.request('getSession',{sessionId:sid})).interactions.find(i=>i.interactionId===question.interactionId).details, question.details, 'Browser refresh retains pending details');
    result = await op.request('answerQuestions', { sessionId: sid, turnId: detail.session.activeTurnId, interactionId: question.interactionId, requestId: 'answer-a', answers: [{ questionId: 'choice', answers: ['ANSWER_CANARY'] }] }); assert.equal(result.status, 'delivered', JSON.stringify(result.error));
    await until(details, d => !d.session.activeTurnId, 'question response completion');
    console.log('Rust test: native approval');
    result = await send('APPROVAL'); assert.equal(result.status, 'delivered');
    detail = await until(details, d => d.interactions.some(i => i.status === 'pending' && i.kind === 'approval'), 'native approval');
    const approval = detail.interactions.find(i => i.status === 'pending');
    result = await op.request('decideApproval', { sessionId: sid, turnId: detail.session.activeTurnId, interactionId: approval.interactionId, requestId: 'deny-a', decision: 'deny' }); assert.equal(result.status, 'delivered');
    await until(details, d => !d.session.activeTurnId, 'denied callback completion');
    const completedSend = await send('OUTPUT'); assert.equal(completedSend.status, 'delivered');
    await until(details, d => !d.session.activeTurnId, 'native output completion');
    const completedTurn = (await details()).turns.find(t=>t.turnId===completedSend.turnId);
    const activity = (await op.request('readSessionHistory', {sessionId:sid})).activities.find(a => a.type === 'commandExecution');
    assert.equal(activity.contents[0].completeness, 'unknown');
    let output='', contentCursor, firstOutputPage;
    do { const page=await op.request('readSessionContent',{sessionId:sid,contentId:activity.contents[0].contentId,limitBytes:65537,...(contentCursor?{contentCursor}:{})}); firstOutputPage ??= page.text; output+=page.text;contentCursor=page.nextCursor; } while(contentCursor);
    assert.equal(output,'中文 🚀\n'.repeat(10000)+'[truncated]', 'History uses only output retained by Codex');
    await assert.rejects(op.request('readSessionContent',{sessionId:'other-session',contentId:activity.contents[0].contentId}),{code:'NOT_FOUND'});
    const observer = new DatabaseSync(join(env.state,'daemon.sqlite'),{readOnly:true});
    const version = () => observer.prepare('PRAGMA data_version').get().data_version;
    const beforeRead = version();
    const readHistory = await op.request('readSessionHistory',{sessionId:sid});
    const diff = readHistory.activities.find(a=>a.type==='fileChange');
    assert.equal((await op.request('readSessionContent',{sessionId:sid,contentId:diff.contents[0].contentId})).text,'@@ -0,0 +1 @@\n+DIFF_CANARY\n');
    await op.request('getSessionActivity',{sessionId:sid,itemId:activity.id});
    await op.request('readSessionContent',{sessionId:sid,contentId:activity.contents[0].contentId});
    assert.equal(version(),beforeRead,'History, activity and content reads must not write management storage');
    observer.close();
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
    for (let index=0;index<16;index++) {
      const claims = await Promise.allSettled([other.sessionId,nativeChild].map(sessionId=>op.request('connectSession',{sessionId,requestId:`shared-request-${index}`})));
      assert.equal(claims.filter(r=>r.status==='fulfilled').length,1,'A request ID is claimed once across session gates');
      assert.equal(claims.find(r=>r.status==='rejected').reason.code,'REQUEST_CONFLICT');
    }
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
    const uncertain = await send('UNCERTAIN_COMPLETE');
    assert.equal(uncertain.status,'unknown','Missing native acknowledgement reports uncertain delivery');
    await until(details,d=>!d.session.activeTurnId && d.operations.find(o=>o.requestId===uncertain.requestId)?.status==='delivered','Native completion reconciles an uncertain receipt');
    console.log('Rust test: one-use ticket expiry');
    await delay(Math.max(0,61000 - (Date.now() - ticketIssuedAt)));
    assert.equal((await fetch(`${env.origin}/auth/login`,{method:'POST',headers:{Origin:env.origin,'Content-Type':'application/json'},body:JSON.stringify({ticket:expiringTicket})})).status,401);
    console.log('Rust test: stop and restart');
    const configSnapshot = (await details()).session.sessionConfig;
    invoke(env.state, 'daemon', 'stop'); started = false;
    const journal = new DatabaseSync(join(env.state, 'daemon.sqlite'), { readOnly: true });
    const rows = journal.prepare('SELECT kind,data FROM records').all();
    const records = rows.map(r=>r.data).join('\n');
    assert.deepEqual(journal.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name),['records']);
    assert.ok(rows.every(r=>['session','operation','meta'].includes(r.kind)), 'Confirmed turns and interactions have no durable history');
    assert.ok(rows.filter(r=>r.kind==='session').every(r=>!Object.hasOwn(JSON.parse(r.data),'native') && !Object.hasOwn(JSON.parse(r.data),'runtimeState')));
    journal.close();
    assert.ok(!records.includes('USER_CANARY') && !records.includes('ANSWER_CANARY') && !records.includes('DIFF_CANARY') && !records.includes('synthetic Unicode output') && !records.includes('Pick one'), 'Journal contains no native content or interaction details');
    await assert.rejects(fs.access(join(env.state,'content.sqlite')),{code:'ENOENT'});
    // Simulate native completion committed before Dewbow saved its receipt/active-turn cleanup.
    const recoveryJournal = new DatabaseSync(join(env.state,'daemon.sqlite'));
    const pendingSession = JSON.parse(rows.find(r=>r.kind==='session' && JSON.parse(r.data).sessionId===sid).data);
    pendingSession.activeTurnId = completedSend.turnId;
    const pendingReceipt = JSON.parse(rows.find(r=>r.kind==='operation' && JSON.parse(r.data).requestId===completedSend.requestId).data);
    pendingReceipt.status = 'accepted';
    const recoveryRecord = recoveryJournal.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)');
    recoveryRecord.run('session',sid,JSON.stringify(pendingSession));
    recoveryRecord.run('operation',completedSend.requestId,JSON.stringify(pendingReceipt));
    recoveryRecord.run('turn',completedSend.turnId,JSON.stringify({turnId:completedTurn.turnId,sessionId:sid,requestId:completedSend.requestId,codexTurnId:completedTurn.codexTurnId,mode:completedTurn.mode,createdAt:completedTurn.createdAt}));
    recoveryJournal.close();
    invoke(env.state, 'daemon', 'start'); started = true;
    const again = await operator(env); const recovered = await again.request('getSession', { sessionId: sid });
    assert.equal(recovered.session.codexThreadId, thread); assert.equal(recovered.session.connectionState, 'connected');
    assert.deepEqual(recovered.session.sessionConfig,configSnapshot,'Frozen creation configuration survives restart');
    assert.equal(recovered.session.activeTurnId,null,'A saved native completion clears the unresolved turn');
    assert.equal(recovered.operations.find(o=>o.requestId===completedSend.requestId).status,'delivered','Recovery confirms the original send receipt');
    assert.equal((await again.request('sendMessage',{sessionId:sid,message:'OUTPUT',requestId:completedSend.requestId})).commandId,completedSend.commandId);
    assert.equal((await again.request('createSession',input)).sessionId,sid,'Deduplication survives restart');
    await assert.rejects(again.request('createSession',{...input,workDir:env.home}),{code:'REQUEST_CONFLICT'});
    assert.equal((await again.request('readSessionContent',{sessionId:sid,contentId:activity.contents[0].contentId,limitBytes:65537})).text,firstOutputPage, 'Stateless content references survive restart');
    assert.equal((await again.request('sendMessage', { sessionId: sid, message: 'WAIT', requestId: 'uncertain-turn' })).status, 'delivered');
    await again.request('sendMessage',{sessionId:other.sessionId,message:'QUESTIONS',requestId:'pending-question'});
    const pending = await until(()=>again.request('getSession',{sessionId:other.sessionId}),d=>d.interactions.some(i=>i.status==='pending'),'pending callback before restart');
    const oldQuestion = pending.interactions.find(i=>i.status==='pending');
    invoke(env.state, 'daemon', 'stop'); started = false;
    // Simulate exit before the native acknowledgement and turn ID were recorded.
    const uncertainJournal = new DatabaseSync(join(env.state,'daemon.sqlite'));
    const rawReceipt = JSON.parse(uncertainJournal.prepare("SELECT data FROM records WHERE kind='operation' AND id='uncertain-turn'").get().data);
    rawReceipt.status = 'accepted';
    uncertainJournal.prepare("UPDATE records SET data=? WHERE kind='operation' AND id='uncertain-turn'").run(JSON.stringify(rawReceipt));
    uncertainJournal.prepare("UPDATE records SET data=json_remove(data,'$.codexTurnId') WHERE kind='turn' AND id=?").run(rawReceipt.turnId);
    uncertainJournal.close();
    invoke(env.state, 'daemon', 'start'); started = true;
    const final = await operator(env); const unresolved = await final.request('getSession', { sessionId: sid });
    assert.equal(unresolved.session.runtimeState, 'unknown'); assert.ok(unresolved.session.activeTurnId);
    const uncertainRetry = await final.request('sendMessage',{sessionId:sid,message:'WAIT',requestId:'uncertain-turn'});
    assert.equal(uncertainRetry.status,'unknown','An unconfirmed receipt cannot be replayed as a new send');
    assert.equal(uncertainRetry.commandId,unresolved.operations.find(o=>o.requestId==='uncertain-turn').commandId);
    assert.equal((await final.request('sendMessage',{sessionId:sid,message:'new send',requestId:'blocked-after-restart'})).error.code,'SESSION_BUSY');
    assert.equal((await final.request('getSession',{sessionId:other.sessionId})).interactions.length,0);
    assert.equal((await final.request('answerQuestions',{sessionId:other.sessionId,turnId:pending.session.activeTurnId,interactionId:oldQuestion.interactionId,requestId:'stale-after-restart',answers:[{questionId:'choice',answers:['One']}]})).error.code,'STALE_INTERACTION');
    await assert.rejects(final.request('readSessionContent',{sessionId:other.sessionId,contentId:oldQuestion.content.contentId}),{code:'NOT_FOUND'});
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
