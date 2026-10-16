import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { connect, createServer } from 'node:net';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { packageRelease } from './package-release.mjs';
import { synchronizeVersions } from './sync-version.mjs';
import { apiRequest } from '../apps/web/src/apiRoutes.ts';

// This is a compatible current-format fixture, never a published source release.
// Keep an immutable predecessor implementation across candidate changes. Update
// this pin deliberately when release preparation selects a supported source.
const baselineSource = '2be0d8f4a4efbb6f0954b5cbda892baad8615d33';
const baselineVersion = '0.0.0-upgrade-acceptance.0';
const repo = process.cwd();
const windows = process.platform === 'win32';
const executable = windows ? 'dewbow.exe' : 'dewbow';
const target = windows ? 'x86_64-pc-windows-msvc' : process.platform === 'linux' ? 'x86_64-unknown-linux-gnu' :
  process.platform === 'darwin' && process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
assert.ok((windows && process.arch === 'x64') || (process.platform === 'linux' && process.arch === 'x64') ||
  (process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch)), 'Unsupported acceptance platform');
assert.ok(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--release'), 'Usage: upgrade-acceptance.mjs [--release]');
const release = process.argv[2] === '--release';
const candidate = resolve(release ? `target/${target}/release/${executable}` : `target/debug/${executable}`);
const fixture = resolve(`target/debug/examples/fixture${windows ? '.exe' : ''}`);
const tar = windows ? join(process.env.SystemRoot, 'System32/tar.exe') : 'tar';
const cargo = process.env.CARGO ?? 'cargo';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = async path => createHash('sha256').update(await fs.readFile(path)).digest('hex');
const readJson = async path => JSON.parse(await fs.readFile(path, 'utf8'));
const exists = path => fs.access(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

function start(file, args, options = {}) {
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout?.on('data', bytes => { stdout = (stdout + bytes).slice(-65536); });
  child.stderr?.on('data', bytes => { stderr = (stderr + bytes).slice(-65536); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 180000);
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  }).finally(() => clearTimeout(timeout));
  finished.catch(() => {});
  return { child, finished };
}
async function run(file, args, options) {
  const result = await start(file, args, options).finished;
  assert.equal(result.code, 0, `${file.split(/[\\/]/).at(-1)} failed: ${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}
async function until(read, predicate, description, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

await fs.access(candidate);
await fs.access(fixture);
const version = synchronizeVersions(repo, { check: true }).version;
assert.notEqual(version, baselineVersion);
assert.equal(await run(candidate, ['--version']), `dewbow ${version}`, 'Build the current candidate before acceptance');
const parent = resolve('outputs');
await fs.mkdir(parent, { recursive: true });
const root = await fs.mkdtemp(join(parent, 'upgrade-acceptance-'));
await fs.writeFile(join(root, 'synthetic.fixture'), 'synthetic upgrade acceptance');
const source = join(root, 'source');
const baseline = join(root, executable);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
let passed = false;
try {
  console.log('Upgrade acceptance: building a distinct synthetic baseline executable');
  await fs.mkdir(source);
  execFileSync('git', ['merge-base', '--is-ancestor', baselineSource, 'HEAD']);
  const tracked = execFileSync('git', ['archive', '--format=tar', baselineSource], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync(tar, ['-xf', '-', '-C', source], { input: tracked, windowsHide: true });
  await fs.cp(resolve('apps/web/dist'), join(source, 'apps/web/dist'), { recursive: true });
  synchronizeVersions(source, { version: baselineVersion });
  // Separate build outputs cannot overwrite the caller's binaries or running tests.
  await run(cargo, ['build', '--locked', '--manifest-path', join(source, 'Cargo.toml'), '--bin', 'dewbow', '--target-dir', join(root, 'build')],
    { timeout: 900000, stdio: ['ignore', 'pipe', 'inherit'] });
  await fs.copyFile(join(root, 'build/debug', executable), baseline);
  await fs.chmod(baseline, 0o755);
  assert.equal(await run(baseline, ['--version']), `dewbow ${baselineVersion}`);
  assert.equal(await run(candidate, ['--version']), `dewbow ${version}`);
  assert.notEqual(await hash(baseline), await hash(candidate));

  // Use the real packager, version checks, manifest and platform archive tools.
  // A compatible synthetic predecessor makes rollback safe for this fixture.
  // This does not change the separately reviewed policy of a published release.
  synchronizeVersions(source, { version });
  const packageBinary = join(source, 'target', target, 'release', executable);
  await fs.mkdir(dirname(packageBinary), { recursive: true });
  await fs.copyFile(candidate, packageBinary);
  const packaged = packageRelease(source, { target, sourceCommit });
  const candidateHash = await hash(candidate);
  const packageStage = join(root, 'package');
  await fs.mkdir(packageStage);
  execFileSync(tar, ['-xf', packaged.archive, '-C', packageStage], { windowsHide: true });
  const manifestPath = join(packageStage, packaged.name, 'release.json');
  const manifest = await readJson(manifestPath);
  assert.equal(manifest.binarySha256, candidateHash);
  async function syntheticArchive(rollbackSafe) {
    // Both declarations belong only to this current-format fixture. In particular,
    // a real release requiring manual transition must keep its original policy.
    await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, upgrade: { ...manifest.upgrade, rollbackSafe } }));
    const destination = join(root, rollbackSafe ? 'compatible' : 'manual');
    await fs.mkdir(destination);
    const archive = join(destination, packaged.archive.split(/[\\/]/).at(-1));
    execFileSync(tar, [windows ? '-acf' : '-czf', archive, '-C', packageStage, packaged.name], { windowsHide: true });
    await fs.writeFile(`${archive}.sha256`, `${await hash(archive)}  ${archive.split(/[\\/]/).at(-1)}\n`);
    return archive;
  }
  const archive = await syntheticArchive(true), manualArchive = await syntheticArchive(false);

  async function prepare(name) {
    const directory = join(root, name);
    const installed = join(directory, 'bin space', executable);
    const state = join(directory, 'state');
    const home = join(directory, 'native');
    const work = join(directory, 'work');
    await fs.mkdir(dirname(installed), { recursive: true });
    await fs.mkdir(home); await fs.mkdir(work);
    await fs.writeFile(join(home, 'synthetic.fixture'), 'synthetic');
    await fs.writeFile(join(home, 'credentials-canary'), 'synthetic credential preservation');
    await fs.copyFile(baseline, installed); await fs.chmod(installed, 0o755);
    const cli = (...args) => run(installed, ['--state-dir', state, ...args]);
    await cli('init', '--codex-executable', fixture, '--codex-home', home, '--port', String(await freePort()));
    const config = await readJson(join(state, 'config.json'));
    const origin = `http://127.0.0.1:${config.port}`;
    const control = async (name, input) => {
      const response = await fetch(`${origin}/internal/${name}`, { method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { Connection: 'close', Authorization: `Bearer ${config.controlToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input ?? {}) });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      return data.result;
    };
    const operator = async () => {
      const { ticket } = await control('ticket');
      const login = await fetch(`${origin}/auth/login`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      // Only the immutable synthetic predecessor uses the removed RPC transport.
      const legacy = (await control('status')).version === baselineVersion;
      return async (name, input) => {
        const route = legacy ? { path: `/api/${name}`, method: 'POST', input } : apiRequest(name, input);
        const response = await fetch(`${origin}${route.path}`, { method: route.method, signal: AbortSignal.timeout(10000),
          headers: { Connection: 'close', Origin: origin, Cookie: cookie, ...(route.input ? { 'Content-Type': 'application/json' } : {}) }, ...(route.input ? { body: JSON.stringify(route.input) } : {}) });
        const data = await response.json();
        if (data.error) throw new Error(data.error.message);
        return data.result;
      };
    };
    const first = JSON.parse(await cli('daemon', 'start'));
    const request = { hostId: config.hostId, workDir: work, requestId: `create-${name}` };
    const op = await operator();
    const created = await op('createSession', request);
    assert.equal(created.status, 'delivered');
    const frozen = (await op('getSession', { sessionId: created.sessionId })).session.sessionConfig;
    const job = join(dirname(installed), '.dewbow-updater/active');
    const upgradeArgs = ['--state-dir', state, 'upgrade', '--version', version, '--archive', archive, '--timeout-seconds', '30'];
    const status = async () => JSON.parse(await cli('upgrade', '--status'));
    const done = () => until(status, value => value.status !== 'pending', 'durable terminal outcome');
    const preserved = async expected => {
      const serving = await control('status');
      assert.equal(serving.version, expected); assert.equal(serving.maintenance, false);
      assert.equal((await readJson(join(state, 'config.json'))).hostId, config.hostId);
      assert.equal(await fs.readFile(join(home, 'credentials-canary'), 'utf8'), 'synthetic credential preservation');
      const op = await operator();
      assert.equal((await op('createSession', request)).sessionId, created.sessionId, 'Duplicate request retains its original target');
      const detail = await op('getSession', { sessionId: created.sessionId });
      assert.deepEqual(detail.session.sessionConfig, frozen);
      const native = new DatabaseSync(join(home, 'state_1.sqlite'), { readOnly: true });
      try { assert.equal(native.prepare('SELECT count(*) AS count FROM threads').get().count, 1, 'Duplicate request must not create native work'); }
      finally { native.close(); }
      return { op, serving };
    };
    const cleanup = async () => {
      await fs.rm(join(home, 'upgrade-models-blocked'), { force: true });
      // Let a running owned job settle before stopping its daemon. Failed fixtures
      // are retained privately; runner cleanup still owns any abnormal descendants.
      if (await exists(join(job, 'request.json'))) {
        await done();
        await until(async () => {
          for (const role of ['supervisor', 'worker']) {
            const record = join(job, `${role}.json`);
            if (await exists(record) && alive((await readJson(record)).pid)) return false;
          }
          return true;
        }, Boolean, 'synthetic controller exit', 15000);
      }
      await cli('daemon', 'stop');
      const listener = connect(config.port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        listener.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
        listener.once('connect', () => { listener.destroy(); reject(new Error('Synthetic listener remains open')); });
      });
    };
    return { installed, state, home, job, cli, control, first, upgradeArgs, status, done, preserved, cleanup };
  }
  async function scenario(name, action) {
    console.log(`Upgrade acceptance: ${name}`);
    let env;
    try { env = await prepare(name); }
    catch (error) {
      const state = join(root, name, 'state');
      if (await exists(join(state, 'config.json'))) {
        try { await run(join(root, name, 'bin space', executable), ['--state-dir', state, 'daemon', 'stop']); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fixture setup and cleanup failed'); }
      }
      throw error;
    }
    let failure;
    try { await action(env); } catch (error) { failure = error; }
    try { await env.cleanup(); }
    catch (error) { if (failure) throw new AggregateError([failure, error], 'Acceptance and cleanup failed'); throw error; }
    if (failure) throw failure;
    console.log(`Upgrade acceptance passed: ${name}`);
  }
  async function gate(env) {
    await until(async () => (await exists(join(env.home, 'upgrade-models-blocked'))) &&
      (await env.status()).phase === 'validating', Boolean, 'candidate native startup gate');
    assert.equal(await hash(env.installed), candidateHash, 'Fault must occur after real replacement');
  }

  await scenario('manual-transition-policy', async env => {
    const args = [...env.upgradeArgs]; args[args.indexOf('--archive') + 1] = manualArchive;
    const result = await start(env.installed, args).finished;
    assert.equal(result.code, 1); assert.match(result.stdout + result.stderr, /manual state or rollback/);
    assert.equal((await env.status()).status, 'failed');
    assert.equal((await env.control('status')).instanceId, env.first.instanceId);
    assert.equal(await exists(join(env.job, 'intent.json')), false);
    await env.preserved(baselineVersion);
  });
  await scenario('interrupted-archive', async env => {
    const partial = join(root, 'partial-release');
    await fs.writeFile(partial, (await fs.readFile(archive)).subarray(0, 4096));
    await fs.copyFile(`${archive}.sha256`, `${partial}.sha256`);
    const args = [...env.upgradeArgs]; args[args.indexOf('--archive') + 1] = partial;
    const result = await start(env.installed, args).finished;
    assert.equal(result.code, 1); assert.match(result.stdout + result.stderr, /checksum/);
    assert.equal((await env.status()).status, 'failed');
    assert.equal((await env.control('status')).instanceId, env.first.instanceId);
    assert.equal(await exists(join(env.job, 'intent.json')), false);
    await env.preserved(baselineVersion);
  });
  await scenario('release-connection-loss', async env => {
    // Interrupt the public command's actual release connection locally. Partial
    // archive response bodies are injected into the real download function by
    // the Rust suite; neither case depends on public API availability or quota.
    const sockets = new Set(); let interrupted = 0;
    const proxy = createServer(socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let headers = Buffer.alloc(0);
      const receive = bytes => {
        headers = Buffer.concat([headers, bytes]);
        if (headers.length > 16384) { socket.destroy(); return; }
        const end = headers.indexOf('\r\n\r\n'); if (end < 0) return;
        socket.off('data', receive);
        const host = /^CONNECT ([^ ]+) HTTP\/1\.[01]/.exec(headers.toString())?.[1];
        if (host !== 'api.github.com:443') { socket.destroy(); return; }
        interrupted++;
        socket.end('HTTP/1.1 200 Connection Established\r\n\r\n');
      };
      socket.on('data', receive);
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const result = await start(env.installed, ['--state-dir', env.state, 'upgrade', '--version', version], {
        env: { ...process.env, HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`, https_proxy: `http://127.0.0.1:${proxy.address().port}`,
          ALL_PROXY: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
      }).finished;
      assert.equal(result.code, 1);
      assert.ok(interrupted > 0, `Release connection must actually reach the fault: ${result.stdout}\n${result.stderr}`);
      assert.equal((await env.status()).status, 'failed');
      assert.equal((await env.control('status')).instanceId, env.first.instanceId);
      assert.equal(await exists(join(env.job, 'intent.json')), false);
      await env.preserved(baselineVersion);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => proxy.close(resolve));
    }
  });
  await scenario('startup-failure', async env => {
    await fs.writeFile(join(env.home, 'upgrade-fail-models-once'), 'synthetic');
    const result = await start(env.installed, env.upgradeArgs).finished;
    assert.equal(result.code, 1);
    assert.equal((await env.done()).status, 'recovered');
    assert.equal(await hash(env.installed), await hash(baseline));
    await env.preserved(baselineVersion);
  });
  await scenario('worker-termination', async env => {
    await fs.writeFile(join(env.home, 'upgrade-block-models-once'), 'synthetic');
    await run(env.installed, [...env.upgradeArgs, '--detach']);
    await gate(env);
    const request = await readJson(join(env.job, 'request.json'));
    const canonical = async path => {
      const real = await fs.realpath(path);
      return windows ? toNamespacedPath(real).toLowerCase() : real;
    };
    assert.equal(await canonical(request.state), await canonical(env.state));
    const worker = await readJson(join(env.job, 'worker.json'));
    // Fault injection only: this PID comes from the freshly created private
    // synthetic job. Production recovery never kills recorded PIDs.
    process.kill(worker.pid, 'SIGKILL');
    await fs.unlink(join(env.home, 'upgrade-models-blocked'));
    assert.equal((await env.done()).status, 'recovered');
    assert.equal(await hash(env.installed), await hash(baseline));
    await env.preserved(baselineVersion);
  });
  await scenario('disconnect-and-duplicate', async env => {
    await fs.writeFile(join(env.home, 'upgrade-block-models-once'), 'synthetic');
    const foreground = start(env.installed, env.upgradeArgs);
    await gate(env);
    const pending = await env.status();
    foreground.child.kill('SIGKILL'); await foreground.finished;
    await run(env.installed, [...env.upgradeArgs, '--detach']);
    assert.equal((await env.status()).jobId, pending.jobId, 'Repeated upgrade attaches to the same job');
    await fs.unlink(join(env.home, 'upgrade-models-blocked'));
    assert.equal((await env.done()).status, 'succeeded');
    assert.equal(await run(env.installed, ['--version']), `dewbow ${version}`);
    assert.equal(await hash(env.installed), candidateHash);
    const { op, serving } = await env.preserved(version);
    assert.notEqual(serving.instanceId, env.first.instanceId);
    assert.equal((await op('createSession', { hostId: (await readJson(join(env.state, 'config.json'))).hostId,
      workDir: join(dirname(env.state), 'work'), requestId: randomUUID() })).status, 'delivered');
    // Equal-version repetition creates no additional restart or rollback.
    await until(async () => start(env.installed, env.upgradeArgs).finished, value => value.code === 0, 'equal-version retry after controller exit');
    assert.equal((await env.control('status')).instanceId, serving.instanceId);
    assert.equal((await env.status()).status, 'succeeded');
  });
  passed = true;
  console.log(`Upgrade acceptance passed on ${target}: synthetic ${baselineVersion} -> ${version}`);
} finally {
  if (passed) {
    const cleanupTarget = await fs.realpath(root), cleanupParent = await fs.realpath(parent);
    const normalize = path => windows ? path.toLowerCase() : path;
    assert.equal(normalize(dirname(cleanupTarget)), normalize(cleanupParent));
    assert.equal(await fs.readFile(join(cleanupTarget, 'synthetic.fixture'), 'utf8'), 'synthetic upgrade acceptance');
    await fs.rm(cleanupTarget, { recursive: true });
  }
  else console.error('Upgrade acceptance failed; private synthetic files retained under outputs/.');
}
