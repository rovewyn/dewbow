import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,toNamespacedPath} from "node:path";
import {hasInjectedContext} from "../dist/context.js";

test("native passive evidence permits unmaterialized paths but rejects outside paths and conflicting or foreign records",async()=>{
  const home=mkdtempSync(join(tmpdir(),"dewbow-context-")),sessions=join(home,"sessions"),path=join(sessions,"rollout.jsonl");mkdirSync(sessions);
  try {
    assert.equal(await hasInjectedContext(home,toNamespacedPath(path),"thread","item","Synthetic"),false);
    if(process.platform!=="win32"){
      const alias=join(home,"alias");symlinkSync(home,alias,"dir");
      assert.equal(await hasInjectedContext(alias,join(alias,"sessions","rollout.jsonl"),"thread","item","Synthetic"),false);
    }
    await assert.rejects(hasInjectedContext(home,join(home,"outside.jsonl"),"thread","item","Synthetic"));
    const item={type:"response_item",payload:{type:"message",id:"item",role:"user",content:[{type:"input_text",text:"Synthetic"}]}};
    writeFileSync(path,JSON.stringify({type:"session_meta",payload:{id:"thread"}})+"\n"+JSON.stringify(item)+"\n");
    assert.equal(await hasInjectedContext(home,toNamespacedPath(path),"thread","item","Synthetic"),true);
    await assert.rejects(hasInjectedContext(home,path,"thread","item","Changed"));
    await assert.rejects(hasInjectedContext(home,path,"another-thread","item","Synthetic"));
  } finally {rmSync(home,{recursive:true,force:true});}
});
