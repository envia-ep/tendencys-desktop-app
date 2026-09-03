import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EDGE_REGISTRY,
  tableForEdge,
  validateEdgePair,
  wouldCreateCycle,
} from "./org-edges.ts";

describe("org edge registry", () => {
  it("rejects invalid reports_to pairs and self-membership", () => {
    assert.equal(validateEdgePair("reports_to", "role", "human", "r1", "h1").ok, false);
    assert.equal(validateEdgePair("member_of", "human", "unit", "u1", "u1").ok, false);
    assert.equal(validateEdgePair("reports_to", "agent", "human", "a1", "h1").ok, true);
  });

  it("routes has_skill from a role to role_skills", () => {
    assert.equal(tableForEdge("has_skill", "role"), "role_skills");
    assert.equal(tableForEdge("has_skill", "agent"), "agent_skills");
    assert.equal(EDGE_REGISTRY.can_use.table, "access_grants");
  });

  it("detects a reports_to cycle", () => {
    assert.equal(
      wouldCreateCycle(
        [
          { fromId: "a", toId: "b" },
          { fromId: "b", toId: "c" },
        ],
        "c",
        "a",
      ),
      true,
    );
    assert.equal(wouldCreateCycle([{ fromId: "a", toId: "b" }], "c", "a"), false);
  });
});
