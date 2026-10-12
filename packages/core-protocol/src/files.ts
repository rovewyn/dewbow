import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";

const securedDirectories = new Set<string>();
const aclScript = `
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
foreach ($path in (ConvertFrom-Json $env:DEWBOW_PRIVATE_PATHS)) {
  $item = if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0) { [IO.DirectoryInfo]::new($path) } else { [IO.FileInfo]::new($path) }
  $ancestor = $item
  while ($null -ne $ancestor) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private state cannot traverse a reparse point.' }
    $ancestor = if ($ancestor -is [IO.DirectoryInfo]) { $ancestor.Parent } else { $ancestor.Directory }
  }
  $existing = $item.GetAccessControl()
  if ($existing.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Private state must belong to the current account.' }
  $acl = if ($item -is [IO.DirectoryInfo]) { [System.Security.AccessControl.DirectorySecurity]::new() } else { [System.Security.AccessControl.FileSecurity]::new() }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($user, $system)) {
    $rule = if ($item -is [IO.DirectoryInfo]) {
      [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    } else { [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow') }
    $acl.AddAccessRule($rule)
  }
  $item.SetAccessControl($acl)
  $saved = $item.GetAccessControl()
  if (-not $saved.AreAccessRulesProtected) { throw 'Private state ACL was not protected.' }
  foreach ($rule in $saved.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($user.Value, $system.Value)) { throw 'Private state ACL contains another account.' }
  }
}
`;

function secure(paths: string[]): void {
  if (process.platform !== "win32") {
    for (const path of paths) {
      const info = lstatSync(path);
      if (info.isSymbolicLink() || info.uid !== process.getuid?.() || (!info.isFile() && !info.isDirectory())) throw new Error("Private state must be an ordinary file or directory owned by the current account.");
      chmodSync(path, info.isDirectory() ? 0o700 : 0o600);
    }
    return;
  }
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(aclScript, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 15000, stdio: "pipe", env: { ...process.env, DEWBOW_PRIVATE_PATHS: JSON.stringify(paths) },
    });
  } catch { throw new Error("Private Dewbow state ownership or ACL protection could not be established."); }
}

/** Protect only the designated Dewbow directory; never rewrite ancestor ACLs. */
export function ensurePrivateDirectory(path: string): void {
  const absolute = resolve(path);
  const identity = (value: string) => {
    try { value = realpathSync.native(value); } catch { /* A new private directory has no canonical identity yet. */ }
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  if ([resolve(process.cwd()), resolve(homedir()), parse(absolute).root].map(identity).includes(identity(absolute))) throw new Error("Use a dedicated directory for private Dewbow state.");
  // Reject links before creation as well as in the Windows ACL operation.
  for (let ancestor = absolute; ; ancestor = dirname(ancestor)) {
    try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error("Private state cannot traverse a symbolic link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(ancestor) === ancestor) break;
  }
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (!securedDirectories.has(absolute)) { secure([absolute]); securedDirectories.add(absolute); }
}

export function ensurePrivateFile(path: string): void {
  ensurePrivateDirectory(dirname(path));
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Private state must be a regular file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    closeSync(openSync(path, "wx", 0o600));
  }
  secure([resolve(path)]);
}

/** Exclusive creation preserves credentials when initializers race or are rerun. */
export function createPrivateFile(path: string, content: string): boolean {
  ensurePrivateDirectory(dirname(path));
  let handle: number;
  try { handle = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    ensurePrivateFile(path); return false;
  }
  try { secure([resolve(path)]); writeFileSync(handle, content); return true; }
  finally { closeSync(handle); }
}
