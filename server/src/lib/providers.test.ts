import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findProviderByAlias,
  inferIntegrationNeeds,
  providersForPurpose,
  resolveProvider,
} from "./providers.ts";

describe("inferIntegrationNeeds", () => {
  it("infers commerce and email from last-month buyers plus send email", () => {
    const needs = inferIntegrationNeeds(
      "review which customers bought last month but have not bought this month and send them an email",
    );
    assert.deepEqual(needs.purposes.sort(), ["commerce", "email"]);
    assert.equal(needs.product, undefined);
  });

  it("infers email only from a send-email request", () => {
    const needs = inferIntegrationNeeds("send them an email");
    assert.deepEqual(needs.purposes, ["email"]);
    assert.equal(needs.product, undefined);
  });

  it("pins a named product", () => {
    const needs = inferIntegrationNeeds("I have it in my Shopify");
    assert.equal(needs.product, "shopify");
    assert.ok(needs.purposes.includes("commerce"));
  });
});

describe("resolveProvider", () => {
  it("returns connect_required without a product when only a purpose is known", () => {
    const resolved = resolveProvider({ purpose: "commerce" });
    assert.equal(resolved.spec, undefined);
    assert.equal(resolved.ask, "product");
    assert.ok(providersForPurpose("commerce").some((row) => row.id === "shopify"));
  });

  it("uses custom for an unknown product and only asks origin plus credential", () => {
    const resolved = resolveProvider({ product: "obscure-crm" });
    assert.equal(resolved.spec?.id, "custom");
    const fieldKeys = (resolved.spec?.authMethods[0]?.fields ?? []).map((row) => row.key);
    assert.deepEqual(fieldKeys, ["origin", "secret"]);
  });
});

describe("provider field help", () => {
  it("tells how to get the Shopify admin token", () => {
    const shopify = findProviderByAlias("shopify");
    const token = shopify?.authMethods
      .find((row) => row.kind === "fields")
      ?.fields.find((row) => row.key === "secret");
    assert.ok(token?.help?.includes("Develop apps"));
    assert.equal(
      token?.href,
      "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin",
    );
    for (const provider of [shopify, findProviderByAlias("gmail"), findProviderByAlias("slack"), findProviderByAlias("custom")]) {
      for (const method of provider?.authMethods ?? []) {
        for (const field of method.fields) {
          assert.ok(field.help, `${provider?.id}.${field.key} needs help`);
        }
      }
    }
  });
});
