import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findProviderByAlias, type ProviderSpec } from "./providers.ts";
import {
  catalogRecipe,
  findLearnedRecipe,
  recipeFromDraft,
  recommendConnection,
  rememberRecipe,
} from "./recipes.ts";
import { JarvisStore } from "./store.ts";
import type { IntegrationDraft } from "./types.ts";

describe("catalogRecipe", () => {
  it("recommends the self-serve token method for Gmail when the platform OAuth app is not configured", () => {
    const spec = findProviderByAlias("gmail");
    assert.ok(spec, "gmail provider should exist");
    const recipe = catalogRecipe(spec!, {});
    assert.equal(recipe.slug, "gmail");
    assert.notEqual(recipe.recommendedAuth.kind, "oauth", "must not force OAuth when the platform has no app");
    const keys = recipe.requiredFields.map((field) => field.key);
    assert.ok(!keys.includes("clientId"), "must not ask the customer for an OAuth client id");
    assert.ok(!keys.includes("clientSecret"), "must not ask the customer for an OAuth client secret");
    assert.ok(keys.includes("secret"), "should request the self-serve token");
    assert.ok(recipe.steps.length > 0);
    assert.equal(recipe.source, "catalog");
  });

  it("recommends OAuth one-click (no client id/secret) once the platform OAuth app is env-configured", () => {
    const spec = findProviderByAlias("gmail");
    const oauth = spec!.authMethods.find((method) => method.kind === "oauth")!.oauth!;
    const recipe = catalogRecipe(spec!, {
      [oauth.envClientId]: "configured-id",
      [oauth.envClientSecret]: "configured-secret",
    });
    assert.equal(recipe.recommendedAuth.kind, "oauth");
    const keys = recipe.requiredFields.map((field) => field.key);
    assert.ok(!keys.includes("clientId"));
    assert.ok(!keys.includes("clientSecret"));
  });

  it("recommends the self-serve token method for Shopify/Slack when OAuth is not configured", () => {
    for (const alias of ["shopify", "slack"]) {
      const spec = findProviderByAlias(alias);
      assert.ok(spec, `${alias} provider should exist`);
      const recipe = catalogRecipe(spec!, {});
      assert.notEqual(recipe.recommendedAuth.kind, "oauth", `${alias} must not force OAuth`);
      const keys = recipe.requiredFields.map((field) => field.key);
      assert.ok(keys.includes("secret"), `${alias} should request the self-serve token`);
      assert.ok(!keys.includes("clientId"), `${alias} must not ask for an OAuth client id`);
    }
  });

  it("falls back to bring-your-own OAuth client only for an OAuth-only spec with no configured app", () => {
    const oauthOnly: ProviderSpec = {
      id: "oauth_only",
      aliases: ["oauth only"],
      purposes: ["custom"],
      origin: "https://api.oauthonly.test",
      credentialKind: "bearer",
      authMethods: [
        {
          kind: "oauth",
          fields: [],
          oauth: {
            authorizeUrl: "https://api.oauthonly.test/authorize",
            tokenUrl: "https://api.oauthonly.test/token",
            scopes: ["read"],
            envClientId: "OAUTH_ONLY_CLIENT_ID",
            envClientSecret: "OAUTH_ONLY_CLIENT_SECRET",
          },
        },
      ],
      operations: [],
    };
    const recipe = catalogRecipe(oauthOnly, {});
    assert.equal(recipe.recommendedAuth.kind, "oauth");
    const keys = recipe.requiredFields.map((field) => field.key);
    assert.ok(keys.includes("clientId"));
    assert.ok(keys.includes("clientSecret"));
  });
});

describe("learned recipe library", () => {
  it("upserts platform-wide and bumps successCount on re-remember", () => {
    const store = new JarvisStore();
    const spec = findProviderByAlias("gmail")!;
    assert.equal(findLearnedRecipe(store, "gmail"), undefined);

    const first = rememberRecipe(store, catalogRecipe(spec, {}));
    assert.equal(first.source, "learned");
    assert.equal(first.successCount, 1);

    const second = rememberRecipe(store, catalogRecipe(spec, {}));
    assert.equal(second.successCount, 2);
    assert.equal(findLearnedRecipe(store, "gmail")?.successCount, 2);
  });
});

describe("recommendConnection", () => {
  it("returns the catalog recipe for a known product", async () => {
    const store = new JarvisStore();
    const { recipe, source } = await recommendConnection(store, { product: "gmail" });
    assert.equal(source, "catalog");
    assert.equal(recipe.slug, "gmail");
  });

  it("prefers a learned recipe for an unknown product once remembered", async () => {
    const store = new JarvisStore();
    const draft = draftFor("Acme Widgets", "https://api.acme.test");
    rememberRecipe(store, recipeFromDraft(draft, { secret: "x" }));
    const { recipe, source } = await recommendConnection(store, { product: "Acme Widgets" });
    assert.equal(source, "learned");
    assert.equal(recipe.slug, "acme_widgets");
  });

  it("falls back to an AI recipe when the product is unknown and no model is configured", async () => {
    const store = new JarvisStore();
    const { recipe, source } = await recommendConnection(store, { product: "Totally New Thing" });
    assert.equal(source, "ai");
    assert.equal(recipe.slug, "totally_new_thing");
    assert.ok(recipe.steps.length > 0);
  });
});

describe("recipeFromDraft", () => {
  it("derives requiredFields from the exact keys the user supplied, masking secrets", () => {
    const draft = draftFor("Acme Widgets", "https://api.acme.test");
    const recipe = recipeFromDraft(draft, { serverUrl: "https://mcp.acme", clientSecret: "shh" });
    const keys = recipe.requiredFields.map((field) => field.key);
    assert.deepEqual(keys.sort(), ["clientSecret", "serverUrl"]);
    assert.equal(recipe.requiredFields.find((f) => f.key === "clientSecret")?.secret, true);
    assert.equal(recipe.requiredFields.find((f) => f.key === "serverUrl")?.secret, false);
    // No secret values ever copied into the recipe.
    assert.ok(!JSON.stringify(recipe).includes("shh"));
  });
});

function draftFor(name: string, baseUrl: string): IntegrationDraft {
  const now = new Date().toISOString();
  return {
    id: "drf_test",
    orgId: "org_acme",
    name,
    sourceType: "openapi",
    status: "REVIEW_REQUIRED",
    specHash: null,
    baseUrl,
    discoveredAuth: { kind: "bearer" },
    discoveredOperations: [],
    proposedCapabilities: [],
    validationState: null,
    questions: [],
    createdBy: "user_1",
    createdAt: now,
    updatedAt: now,
  };
}
