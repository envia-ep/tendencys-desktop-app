import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { graphChanged } from "./errors.ts";
import {
  composeProposalGraph,
  createStudioProposal,
  ECOMMERCE_FIXTURE_BRIEF,
  instantiateProposal,
} from "./studio-propose.ts";
import { JarvisStore } from "./store.ts";

describe("studio composer and proposals", () => {
  it("proposes CX / Social / Sales / Analytics with Jarvis first and me as root", () => {
    const composed = composeProposalGraph(ECOMMERCE_FIXTURE_BRIEF, { meLabel: "Me" });
    assert.equal(composed.templateId, "ecommerce");
    const agentLabels = composed.nodes.filter((node) => node.kind === "agent").map((node) => node.label);
    assert.equal(agentLabels[0], "Jarvis");
    assert.deepEqual(
      composed.nodes.filter((node) => node.kind === "unit").map((node) => node.label),
      ["Customer Experience", "Social", "Sales", "Analytics"],
    );
    const me = composed.nodes.find((node) => node.id === "me");
    assert.equal(me?.kind, "human");
    assert.ok(composed.edges.every((edge) => edge.kind !== "reports_to" || edge.toId === "me"));
  });

  it("rejects instantiate when the live graph revision moved", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const proposal = createStudioProposal(store, {
      orgId: "acme",
      createdBy: "user_1",
      brief: ECOMMERCE_FIXTURE_BRIEF,
      meLabel: "Me",
    });
    store.bumpGraphRevision("acme");
    assert.throws(
      () => instantiateProposal(store, proposal.id, { userId: "user_1", displayName: "Me" }),
      (error: unknown) => error instanceof Error && (error as { code?: string }).code === "GRAPH_CHANGED",
    );
    void graphChanged;
  });

  it("replays instantiate for the same proposal hash", () => {
    const store = new JarvisStore();
    store.ensureOrg("acme", "user_1");
    const proposal = createStudioProposal(store, {
      orgId: "acme",
      createdBy: "user_1",
      brief: ECOMMERCE_FIXTURE_BRIEF,
      meLabel: "Me",
    });
    const first = instantiateProposal(store, proposal.id, { userId: "user_1", displayName: "Me" });
    const second = instantiateProposal(store, proposal.id, { userId: "user_1", displayName: "Me" });
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(first.proposal.contentHash, second.proposal.contentHash);
  });
});
