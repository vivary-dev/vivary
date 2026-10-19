import type { ReactNode } from "react";
import { registerMarkdownFenceRenderer, registerUserMessageTextRenderer } from "@agent-native/core/client/chat";
import { handoffSaveStatus, useHandoffDisplayState } from "./handoff-status";

// How a handoff request and its reply read in a conversation. The stored message text, the parser in
// server/handoff.ts and its validation are unchanged. Core renders the reply's vivary-handoff fence and the
// request message through the renderers registered at the end of this module, so only the display changes.

const REQUEST = /^Prepare handoff \(vivary-handoff-request:[^)\s]+\)/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
const list = (value: unknown) => Array.isArray(value) ? value.map(text) : value === undefined ? [] : [text(value)];

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <section><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></section>;
}

/** The reply's vivary-handoff block as a readable preview, with the block itself under Raw details. */
export function HandoffReplyPreview({ code }: { code: string; lang?: string }) {
  const state = useHandoffDisplayState();
  let value: unknown = null;
  try { value = JSON.parse(code); } catch { value = null; }
  const proposal = isRecord(value) ? value : null;
  const requestId = typeof proposal?.requestId === "string" ? proposal.requestId : null;
  const status = proposal ? handoffSaveStatus(state, requestId) : null;
  const checks = Array.isArray(proposal?.checks) ? proposal.checks : [];
  let body: ReactNode;
  // A reply that is still streaming, or a malformed one, keeps its text under Raw details.
  if (!proposal) body = <p>This handoff block is incomplete or is not valid JSON, so it cannot be previewed.</p>;
  else body = <>
    {proposal.goal !== undefined && <p><strong>Goal:</strong> {text(proposal.goal)}</p>}
    <Section title="Decisions" items={list(proposal.decisions)} />
    <Section title="Changes" items={list(proposal.changes)} />
    {checks.length > 0 && <section><h4>Checks</h4><ul>{checks.map((check, index) => {
      const item = isRecord(check) ? check : {};
      const evidence = typeof item.evidenceEventId === "string" ? ` (event ${item.evidenceEventId})` : "";
      return <li key={index}>{text(item.outcome)}: {text(item.name)}{evidence}</li>;
    })}</ul></section>}
    <Section title="Unfinished work" items={list(proposal.unfinished)} />
    <Section title="Risks" items={list(proposal.risks)} />
    {proposal.nextAction !== undefined && <p><strong>Next action:</strong> {text(proposal.nextAction)}</p>}
  </>;
  return <div className="vivary-handoff-preview">
    <h3>Handoff</h3>
    {status && <div role="status" className="vivary-handoff-status"><p>{status.text}</p>
      {status.problems && <ul>{status.problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}</div>}
    {body}
    <details><summary>Raw details</summary><pre>{code}</pre></details>
  </div>;
}

export const isHandoffRequestText = (value: string) => REQUEST.test(value);

/** The request Vivary sent for Prepare handoff, as one line with the full prompt under a disclosure. */
export function HandoffRequestMessage({ text: request }: { text: string }) {
  return <div className="vivary-handoff-request">
    <p>Handoff requested</p>
    <details><summary>Full request</summary><div className="whitespace-pre-wrap">{request}</div></details>
  </div>;
}

registerMarkdownFenceRenderer("vivary-handoff", HandoffReplyPreview);
registerUserMessageTextRenderer({ matches: isHandoffRequestText, Component: HandoffRequestMessage });
