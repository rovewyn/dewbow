import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPrivateFile, ensurePrivateDirectory } from "../dist/files.js";

const windowsOnly = { skip: process.platform !== "win32" };

function fixture(t) {
  const parent = realpathSync.native(tmpdir());
  const root = mkdtempSync(join(parent, "dewbow-acl-"));
  t.after(() => {
    assert.equal(dirname(root), parent);
    rmSync(root, { recursive: true, force: true });
  });
  return join(root, "private");
}

test("private files preserve existing contents and reject shared state roots", t => {
  const directory = fixture(t), path = join(directory, "credential.txt");
  assert.equal(createPrivateFile(path, "synthetic-original"), true);
  assert.equal(createPrivateFile(path, "synthetic-replacement"), false);
  assert.equal(readFileSync(path, "utf8"), "synthetic-original");
  const guard = `import assert from 'node:assert/strict'; import {ensurePrivateDirectory} from ${JSON.stringify(new URL("../dist/files.js", import.meta.url).href)}; assert.throws(() => ensurePrivateDirectory(process.platform === 'win32' ? process.cwd().toUpperCase() : process.cwd()), /dedicated directory/);`;
  childProcess.execFileSync(process.execPath, ["--input-type=module", "-e", guard], { cwd: directory, windowsHide: true });
  if (process.platform === "win32") {
    const check = "$ErrorActionPreference='Stop'; $acl=[IO.FileInfo]::new($env:DEWBOW_ACL_TEST_FILE).GetAccessControl(); $user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if(-not $acl.AreAccessRulesProtected) { exit 1 }; $seen=@(); foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin @($user,'S-1-5-18') -or $rule.IsInherited -or $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { exit 2 }; $seen+=$rule.IdentityReference.Value }; if($user -notin $seen -or 'S-1-5-18' -notin $seen) { exit 3 }";
    childProcess.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(check,"utf16le").toString("base64")], { windowsHide: true, env: { ...process.env, DEWBOW_ACL_TEST_FILE: path } });
  }
});

test("Windows ACL protection completes after a slow helper start", windowsOnly, t => {
  const directory = fixture(t);
  const runProcess = childProcess.execFileSync;
  let delayed = false;
  const runAcl = t.mock.method(childProcess, "execFileSync", (command, args, options) => {
    if (command === "powershell.exe" && !delayed) {
      delayed = true;
      const encodedIndex = args.indexOf("-EncodedCommand") + 1;
      assert.ok(encodedIndex > 0);
      const script = Buffer.from(args[encodedIndex], "base64").toString("utf16le");
      args = [...args];
      // Exceed the former 15-second deadline, then execute the real ACL checks.
      args[encodedIndex] = Buffer.from(`Start-Sleep -Milliseconds 16500\n${script}`, "utf16le").toString("base64");
    }
    return runProcess(command, args, options);
  });
  syncBuiltinESMExports();
  try {
    const path = join(directory, "credential.txt");
    assert.equal(createPrivateFile(path, "synthetic-protected-content"), true);
    assert.equal(readFileSync(path, "utf8"), "synthetic-protected-content");
    assert.equal(delayed, true);
  } finally {
    runAcl.mock.restore();
    syncBuiltinESMExports();
  }
});

test("Windows ACL helper failures block private writes without retrying or exposing diagnostics", windowsOnly, t => {
  const directory = fixture(t);
  ensurePrivateDirectory(directory);
  const failures = [
    [{ status: 11 }, /reparse point/],
    [{ status: 12 }, /belong to the current account/],
    [{ code: "ETIMEDOUT", status: null }, /timed out/],
    [{ code: "ENOENT", status: null }, /PowerShell.*not found/],
    [{ status: 1 }, /exit status 1/],
  ];
  for (const [index, [details, message]] of failures.entries()) {
    const failure = Object.assign(new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC"), details, {
      stderr: Buffer.from("SYNTHETIC_PRIVATE_DIAGNOSTIC"),
    });
    const runAcl = t.mock.method(childProcess, "execFileSync", () => { throw failure; });
    syncBuiltinESMExports();
    try {
      const path = join(directory, `rejected-${index}.txt`);
      assert.throws(() => createPrivateFile(path, "synthetic-must-not-be-written"), error => {
        assert.match(error.message, message);
        assert.ok(!error.message.includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"));
        return true;
      });
      assert.equal(runAcl.mock.callCount(), 1);
      assert.equal(existsSync(path), true);
      assert.equal(readFileSync(path, "utf8"), "");
    } finally {
      runAcl.mock.restore();
      syncBuiltinESMExports();
    }
  }
});
