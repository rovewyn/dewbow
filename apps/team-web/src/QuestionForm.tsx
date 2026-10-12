import {useState} from "react";
import type {UserQuestion,QuestionAnswer} from "@dewbow/team-protocol";

export function QuestionForm({questions,disabled,onAnswer}:{questions:UserQuestion[];disabled:boolean;onAnswer:(answers:QuestionAnswer[])=>void}) {
  const [values,setValues]=useState(new Map<string,string>());
  const setValue=(id:string,value:string)=>setValues(previous=>new Map(previous).set(id,value));
  return <form onSubmit={event=>{event.preventDefault();onAnswer(questions.map(question=>({questionId:question.questionId,answers:[values.get(question.questionId)??""]})));}}>
    {questions.map(question=><fieldset key={question.questionId} disabled={disabled}><legend>{question.header}</legend><p>{question.prompt}</p>
      {question.options?.map(option=><label key={option.label}><input type="radio" name={question.questionId} value={option.label} checked={values.get(question.questionId)===option.label} onChange={()=>setValue(question.questionId,option.label)}/>{option.label} — {option.description}</label>)}
      {question.allowCustom && <input className="input" type="text" autoComplete="off" aria-label={`${question.header}: custom answer`} value={values.get(question.questionId)??""} onChange={event=>setValue(question.questionId,event.target.value)}/>}</fieldset>)}
    <button className="button primary" disabled={disabled || questions.some(question=>!values.get(question.questionId)?.trim())}>Submit answers</button>
  </form>;
}
