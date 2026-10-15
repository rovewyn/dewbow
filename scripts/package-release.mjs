import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { synchronizeVersions } from './sync-version.mjs';

const targets = new Set(['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'aarch64-apple-darwin', 'x86_64-apple-darwin']);
const tarExecutable = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const invoke = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });

function describeRelease(root, target) {
  if (!targets.has(target)) throw new Error(`Unsupported release target: ${target}.`);
  const { version } = synchronizeVersions(root, { check: true });
  const name = `dewbow-${version}-${target}`;
  const executable = target.includes('windows') ? 'dewbow.exe' : 'dewbow';
  const extension = target.includes('windows') ? 'zip' : 'tar.gz';
  const output = resolve(root, 'artifacts/release');
  return { version, name, executable, output, archive: join(output, `${name}.${extension}`) };
}

export function packageRelease(root, { target, sourceCommit }) {
  const release = describeRelease(root, target);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Expected a full Git commit ID.');
  const binary = resolve(root, 'target', target, 'release', release.executable);
  if (!existsSync(binary)) throw new Error(`Build the ${target} release executable before packaging.`);
  if ([release.archive, `${release.archive}.sha256`].some(existsSync)) throw new Error('Release output already exists; use a fresh output directory.');
  mkdirSync(release.output, { recursive: true });
  const stage = mkdtempSync(join(release.output, '.stage-'));
  try {
    const directory = join(stage, release.name);
    mkdirSync(directory);
    // Package only explicit distribution files, never a checkout or local state.
    copyFileSync(binary, join(directory, release.executable));
    copyFileSync(resolve(root, 'docs/cli.md'), join(directory, 'CLI.md'));
    writeFileSync(join(directory, 'release.json'), `${JSON.stringify({
      version: release.version, sourceCommit, target, executable: release.executable, binarySha256: hash(binary),
    }, null, 2)}\n`);
    if (target.includes('windows')) {
      invoke(tarExecutable, ['-acf', release.archive, '-C', stage, release.name]);
    } else {
      invoke(tarExecutable, ['-czf', release.archive, '-C', stage, release.name]);
    }
    writeFileSync(`${release.archive}.sha256`, `${hash(release.archive)}  ${release.archive.slice(release.output.length + 1)}\n`);
    return release;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

export function verifyRelease(root, { target, sourceCommit, runBinary = true }) {
  const release = describeRelease(root, target);
  const checksum = readFileSync(`${release.archive}.sha256`, 'utf8').trim();
  const archiveName = release.archive.slice(release.output.length + 1);
  if (checksum !== `${hash(release.archive)}  ${archiveName}`) throw new Error('Release archive checksum does not match.');
  const entries = invoke(tarExecutable, ['-tf', release.archive]).trim().split(/\r?\n/);
  const allowedFiles = [release.executable, 'CLI.md', 'release.json'].map(name => `${release.name}/${name}`);
  if (entries.some(entry => entry !== `${release.name}/` && !allowedFiles.includes(entry)) ||
      allowedFiles.some(entry => entries.filter(value => value === entry).length !== 1)) {
    throw new Error('Release archive contains unexpected or missing files.');
  }
  const stage = mkdtempSync(join(release.output, '.verify-'));
  try {
    invoke(tarExecutable, ['-xf', release.archive, '-C', stage]);
    const directory = join(stage, release.name);
    const binary = join(directory, release.executable);
    const metadata = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
    if (metadata.version !== release.version || metadata.target !== target || metadata.executable !== release.executable ||
        metadata.sourceCommit !== sourceCommit || metadata.binarySha256 !== hash(binary)) {
      throw new Error('Release manifest does not match the executable, version, target or source commit.');
    }
    if (runBinary) {
      if (invoke(binary, ['--version']).trim() !== `dewbow ${release.version}`) throw new Error('Packaged executable reports the wrong version.');
      invoke(binary, ['--help']);
    }
    return release;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const check = args[0] === '--check';
  if (check) args.shift();
  if (args.length !== 2 || args[0] !== '--target') throw new Error('Usage: package-release.mjs [--check] --target <target-triple>');
  const root = process.cwd();
  const sourceCommit = invoke('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).trim();
  const options = { target: args[1], sourceCommit };
  const release = check ? verifyRelease(root, options) : packageRelease(root, options);
  console.log(`${check ? 'Verified' : 'Packaged'} ${release.name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
