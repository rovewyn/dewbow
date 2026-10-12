import { useId, useState } from "react";
import type { QuestionAnswer, UserQuestion } from "@dewbow/core-protocol";
import { Button, Input } from "../ui/index.js";

export function QuestionForm({ questions, disabled, onAnswer }: { questions: UserQuestion[]; disabled: boolean; onAnswer: (answers: QuestionAnswer[]) => void }) {
  const id = useId(), [values, setValues] = useState(new Map<string, string>());
  const change = (key: string, value: string) => setValues(previous => new Map(previous).set(key, value));
  return <form className="chat-question-form" onSubmit={event => {
    event.preventDefault();
    if (!disabled && questions.every(question => values.get(question.questionId)?.trim())) onAnswer(questions.map(question => ({ questionId: question.questionId, answers: [values.get(question.questionId)!] })));
  }}>
    {questions.map((question, index) => <fieldset key={question.questionId} disabled={disabled}>
      <legend>{question.header}</legend><p>{question.prompt}</p>
      {question.options?.map(option => <label className="chat-option" key={option.label}>
        <input type="radio" name={`${id}-${index}`} checked={values.get(question.questionId) === option.label} onChange={() => change(question.questionId, option.label)} />
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
      </label>)}
      {question.allowCustom && <><label className="chat-custom-label" htmlFor={`${id}-${index}`}>{question.options ? "Custom answer" : "Your answer"}</label>
        <Input id={`${id}-${index}`} aria-label={`${question.header}: custom answer`} type={question.secret ? "password" : "text"} autoComplete="off" maxLength={100000} value={values.get(question.questionId) ?? ""} onChange={event => change(question.questionId, event.target.value)} /></>}
    </fieldset>)}
    <Button type="submit" disabled={disabled || questions.some(question => !values.get(question.questionId)?.trim())}>Submit answers</Button>
  </form>;
}
