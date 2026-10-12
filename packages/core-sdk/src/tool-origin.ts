import {constants} from "node:fs";
import {lstat,open,readdir,realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {isAbsolute,join,relative,sep} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {canonicalHome,checkAbort,object,uuid} from "./internal.js";
import {isOwnedFile} from "./file-trust.js";
import {readLineageHeader} from "./lineage.js";

/** Return only an exact native tool name; never publish arguments or rollout text. */
export async function readSessionToolOrigin(sessionId: string, turnId: string, itemId: string, options: {codexHome?:string;signal?:AbortSignal} = {}): Promise<{name:string;namespace:string|null}|null> {
  const id=uuid(sessionId); if (!id || !turnId || !itemId) throw new TypeError("Exact native identities are required.");
  const home=await canonicalHome(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(),".codex"));
  let db:DatabaseSync|undefined;
  try {
    checkAbort(options.signal);
    const candidate=(await readdir(home)).flatMap(name=>{const match=/^state_(\d+)\.sqlite$/.exec(name);return match?[{name,version:Number(match[1])}]:[];}).sort((a,b)=>b.version-a.version)[0];
    if (!candidate) return null;
    const database=join(home,candidate.name); if (!isOwnedFile(database,await lstat(database))) return null;
    db=new DatabaseSync(database,{readOnly:true,allowExtension:false,timeout:1000});db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    const row=db.prepare("SELECT CASE WHEN length(rollout_path)<=4096 THEN rollout_path ELSE NULL END AS path FROM threads WHERE id=?").get(id);
    db.close();db=undefined;
    if (typeof row?.path !== "string") return null;
    const path=row.path, canonical=await realpath(path);
    const root=[join(home,"sessions"),join(home,"archived_sessions")].find(root=>{const rel=relative(root,canonical);return !isAbsolute(rel)&&rel!==".."&&!rel.startsWith(`..${sep}`);});
    if (!root || (await readLineageHeader(path,root)).id !== id) return null;
    const handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
    try {
      const info=await handle.stat();if (!isOwnedFile(path,info) || await realpath(path) !== canonical) return null;
      const start=Math.max(0,info.size-8*1024*1024), data=Buffer.alloc(info.size-start);
      let read=0;const deadline=Date.now()+3000;
      while(read<data.length){checkAbort(options.signal);if(Date.now()>deadline)return null;const result=await handle.read(data,read,Math.min(65536,data.length-read),start+read);if(!result.bytesRead)break;read+=result.bytesRead;}
      let currentTurn:string|null=null, found:{name:string;namespace:string|null}|null=null;
      const lines=data.subarray(0,read).toString("utf8").split("\n");if(start)lines.shift();
      for(const line of lines){checkAbort(options.signal);if(!line)continue;if(Buffer.byteLength(line)>1048576){currentTurn=null;continue;}let record;try{record=object(JSON.parse(line));}catch{currentTurn=null;continue;}const payload=object(record.payload);
        if(record.type === "turn_context" && typeof payload.turn_id === "string") currentTurn=payload.turn_id;
        if(record.type === "event_msg" && payload.type === "task_started" && typeof payload.turn_id === "string") currentTurn=payload.turn_id;
        if(currentTurn === turnId && record.type === "response_item" && payload.type === "function_call" && payload.call_id === itemId && typeof payload.name === "string") {
          if(payload.namespace!=null && typeof payload.namespace!=="string")return null;
          const next={name:payload.name,namespace:typeof payload.namespace === "string" ? payload.namespace : null};
          if(found && (found.name!==next.name || found.namespace!==next.namespace))return null;found=next;
        }
      }
      return found;
    } finally {await handle.close();}
  } catch {checkAbort(options.signal);return null;} finally {db?.close();}
}
