import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const cargo = process.env.CARGO ?? 'cargo';
const testArgs = process.argv.slice(2);
function run(file, args, options = {}) {
  const child = spawn(file, args, { stdio: 'inherit', windowsHide: true, ...options });
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Rust test command failed (${signal ?? code})`));
    });
  });
  // Compilation output is consumed before its exit is awaited; observe an early
  // spawn/exit failure now and rethrow it at the awaited completion below.
  finished.catch(() => {});
  return { child, finished };
}

if (process.platform !== 'win32') {
  await run(cargo, ['test', '--locked', '--workspace', '--all-targets', ...(testArgs.length ? ['--', ...testArgs] : [])]).finished;
} else {
  // Cargo's Windows kill-on-close job forbids breakaway. Compile with Cargo,
  // then run every test artifact from this parent so detachment is tested with
  // production behavior. No test is filtered or given a detachment bypass.
  const build = run(cargo, ['test', '--locked', '--workspace', '--all-targets', '--no-run', '--message-format=json'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const executables = new Set();
  for await (const line of createInterface({ input: build.child.stdout })) {
    const message = JSON.parse(line);
    if (message.reason === 'compiler-artifact' && message.profile.test && message.executable) {
      executables.add(message.executable);
    }
    if (message.reason === 'compiler-message' && message.message.rendered) {
      process.stderr.write(message.message.rendered);
    }
  }
  await build.finished;
  if (!executables.size) throw new Error('Cargo produced no Rust test executables');
  for (const executable of executables) await run(executable, testArgs).finished;
}
