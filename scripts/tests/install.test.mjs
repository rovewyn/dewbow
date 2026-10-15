import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const windows = process.platform === 'win32';
const executable = windows ? 'dewbow.exe' : 'dewbow';
const binary = resolve('target/debug', executable);
const supported = (windows && process.arch === 'x64') || (process.platform === 'linux' && process.arch === 'x64') || (process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch));
const target = windows ? 'x86_64-pc-windows-msvc' : process.platform === 'darwin' ?
  process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin' : 'x86_64-unknown-linux-gnu';
const tar = windows ? join(process.env.SystemRoot, 'System32/tar.exe') : 'tar';
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const invoke = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 30000, ...options });

test('in-memory installer validates downloads, preserves existing files and cleans failed installs', { skip: !supported }, t => {
  assert.ok(existsSync(binary), 'Build the Dewbow executable before running installer integration tests.');
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  const parent = resolve('state');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'install-test space-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const name = `dewbow-${version}-${target}`;
  const directory = join(root, name);
  mkdirSync(directory);
  copyFileSync(binary, join(directory, executable));
  writeFileSync(join(directory, 'CLI.md'), '# Synthetic installation instructions\n');
  writeFileSync(join(directory, 'release.json'), JSON.stringify({ version, target, executable, binarySha256: hash(binary) }));
  const archiveName = `${name}.${windows ? 'zip' : 'tar.gz'}`;
  const archive = join(root, archiveName);
  invoke(tar, [windows ? '-acf' : '-czf', archive, '-C', root, name]);
  const checksum = `${archive}.sha256`;
  writeFileSync(checksum, `${hash(archive)}  ${archiveName}\n`);
  const env = { ...process.env, DEWBOW_TEST_ARCHIVE: archive, DEWBOW_TEST_CHECKSUM: checksum, DEWBOW_TEST_VERSION: version };
  let install;
  if (windows) {
    // Let Windows PowerShell initialize its own module paths instead of
    // inheriting incompatible PowerShell 7 modules through Node.
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
    const runner = join(root, 'install-fixture.ps1');
    writeFileSync(runner, `param([string]$Installer, [string]$Destination)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Off
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
function Invoke-WebRequest {
  param($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri.EndsWith('.sha256')) { Copy-Item -LiteralPath $env:DEWBOW_TEST_CHECKSUM -Destination $OutFile }
  else { Copy-Item -LiteralPath $env:DEWBOW_TEST_ARCHIVE -Destination $OutFile }
}
function Invoke-RestMethod {
  param($Uri, $TimeoutSec, $Headers)
  if ($Uri -ne 'https://api.github.com/repos/rovewyn/dewbow/releases/latest') { throw 'Unexpected release API.' }
  return @{ tag_name = $env:DEWBOW_TEST_VERSION; draft = $false; prerelease = $false }
}
$env:DEWBOW_INSTALL_DIR = $Destination
Get-Content -LiteralPath $Installer -Raw | Invoke-Expression
@{}.missingProperty | Out-Null
`);
    install = destination => invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner,
      '-Installer', resolve('scripts/install.ps1'), '-Destination', destination], { env });
  } else {
    const mockBin = join(root, 'mock-bin');
    mkdirSync(mockBin);
    // Replace only transport. Archive, hashing, executable smoke check and install
    // all run through the actual installer on the host platform.
    writeFileSync(join(mockBin, 'curl'), `#!/bin/sh
source=$DEWBOW_TEST_ARCHIVE
destination=
head=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    *.sha256) source=$DEWBOW_TEST_CHECKSUM ;;
    --output) destination=$2; shift ;;
    --head) head=true ;;
  esac
  shift
done
if [ "$head" = true ]; then printf 'https://github.com/rovewyn/dewbow/releases/tag/%s' "$DEWBOW_TEST_VERSION"; exit 0; fi
cp "$source" "$destination"
`, { mode: 0o755 });
    env.PATH = `${mockBin}:${process.env.PATH}`;
    install = destination => invoke('sh', ['-s', '--', '--install-dir', destination], { env, input: readFileSync('scripts/install.sh', 'utf8') });
  }
  const destination = join(root, 'bin space');
  assert.match(install(destination), /Installed Dewbow/);
  assert.equal(invoke(join(destination, executable), ['--version']).trim(), `dewbow ${version}`);
  assert.deepEqual(readdirSync(destination), [executable]);
  assert.throws(() => install(destination), /already exists/);
  assert.equal(hash(join(destination, executable)), hash(binary));
  writeFileSync(checksum, `${'0'.repeat(64)}  ${archiveName}\n`);
  const failed = join(root, 'failed');
  assert.throws(() => install(failed), /checksum does not match/);
  assert.deepEqual(readdirSync(failed), []);
});
