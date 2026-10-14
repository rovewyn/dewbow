import {randomUUID} from "node:crypto";
import {fail,now,type Interaction,type InteractionDetails,type QuestionAnswer,type Session,type Turn,type UserQuestion} from "@dewbow/protocol";
import type {RpcMessage} from "@dewbow/sdk";
import {SessionContent} from "./content.js";

export interface NativeInteraction extends Interaction {codexRequestId:string|number;runtimeId:string;nativeMethod:string}
export const publicInteraction = ({codexRequestId:_request,runtimeId:_runtime,nativeMethod:_method,...item}:NativeInteraction):Interaction=>item;
export const builtinQuestion = (origin:{name:string;namespace:string|null}|null|undefined)=>origin?.name === "request_user_input" && (origin.namespace === null || origin.namespace === "functions");

function questions(value:unknown):UserQuestion[]|null {
  if (!Array.isArray(value) || !value.length || value.length>20) return null;
  const seen=new Set<string>(), result:UserQuestion[]=[];
  for(const question of value) {
    if(!question || typeof question.id!=="string" || !question.id || question.id.length>200 || seen.has(question.id) || typeof question.header!=="string" || question.header.length>1000 || typeof question.question!=="string" || question.question.length>100000) return null;
    seen.add(question.id);
    if((question.isSecret!==undefined && typeof question.isSecret!=="boolean") || (question.isOther!==undefined && typeof question.isOther!=="boolean")) return null;
    if(question.options!=null && (!Array.isArray(question.options) || !question.options.length || question.options.length>100 || question.options.some((option:any)=>typeof option?.label!=="string" || !option.label || option.label.length>10000 || typeof option.description!=="string" || option.description.length>100000))) return null;
    result.push({questionId:question.id,header:question.header,prompt:question.question,options:question.options??null,allowCustom:question.options==null || question.isOther===true,secret:question.isSecret===true});
  }
  return result;
}

export function createInteraction(session:Session,turn:Turn,message:RpcMessage,scope:string,contents:SessionContent,runtimeId:string,origin?:{name:string;namespace:string|null}):NativeInteraction {
  const method=message.method!,params=message.params??{},questionList=method === "item/tool/requestUserInput" && typeof params.isBlocking === "boolean" ? questions(params.questions) : null;
  const approval=["item/commandExecution/requestApproval","item/fileChange/requestApproval","item/permissions/requestApproval"].includes(method);
  const details:InteractionDetails=questionList ? {questions:questionList} : {action:approval ? {kind:method,command:params.command??null,cwd:params.cwd??session.workDir,reason:params.reason??null,itemId:params.itemId??null,grantRoot:params.grantRoot??null,permissions:params.permissions??null,availableDecisions:params.availableDecisions??null} : {kind:method,reason:"This native interaction requires a Dewbow operator and is not supported for delivery. Interrupt the turn to stop it."}};
  const encoded=JSON.stringify(details);if(Buffer.byteLength(encoded)>1048576)fail("LIMIT_EXCEEDED","Interaction details exceed the private content limit.");
  const interactionId=randomUUID(), timestamp=now(),sensitive=method === "item/tool/requestUserInput" && (!questionList || questionList.some(question=>question.secret));
  return {interactionId,sessionId:session.sessionId,turnId:turn.turnId,itemId:typeof params.itemId === "string" ? params.itemId : null,
    kind:questionList ? "questions" : approval ? "approval" : "unsupported",authority:questionList && builtinQuestion(origin) && !questionList.some(question=>question.secret) ? "agent" : "operator",blocking:questionList ? params.isBlocking!==false : true,
    status:"pending",createdAt:timestamp,observedAt:timestamp,decision:null,requestId:null,sensitive,
    content:contents.put(scope,interactionId,"output","Interaction details",encoded,"complete",sensitive ? "operator" : "agent"),
    codexRequestId:message.id!,runtimeId,nativeMethod:method};
}

export function interactionDetails(item:NativeInteraction,scope:string,contents:SessionContent):InteractionDetails {
  return contents.readDetails(scope,item.content.contentId!) as InteractionDetails;
}
export function validateAnswers(details:InteractionDetails,answers:QuestionAnswer[]):void {
  const list=details.questions;if(!list || answers.length!==list.length)fail("INVALID_INPUT","Answer each question exactly once.");
  const seen=new Set<string>();
  for(const answer of answers){const question=list.find(question=>question.questionId===answer.questionId);
    if(!question || seen.has(answer.questionId) || !answer.answers.length || answer.answers.some(value=>!value.trim() || (!question.allowCustom && !question.options?.some(option=>option.label===value))))fail("INVALID_INPUT","Answers do not match this interaction.");
    seen.add(answer.questionId);
  }
}
export function approvalResponse(item:NativeInteraction,details:InteractionDetails,decision:"allow"|"deny"):unknown {
  if(item.nativeMethod === "item/permissions/requestApproval")return {permissions:decision === "allow" ? details.action!.permissions : {},scope:"turn"};
  const nativeDecision=decision === "allow" ? "accept" : "decline";
  const allowed=details.action?.availableDecisions;
  if(Array.isArray(allowed) && !allowed.includes(nativeDecision))fail("INVALID_INPUT","Native callback does not support this decision.");
  return {decision:nativeDecision};
}
