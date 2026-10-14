import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

export function validateVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('Use a SemVer version such as 0.2.0 or 0.2.0-rc.1, without a v prefix or build metadata.');
  }
  return version;
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// These readers deliberately handle only the workspace's explicit TOML tables,
// strings and member lists. Unsupported layouts fail before any file is written.
function readTable(text, name) {
  const match = new RegExp(`^\\[${escapePattern(name)}\\][^\\S\\r\\n]*(?:#[^\\r\\n]*)?\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`, 'm').exec(text);
  if (!match) throw new Error(`Missing [${name}] table.`);
  return match[1];
}

function readString(text, key) {
  const matches = [...text.matchAll(new RegExp(`^${escapePattern(key)}\\s*=\\s*"([^"\\r\\n]+)"[^\\S\\r\\n]*(?:#[^\\r\\n]*)?$`, 'gm'))];
  if (matches.length !== 1) throw new Error(`Expected one string field: ${key}.`);
  return matches[0][1];
}

function readMembers(text) {
  const table = readTable(text, 'workspace').replace(/#[^\r\n]*/g, '');
  const match = /^members\s*=\s*\[([^\]]*)\]/m.exec(table);
  if (!match || !/^[\s,]*$/.test(match[1].replace(/"[^"\r\n]+"/g, ''))) {
    throw new Error('Cargo workspace members must be an explicit list of quoted paths.');
  }
  return [...match[1].matchAll(/"([^"\r\n]+)"/g)].map(item => item[1]);
}

function replaceJsonString(text, key, previous, next) {
  const pattern = new RegExp(`("${escapePattern(key)}"\\s*:\\s*)${escapePattern(JSON.stringify(previous))}`, 'g');
  return text.replace(pattern, (_, prefix) => `${prefix}${JSON.stringify(next)}`);
}

export function synchronizeVersions(root, { version: requestedVersion, check = false, tag } = {}) {
  if (requestedVersion !== undefined) validateVersion(requestedVersion);
  if (check && requestedVersion !== undefined) throw new Error('--check cannot be combined with --version.');
  if (tag !== undefined && !check) throw new Error('--tag requires --check.');

  const read = path => readFileSync(resolve(root, path), 'utf8');
  const checkPath = path => {
    const local = relative(resolve(root), resolve(root, path));
    if (!local || local.startsWith('..') || isAbsolute(local) || /[*?\\]/.test(path)) {
      throw new Error(`Expected an explicit workspace-relative path: ${path}.`);
    }
    return path;
  };
  const cargoText = read('Cargo.toml');
  const cargoVersion = validateVersion(readString(readTable(cargoText, 'workspace.package'), 'version'));
  const version = requestedVersion ?? cargoVersion;
  if (tag !== undefined && tag !== version) throw new Error(`Tag ${tag} does not match ${version}.`);

  const npmText = read('package.json');
  const npmRoot = JSON.parse(npmText);
  if (!Array.isArray(npmRoot.workspaces) || npmRoot.workspaces.length === 0) {
    throw new Error('npm workspaces must be an explicit, nonempty array of paths.');
  }
  const packages = [{ path: '', text: npmText, data: npmRoot }, ...npmRoot.workspaces.map(path => {
    checkPath(path);
    const text = read(`${path}/package.json`);
    return { path, text, data: JSON.parse(text) };
  })];
  const packageNames = new Set(packages.map(pkg => pkg.data.name));
  if (packageNames.size !== packages.length || packages.some(pkg => typeof pkg.data.name !== 'string' || typeof pkg.data.version !== 'string')) {
    throw new Error('Every npm workspace must have a unique name and a version.');
  }

  const crateNames = readMembers(cargoText).map(path => {
    checkPath(path);
    const table = readTable(read(`${path}/Cargo.toml`), 'package');
    if (!/^version\.workspace\s*=\s*true\s*(?:#[^\r\n]*)?$/m.test(table) || /^version\s*=/m.test(table)) {
      throw new Error(`${path}/Cargo.toml must inherit version.workspace = true.`);
    }
    return readString(table, 'name');
  });
  if (crateNames.length === 0 || new Set(crateNames).size !== crateNames.length) {
    throw new Error('Cargo workspace members must have unique package names.');
  }

  const changes = new Map();
  const plan = (path, previous, next) => {
    if (previous !== next) changes.set(path, next);
  };
  const nextCargo = cargoText.replace(/(^\[workspace\.package\][\s\S]*?^version\s*=\s*)"[^"\r\n]+"/m, (_, prefix) => `${prefix}"${version}"`);
  plan('Cargo.toml', cargoText, nextCargo);
  for (const pkg of packages) {
    let next = replaceJsonString(pkg.text, 'version', pkg.data.version, version);
    for (const field of dependencyFields) {
      for (const [name, value] of Object.entries(pkg.data[field] ?? {})) {
        if (packageNames.has(name)) next = replaceJsonString(next, name, value, version);
      }
    }
    plan(pkg.path ? `${pkg.path}/package.json` : 'package.json', pkg.text, next);
  }

  const lockText = read('package-lock.json');
  const lock = JSON.parse(lockText);
  if (lock.lockfileVersion !== 3 || lock.name !== npmRoot.name || !lock.packages) {
    throw new Error('Expected the root npm v3 workspace lockfile.');
  }
  lock.version = version;
  for (const pkg of packages) {
    const entry = lock.packages[pkg.path];
    if (!entry || entry.name !== pkg.data.name) throw new Error(`Missing or mismatched npm lockfile entry: ${pkg.path || '(root)'}.`);
    entry.version = version;
    for (const field of dependencyFields) {
      // The lockfile must agree with the manifest, including missing/stale pins.
      const names = new Set([...Object.keys(pkg.data[field] ?? {}), ...Object.keys(entry[field] ?? {})]);
      for (const name of names) {
        if (!packageNames.has(name)) continue;
        if (pkg.data[field]?.[name] !== undefined) {
          entry[field] ??= {};
          entry[field][name] = version;
        } else {
          delete entry[field][name];
        }
      }
    }
  }
  const newline = lockText.includes('\r\n') ? '\r\n' : '\n';
  plan('package-lock.json', lockText, `${JSON.stringify(lock, null, 2)}\n`.replace(/\n/g, newline));

  const cargoLockText = read('Cargo.lock');
  const foundCrates = new Set();
  const nextCargoLock = cargoLockText.split(/(?=^\[\[package\]\])/m).map(block => {
    if (!block.startsWith('[[package]]')) return block;
    const name = readString(block, 'name');
    if (!crateNames.includes(name) || /^source\s*=/m.test(block)) return block;
    if (foundCrates.has(name)) throw new Error(`Duplicate local Cargo lockfile package: ${name}.`);
    foundCrates.add(name);
    readString(block, 'version');
    return block.replace(/(^version\s*=\s*)"[^"\r\n]+"/m, (_, prefix) => `${prefix}"${version}"`);
  }).join('');
  for (const name of crateNames) {
    if (!foundCrates.has(name)) throw new Error(`Missing local Cargo lockfile package: ${name}.`);
  }
  plan('Cargo.lock', cargoLockText, nextCargoLock);

  const changedFiles = [...changes.keys()];
  if (check && changedFiles.length > 0) {
    throw new Error(`Version ${version} is out of sync in: ${changedFiles.join(', ')}. Run npm run version:sync.`);
  }
  // Finish all parsing and structural checks before writing any file.
  if (!check) for (const [path, text] of changes) writeFileSync(resolve(root, path), text);
  return { version, changedFiles };
}

function main() {
  const options = {};
  let print = false;
  const args = process.argv.slice(2);
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--check') options.check = true;
    else if (arg === '--print') { print = true; options.check = true; }
    else if (arg === '--version' || arg === '--tag') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[arg === '--version' ? 'version' : 'tag'] = value;
    } else throw new Error(`Unknown argument: ${arg}.`);
  }
  const result = synchronizeVersions(process.cwd(), options);
  console.log(print ? result.version : `${options.check ? 'Checked' : 'Synchronized'} ${result.version}; ${result.changedFiles.length} files changed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
