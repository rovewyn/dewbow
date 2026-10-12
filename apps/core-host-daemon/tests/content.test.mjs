import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionContent } from "../dist/content.js";
import { projectItem } from "../dist/history.js";

test("private content preserves Unicode chunks, capture completeness, historical diffs and conversation isolation after restart", () => {
  const directory = mkdtempSync(join(tmpdir(),"dewbow-content-")), path = join(directory,"contents.sqlite");
  let content = new SessionContent(path);
  const scope="synthetic-conversation-one", other="synthetic-conversation-two", text="漢😀\0\n".repeat(40000);
  const drain = (ref,limitBytes) => {
    let cursor, saved="", expected=0;
    do {
      const page=content.read(scope,ref.contentId,cursor,limitBytes);
      assert.equal(page.byteOffset,expected); assert.ok(Buffer.byteLength(page.text)<=limitBytes);
      saved+=page.text; expected+=Buffer.byteLength(page.text); cursor=page.nextCursor;
    } while(cursor);
    assert.equal(expected,Buffer.byteLength(saved)); return saved;
  };
  try {
    const captured=content.startCapture(scope,"command");
    content.appendCapture(scope,captured.contentId,text.slice(0,1000)); content.appendCapture(scope,captured.contentId,text.slice(1000));
    assert.equal(content.read(scope,captured.contentId).availability,"partial");
    const complete=content.finishCapture(scope,captured.contentId);
    assert.equal(drain(complete,65537),text);
    const item={type:"commandExecution",id:"command",command:"synthetic command",status:"completed",aggregatedOutput:"PRIVATE_SOURCE_TRUNCATED_MARKER"};
    const record={id:"command",turnId:"native-turn",ordinal:3,updatedOrdinal:7,completedAtMs:1700000000000,createdAtMs:1700000000000,turnStatus:"completed",item,itemJson:JSON.stringify(item)};
    const activity=projectItem(record,scope,content).activity; activity.contents=[complete]; content.saveActivity(scope,activity);
    assert.equal(projectItem(record,scope,content).activity.contents[0].contentId,complete.contentId);
    const diff="--- sample.txt\n+++ sample.txt\n-Original\n+漢😀\n", patch={type:"fileChange",id:"patch",status:"completed",changes:[{path:"sample.txt",diff}]};
    const changed=projectItem({...record,id:"patch",item:patch,itemJson:JSON.stringify(patch)},scope,content).activity;
    assert.equal(drain(changed.contents[0],4),diff);
    assert.throws(()=>content.read(other,complete.contentId),error=>error.detail.code === "NOT_FOUND");
    const first=content.read(scope,complete.contentId,undefined,4);
    assert.throws(()=>content.read(other,complete.contentId,first.nextCursor),error=>error.detail.code === "INVALID_INPUT");
    content.close(); content=new SessionContent(path);
    assert.equal(drain(content.getActivity(scope,"command").contents[0],262144),text);
    assert.equal(drain(content.getActivity(scope,"patch").contents[0],65536),diff);
  } finally { content.close(); rmSync(directory,{recursive:true,force:true}); }
});
