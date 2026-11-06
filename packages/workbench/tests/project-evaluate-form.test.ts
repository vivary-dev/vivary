import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_FIELDS, STATE_SHAPE, STATE_TEMPLATES, actorLine, controlRequest, decideRequest, decisionOf, emptyControlDraft,
  emptyDecideDraft, isRefusalDocument, isSuccessDecision, reasonCodes, refusalTitle, returnedState, shownOutput,
} from "../app/lib/project-evaluate-form.ts";
import {
  CONTROL_OPERATIONS, projectEvaluateOwnInputSchema, projectEvaluateToolInputSchema, type ControlOperation, type ProjectEvaluateResult,
} from "../app/lib/project-evaluate-schema.ts";

const capsule = { schema: "vivary.task-capsule/v0", task: { scope: ["src"] } };

test("invalid JSON is reported in a plain sentence and builds no request", () => {
  assert.deepEqual(decideRequest({ ...emptyDecideDraft(), capsule: "{\"task\": " }, "me"),
    { ok: false, message: "The Task Capsule is not valid JSON. Check for a missing quote, comma, or bracket." });
  assert.deepEqual(decideRequest({ ...emptyDecideDraft(), capsule: "[]" }, "me"),
    { ok: false, message: "The Task Capsule must be a JSON object in braces." });
  assert.deepEqual(decideRequest(emptyDecideDraft(), "agent"), { ok: false, message: "Enter the Task Capsule as JSON." });
  assert.deepEqual(controlRequest({ ...emptyControlDraft(), paths: "src", states: { ...STATE_TEMPLATES, claims: "{claims: []}" } }),
    { ok: false, message: "The state is not valid JSON. Check for a missing quote, comma, or bracket." });
  assert.deepEqual(decideRequest({ ...emptyDecideDraft(), capsule: "{}", turns_used: "1.5" }, "me"),
    { ok: false, message: "Turns used must be a whole number of 0 or more." });
});

test("decide sends receipt and verdict only as the owner, and budgets only when given", () => {
  const draft = { ...emptyDecideDraft(), capsule: JSON.stringify(capsule), turns_used: "2", max_actions: "9",
    receipt: "{\"ok\": true}", verdict: "\"pass\"" };
  const me = decideRequest(draft, "me");
  assert.deepEqual(me, { ok: true, input: { operation: "decide", capsule, state: { turns_used: 2 }, limits: { max_actions: 9 },
    receipt: { ok: true }, verdict: "pass" } });
  const agent = decideRequest(draft, "agent");
  assert.deepEqual(agent, { ok: true, input: { operation: "decide", capsule, state: { turns_used: 2 }, limits: { max_actions: 9 } } });
  assert.ok(me.ok && projectEvaluateOwnInputSchema.safeParse(me.input).success);
  assert.ok(agent.ok && projectEvaluateToolInputSchema.safeParse(agent.input).success);
  assert.deepEqual(decideRequest({ ...emptyDecideDraft(), capsule: "{}" }, "me"), { ok: true, input: { operation: "decide", capsule: {} } });
});

test("control sends only the selected operation's fields, and each built request passes the owner schema", () => {
  const filled = { ...emptyControlDraft(), paths: " src/api \n\n docs \n", lease: "", claim_id: " c1 ", task_id: "t1",
    receipt: "{}", capsule: "{}", workspace_revision: "rev" };
  const expected = {
    claim: { operation: "claim", state: { claims: [] }, paths: ["src/api", "docs"] },
    release: { operation: "release", state: { claims: [] }, claim_id: "c1" },
    expire_leases: { operation: "expire_leases", state: { claims: [] } },
    dependencies: { operation: "dependencies", state: { tasks: [] }, task_id: "t1" },
    task_view: { operation: "task_view", state: { task: {}, execution_log: [] } },
    complete: { operation: "complete", state: { task: {}, execution_log: [] } },
    handoff: { operation: "handoff", state: { claims: [] }, claim_id: "c1", receipt: {}, capsule: {},
      to_actor: "agent", workspace_revision: "rev" },
    record_execution: { operation: "record_execution", state: { execution_log: [] }, receipt: {}, capsule: {} },
  };
  for (const operation of CONTROL_OPERATIONS) {
    const built = controlRequest({ ...filled, operation });
    assert.deepEqual(built, { ok: true, input: expected[operation] }, operation);
    assert.ok(built.ok && projectEvaluateOwnInputSchema.safeParse(built.input).success, operation);
  }
  assert.deepEqual(Object.keys(CONTROL_FIELDS).sort(), [...CONTROL_OPERATIONS].sort());
  assert.deepEqual(Object.keys(STATE_SHAPE).sort(), [...CONTROL_OPERATIONS].sort());
});

test("required control fields are refused in the panel, and a handoff needs no earlier evaluation", () => {
  assert.deepEqual(controlRequest({ ...emptyControlDraft(), paths: " \n " }),
    { ok: false, message: "Enter at least one path, such as src/api." });
  assert.deepEqual(controlRequest({ ...emptyControlDraft(), operation: "release" }), { ok: false, message: "Enter a claim id." });
  assert.deepEqual(controlRequest({ ...emptyControlDraft(), operation: "claim", paths: "src", lease: "7" }),
    { ok: false, message: "The lease must be a JSON object in braces." });
  const handoff = { ...emptyControlDraft(), operation: "handoff" as const, claim_id: "c1", receipt: "{}", capsule: "{}" };
  for (const to_actor of ["me", "agent"] as const) {
    const built = controlRequest({ ...handoff, to_actor });
    assert.ok(built.ok && built.input.to_actor === to_actor, to_actor);
    assert.ok(built.ok && projectEvaluateOwnInputSchema.safeParse(built.input).success, to_actor);
  }
  assert.equal(projectEvaluateOwnInputSchema.safeParse({ operation: "handoff", state: { claims: [] }, claim_id: "c1", receipt: {},
    capsule: {}, workspace_revision: "rev", to_actor: { kind: "agent", id: "agent_x" } }).success, false, "the server owns actor ids");
});

