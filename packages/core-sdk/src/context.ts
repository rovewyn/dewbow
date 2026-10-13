import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from "node:path";
import { isOwnedFile } from "./file-trust.js";

/** Passive items are persisted in the rollout but are not indexed as native turns. */
export async function hasInjectedContext(home: string, path: string, threadId: string, itemId: string, text: string): Promise<boolean> {
  const root = toNamespacedPath(await realpath(home));
  const check = (file:string) => {
    const local = relative(root,file);
    if (!local || local.startsWith(`..${sep}`) || !["sessions","archived_sessions"].includes(local.split(sep)[0]!)) throw new Error("Untrusted context history path.");
  };
  if (!isAbsolute(path)) throw new Error("Untrusted context history path.");
  let file:string;
  try {file=toNamespacedPath(await realpath(path));}
  catch(error) {
    // Codex assigns a rollout path before materializing the first persistent item.
    // Missing evidence never authorizes replay of an already attempted append.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      let ancestor=resolve(path);const missing:string[]=[];
      while(true) {
        try {check(join(toNamespacedPath(await realpath(ancestor)),...missing.reverse()));return false;}
        catch(cause) {
          if ((cause as NodeJS.ErrnoException).code!=="ENOENT" || dirname(ancestor)===ancestor)throw cause;
          missing.push(basename(ancestor));ancestor=dirname(ancestor);
        }
      }
    }
    throw error;
  }
  check(file);
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!isOwnedFile(file, info) || info.size > 256 * 1024 * 1024) throw new Error("Context history cannot be verified.");
    let pending = "", owned = false, found = false;
    const line = (value: string) => {
      if (!value.trim()) return;
      const record = JSON.parse(value);
      if (record.type === "session_meta") owned = record.payload?.id === threadId;
      if (record.type === "response_item" && record.payload?.id === itemId) {
        const item = record.payload;
        if (item.type !== "message" || item.role !== "user" || item.content?.length !== 1 || item.content[0]?.type !== "input_text" || item.content[0]?.text !== text) throw new Error("Context identity conflicts with saved history.");
        found = true;
      }
    };
    for await (const chunk of handle.createReadStream({ encoding: "utf8", autoClose:false })) {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { line(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 2 * 1024 * 1024) throw new Error("Context history line exceeds the read limit.");
    }
    if (pending) line(pending);
    if (!owned) throw new Error("Context history belongs to a different conversation.");
    return found;
  } finally { await handle.close(); }
}
