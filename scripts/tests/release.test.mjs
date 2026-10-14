import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { synchronizeVersions } from '../sync-version.mjs';
import { packageRelease, verifyRelease } from '../package-release.mjs';

function fixture(t) {
  const parent = resolve('state');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'release-test space-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  const packages = {
    '': { name: '@dewbow/workspace', version: '0.1.0', private: true, workspaces: ['packages/shared', 'apps/client'] },
    'packages/shared': { name: '@dewbow/shared', version: '0.1.0', private: true },
    'apps/client': { name: '@dewbow/client', version: '0.1.0', private: true,
      dependencies: { '@dewbow/shared': '^0.1.0', external: '0.1.0' },
      devDependencies: { '@dewbow/shared': '0.1.0' }, peerDependencies: { '@dewbow/shared': '~0.1.0' },
      optionalDependencies: { '@dewbow/shared': '0.1.0' } },
  };
  write('Cargo.toml', '[workspace]\nmembers = [\n "apps/cli",\n "packages/shared/rust",\n]\n\n[workspace.package]\nversion = "0.1.0" # Product version\n');
  write('apps/cli/Cargo.toml', '[package]\nname = "dewbow-cli"\nversion.workspace = true\n');
  write('packages/shared/rust/Cargo.toml', '[package]\nname = "dewbow-shared"\nversion.workspace = true\n');
  write('Cargo.lock', '# Synthetic lockfile\nversion = 4\n\n[[package]]\nname = "dewbow-cli"\nversion = "0.1.0"\ndependencies = ["dewbow-shared"]\n\n[[package]]\nname = "dewbow-shared"\nversion = "0.1.0"\n\n[[package]]\nname = "external"\nversion = "0.1.0"\nsource = "registry+https://example.invalid/index"\n');
  for (const [path, pkg] of Object.entries(packages)) write(path ? `${path}/package.json` : 'package.json', pkg);
  write('package-lock.json', { name: '@dewbow/workspace', version: '0.1.0', lockfileVersion: 3, packages: {
    ...packages, 'node_modules/external': { version: '0.1.0', resolved: 'https://example.invalid/external.tgz', integrity: 'synthetic' },
  } });
  write('docs/cli.md', '# Synthetic CLI instructions\n');
  return { root, write, read: path => readFileSync(join(root, path), 'utf8') };
}

test('synchronizes a prerelease across manifests, internal dependency pins and both lockfiles', t => {
  const { root, read, write } = fixture(t);
  const lock = JSON.parse(read('package-lock.json'));
  delete lock.packages['apps/client'].dependencies['@dewbow/shared'];
  write('package-lock.json', lock);
  const result = synchronizeVersions(root, { version: '0.2.0-rc.1' });
  assert.ok(result.changedFiles.includes('Cargo.lock'));
  assert.match(read('Cargo.toml'), /version = "0.2.0-rc.1" # Product version/);
  const client = JSON.parse(read('apps/client/package.json'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(client[field]['@dewbow/shared'], '0.2.0-rc.1');
    assert.equal(JSON.parse(read('package-lock.json')).packages['apps/client'][field]['@dewbow/shared'], '0.2.0-rc.1');
  }
  assert.equal(client.dependencies.external, '0.1.0');
  assert.equal(JSON.parse(read('package-lock.json')).packages['node_modules/external'].version, '0.1.0');
  assert.match(read('Cargo.lock'), /name = "external"\nversion = "0.1.0"/);
  assert.deepEqual(synchronizeVersions(root, { check: true, tag: '0.2.0-rc.1' }).changedFiles, []);
  assert.deepEqual(synchronizeVersions(root).changedFiles, []);
});

test('checks version drift and tag mismatches without writing files', t => {
  const { root, read, write } = fixture(t);
  synchronizeVersions(root);
  assert.deepEqual(synchronizeVersions(root, { check: true, tag: '0.1.0' }).changedFiles, []);
  assert.throws(() => synchronizeVersions(root, { check: true, tag: 'v0.1.0' }), /does not match/);
  write('apps/client/package.json', { ...JSON.parse(read('apps/client/package.json')), version: '0.9.0' });
  const before = read('apps/client/package.json');
  assert.throws(() => synchronizeVersions(root, { check: true }), /out of sync/);
  assert.equal(read('apps/client/package.json'), before);
  assert.throws(() => synchronizeVersions(root, { check: true, tag: '0.9.0' }), /does not match/);
});

test('invalid versions and malformed lockfiles fail before changing manifests', t => {
  const { root, read, write } = fixture(t);
  const before = read('Cargo.toml');
  for (const version of ['v0.2.0', '01.2.3', '0.2.0-rc.01', '0.2.0+build', '0.2', '../release']) {
    assert.throws(() => synchronizeVersions(root, { version }), /SemVer/);
  }
  const lock = JSON.parse(read('package-lock.json'));
  delete lock.packages['packages/shared'];
  write('package-lock.json', lock);
  assert.throws(() => synchronizeVersions(root, { version: '0.2.0' }), /lockfile entry/);
  assert.equal(read('Cargo.toml'), before);
  assert.equal(JSON.parse(read('package.json')).version, '0.1.0');
});

test('release archives contain only distribution files and detect checksum corruption', t => {
  const { root, write } = fixture(t);
  if (process.platform === 'win32') {
    const originalPath = process.env.PATH;
    write('shadow-bin/tar.exe', 'A PATH tar must not handle Windows distribution paths.');
    process.env.PATH = `${join(root, 'shadow-bin')};${originalPath ?? ''}`;
    t.after(() => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
  }
  synchronizeVersions(root);
  const target = process.platform === 'win32' ? 'x86_64-pc-windows-msvc' :
    process.platform === 'darwin' ? 'aarch64-apple-darwin' : 'x86_64-unknown-linux-gnu';
  const executable = process.platform === 'win32' ? 'dewbow.exe' : 'dewbow';
  write(`target/${target}/release/${executable}`, 'Synthetic executable bytes');
  write('state/private.json', 'Synthetic private data that must not be packaged');
  const sourceCommit = 'a'.repeat(40);
  const release = packageRelease(root, { target, sourceCommit });
  assert.deepEqual(readdirSync(release.output).sort(), [release.archive.split(/[\\/]/).at(-1), `${release.archive.split(/[\\/]/).at(-1)}.sha256`].sort());
  const tarExecutable = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const entries = execFileSync(tarExecutable, ['-tf', release.archive], { encoding: 'utf8', windowsHide: true });
  assert.ok(!entries.includes('private.json'));
  verifyRelease(root, { target, sourceCommit, runBinary: false });
  assert.throws(() => verifyRelease(root, { target, sourceCommit: 'b'.repeat(40), runBinary: false }), /manifest/);
  assert.throws(() => packageRelease(root, { target, sourceCommit }), /already exists/);
  writeFileSync(release.archive, 'corrupted synthetic archive');
  assert.throws(() => verifyRelease(root, { target, sourceCommit, runBinary: false }), /checksum/);
});
