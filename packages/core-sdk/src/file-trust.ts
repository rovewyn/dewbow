import type { Stats } from "node:fs";
import koffi from "koffi";

let windowsOwner: ((path: string) => boolean) | undefined;

/** Windows has no POSIX uid; compare the file owner SID with this process's user. */
function createWindowsOwnerCheck(): (path: string) => boolean {
  const kernel = koffi.load("kernel32.dll"), security = koffi.load("advapi32.dll");
  const currentProcess = kernel.func("void * __stdcall GetCurrentProcess()");
  const closeHandle = kernel.func("int __stdcall CloseHandle(void *handle)");
  const localFree = kernel.func("void * __stdcall LocalFree(void *memory)");
  const attributes = kernel.func("uint32_t __stdcall GetFileAttributesW(str16 path)");
  const openToken = security.func("int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)");
  const tokenInformation = security.func("int __stdcall GetTokenInformation(void *token, uint32_t kind, _Out_ void *buffer, uint32_t size, _Out_ uint32_t *required)");
  const sidString = security.func("int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)");
  const namedSecurity = security.func("uint32_t __stdcall GetNamedSecurityInfoW(str16 path, uint32_t kind, uint32_t information, _Out_ void **owner, void *group, void *dacl, void *sacl, _Out_ void **descriptor)");
  function stringifySid(sid: unknown): string {
    const text: unknown[] = [null];
    if (!sid || !sidString(sid, text) || !text[0]) throw new Error("File ownership unavailable.");
    try { return koffi.decode.string16(text[0]); }
    finally { localFree(text[0]); }
  }
  const token: unknown[] = [null], required = [0];
  if (!openToken(currentProcess(), 8, token)) throw new Error("Process identity unavailable.");
  let userSid: string;
  try {
    tokenInformation(token[0], 1, null, 0, required);
    const size = required[0]!;
    if (size < koffi.sizeof("void *") || size > 65536) throw new Error("Process identity unavailable.");
    const buffer = Buffer.alloc(size);
    if (!tokenInformation(token[0], 1, buffer, size, required)) throw new Error("Process identity unavailable.");
    userSid = stringifySid(koffi.decode(buffer, "void *"));
  } finally { closeHandle(token[0]); }
  return path => {
    const flags = attributes(path);
    if (flags === 0xffffffff || (flags & 0x400) !== 0) return false;
    const owner: unknown[] = [null], descriptor: unknown[] = [null];
    try {
      if (namedSecurity(path, 1, 1, owner, null, null, null, descriptor) !== 0) return false;
      return stringifySid(owner[0]) === userSid;
    } finally { if (descriptor[0]) localFree(descriptor[0]); }
  };
}

export function isOwnedFile(path: string, info: Stats): boolean {
  if (!info.isFile() || info.isSymbolicLink()) return false;
  if (process.platform !== "win32") return info.uid === process.getuid?.();
  windowsOwner ??= createWindowsOwnerCheck();
  return windowsOwner(path);
}