const evaluation = (operation: ControlOperation, output: unknown, refusedBy: "exo" | null = null): ProjectEvaluateResult => ({
  status: "evaluated", project: { id: "project-a", label: "Project A" }, operation,
  evaluatedAs: { kind: "human", id: "owner", authorityClass: "contributor", role: "owner" },
  persisted: false, evaluationKind: "caller-provided-evidence", notice: "", refusedBy, output });

test("a returned claim ledger feeds the next request, so claim then release needs no retyping", () => {
  const claims = [{ claim_id: "c1", actor: { kind: "agent", id: "agent_project" }, scope: { paths: ["./src"] } }];
  const claimed = { schema: "vivary.exo-control-result/v0", operation: "claim",
    result: { decision: "granted", reason_codes: [], claim: claims[0], claims, conflicts: [] } };
  const returned = returnedState(evaluation("claim", claimed));
  assert.deepEqual(returned && { ...returned, text: JSON.parse(returned.text) }, { shape: "claims", text: { claims }, claimId: "c1" });

  const draft = { ...emptyControlDraft(), operation: "release" as const, claim_id: returned!.claimId!,
    states: { ...STATE_TEMPLATES, [returned!.shape]: returned!.text } };
  assert.deepEqual(controlRequest(draft), { ok: true, input: { operation: "release", state: { claims }, claim_id: "c1" } });

  const released = { schema: "vivary.exo-control-result/v0", operation: "release", result: { decision: "released", reason_codes: [], claims: [] } };
  assert.deepEqual(returnedState(evaluation("release", released)), { shape: "claims", text: JSON.stringify({ claims: [] }, null, 2) });
  const recorded = { schema: "vivary.exo-control-result/v0", operation: "record_execution", result: { edges: [{ id: "e" }], added: 1, reason_codes: [] } };
  assert.deepEqual(returnedState(evaluation("record_execution", recorded))?.text, JSON.stringify({ execution_log: [{ id: "e" }] }, null, 2));
  assert.equal(returnedState(evaluation("dependencies", { operation: "dependencies", result: { ready: true } })), null);
  assert.equal(returnedState(evaluation("claim", { schema: "vivary.exo-control-refusal/v0", reason_codes: ["x"] }, "exo")), null);
  assert.equal(returnedState(evaluation("expire_leases", { schema: "vivary.exo-control-result/v0", operation: "expire_leases",
    result: { claims, expired: [], reason_codes: ["unknown_claim_shape"] } }, "exo")), null, "a refused ledger is not new state");
});

test("reason codes, shown output, and the actor line", () => {
  assert.deepEqual(reasonCodes({ schema: "vivary.exo-control-refusal/v0", reason_codes: ["invalid_state"] }), ["invalid_state"]);
  assert.deepEqual(reasonCodes({ schema: "vivary.strato-decision/v0", decision: "act", reason_codes: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(reasonCodes({ operation: "claim", result: { reason_codes: ["claim_conflict"] } }), ["claim_conflict"]);
  assert.deepEqual(reasonCodes({ operation: "dependencies", result: { ready: true } }), []);
  assert.deepEqual(shownOutput({ operation: "claim", result: { claims: [] } }), { claims: [] });
  assert.deepEqual(shownOutput({ decision: "act" }), { decision: "act" });
  assert.equal(isRefusalDocument({ schema: "vivary.exo-control-refusal/v0", reason_codes: ["x"] }), true);
  assert.equal(isRefusalDocument({ schema: "vivary.strato-decision-refusal/v0", reason_codes: ["x"] }), true);
  assert.equal(isRefusalDocument({ schema: "vivary.exo-control-result/v0", operation: "claim",
    result: { decision: "refused", conflicts: [{ claim_id: "c1" }] } }), false, "a refused claim keeps its conflicts on screen");
  assert.equal(actorLine({ kind: "human", id: "a", authorityClass: "contributor", role: "owner" }), "Evaluated as you (human, contributor)");
  assert.equal(actorLine({ kind: "agent", id: "b", authorityClass: "contributor", role: "project-agent" }),
    "Evaluated as this project's agent (agent, contributor)");
});

test("a decision headline alerts on every decision but an operation's success, and refusal titles name when they happened", () => {
  assert.equal(decisionOf({ schema: "vivary.strato-decision/v0", decision: "act" }), "act");
  assert.equal(decisionOf({ operation: "claim", result: { decision: "refused" } }), "refused");
  assert.equal(decisionOf({ operation: "expire_leases", result: { claims: [] } }), null);
  assert.equal(decisionOf({ schema: "vivary.exo-control-refusal/v0", reason_codes: ["x"] }), null);
  for (const decision of ["act", "granted", "released", "bound", "ready"]) assert.equal(isSuccessDecision(decision), true, decision);
  for (const decision of ["refused", "blocked", "request_gate", "stop"]) assert.equal(isSuccessDecision(decision), false, decision);
  for (const reason of ["unencodable_evidence", "result_too_large"] as const) {
    assert.equal(refusalTitle(reason), "Vivary could not return this result", reason);
  }
  for (const reason of ["server_owned_field", "foreign_path", "identity", "request_invalid", "unsupported_root"] as const) {
    assert.equal(refusalTitle(reason), "Vivary refused before running", reason);
  }
});
