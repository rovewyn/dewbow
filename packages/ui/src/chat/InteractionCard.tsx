import type { Interaction } from "@dewbow/protocol";
import type { ChatViewProps } from "./types.js";
import { Badge, Button, Card, CardContent } from "../ui/index.js";
import { QuestionForm } from "./QuestionForm.js";

export function InteractionCard({ interaction, view }: { interaction: Interaction; view: ChatViewProps }) {
  const waiting = ["pending", "requested", "delivered"].includes(interaction.status), permitted = view.canRespond(interaction);
  const readable = view.canReadContent(interaction.content);
  const disabled = view.composer.busy || interaction.status !== "pending" || !permitted || !view.canSubmitInteraction(interaction);
  const loading = interaction.content.contentId !== null && view.loadingInteractions.has(interaction.content.contentId);
  const title = interaction.kind === "questions" ? "Codex needs your answer" : interaction.kind === "approval" ? "Approval required" : "Operator action required";
  return <Card className={`chat-interaction ${waiting ? "chat-interaction-pending" : ""}`} data-interaction-id={interaction.interactionId} tabIndex={-1}>
    <CardContent>
      <div className="chat-interaction-heading"><strong>{title}</strong><Badge variant="outline">{interaction.status}</Badge></div>
      {waiting && <p className="chat-muted">{interaction.blocking ? "The turn is waiting for this response." : "This question can be answered while the turn continues."}</p>}
      {!readable || !permitted && waiting ? <><p>{waiting ? "Respond in Dewbow." : "View this private interaction in Dewbow."}</p>{view.operatorUrl && <a href={view.operatorUrl} target="_blank" rel="noreferrer">Open Dewbow ↗</a>}</> : <>
        {!interaction.details && interaction.content.contentId && <Button variant="outline" disabled={view.composer.busy || loading || !view.canReadContent(interaction.content) || !view.contentReadsAvailable} onClick={() => view.onLoadInteraction(interaction)}>{loading ? "Loading details…" : "Load interaction details"}</Button>}
        {interaction.kind === "questions" && interaction.details?.questions && waiting && <QuestionForm questions={interaction.details.questions} disabled={disabled} onAnswer={answers => view.onAnswer({ turnId: interaction.turnId, interactionId: interaction.interactionId, answers })} />}
        {interaction.kind === "questions" && interaction.details?.questions && !waiting && <dl>{interaction.details.questions.map(question => <div key={question.questionId}><dt>{question.header}</dt><dd>{question.prompt}</dd><dd>{question.secret ? "Private answer" : interaction.details?.answers?.find(answer => answer.questionId === question.questionId)?.answers.join(" · ") ?? "No recorded answer"}</dd></div>)}</dl>}
        {interaction.details?.action && <pre className="chat-action">{JSON.stringify(interaction.details.action, null, 2)}</pre>}
        {interaction.kind === "approval" && waiting && <div className="chat-interaction-actions">
          <Button disabled={disabled || !interaction.details?.action} onClick={() => view.onDecideApproval({ turnId: interaction.turnId, interactionId: interaction.interactionId, decision: "allow" })}>Allow</Button>
          <Button variant="outline" disabled={disabled || !interaction.details?.action} onClick={() => view.onDecideApproval({ turnId: interaction.turnId, interactionId: interaction.interactionId, decision: "deny" })}>Deny</Button>
        </div>}
        {interaction.kind === "unsupported" && waiting && <p>Interrupt the turn to stop this unsupported request.</p>}
        {interaction.decision && <p className="chat-muted">Decision: {interaction.decision}</p>}
        {interaction.status === "delivered" && <p className="chat-muted">Response delivered. Waiting for native resolution.</p>}
      </>}
    </CardContent>
  </Card>;
}
