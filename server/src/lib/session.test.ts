import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
  clearAccountsIdentityCache,
  extractJwtAudience,
  identityFromAccountsBody,
  resolveAccountsBaseUrl,
  resolveAccountsIdentity,
} from "./session.ts";
import type { JarvisEnv } from "./env.ts";

describe("identityFromAccountsBody", () => {
  it("reads Accounts authorization shape and uses the account as the personal org", () => {
    assert.deepEqual(
      identityFromAccountsBody({
        _id: "acc_marcelo",
        email: "marcelo@envia.com",
        first_name: "Marcelo",
      }),
      { userId: "acc_marcelo", orgId: "acc_marcelo" },
    );
  });

  it("prefers an explicit company when Accounts sends one", () => {
    assert.deepEqual(
      identityFromAccountsBody({
        account: { _id: "acc_1", company_id: "co_acme" },
      }),
      { userId: "acc_1", orgId: "co_acme" },
    );
  });

  it("reads the first companies[] entry", () => {
    assert.deepEqual(
      identityFromAccountsBody({
        user: { id: "acc_2", companies: [{ _id: "co_beta" }] },
      }),
      { userId: "acc_2", orgId: "co_beta" },
    );
  });

  it("rejects a body with no account id", () => {
    assert.throws(() => identityFromAccountsBody({ email: "x@y.z" }), {
      message: "Accounts identity missing account",
    });
  });
});

function fakeJwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `hdr.${body}.sig`;
}

const env = {
  accountsBaseUrl: "https://accounts.envia.com",
  accountsSiteId: "site_desktop",
} as JarvisEnv;

describe("extractJwtAudience", () => {
  it("reads aud from a JWT payload", () => {
    assert.equal(
      extractJwtAudience(fakeJwt({ aud: "https://accounts.envia.com" })),
      "https://accounts.envia.com",
    );
  });

  it("returns null when aud is missing", () => {
    assert.equal(extractJwtAudience(fakeJwt({ id: "acc_1" })), null);
  });
});

describe("resolveAccountsBaseUrl", () => {
  it("allows the configured host and the sandbox host", () => {
    assert.equal(
      resolveAccountsBaseUrl(env),
      "https://accounts.envia.com",
    );
    assert.equal(
      resolveAccountsBaseUrl(env, "https://accounts-sandbox.envia.com/"),
      "https://accounts-sandbox.envia.com",
    );
  });

  it("rejects an unknown host", () => {
    assert.throws(() => resolveAccountsBaseUrl(env, "https://evil.example"), {
      message: "Accounts host not allowed",
    });
  });
});

describe("resolveAccountsIdentity", () => {
  afterEach(() => {
    mock.restoreAll();
    clearAccountsIdentityCache();
  });

  it("sends Referer matching the atid audience", async () => {
    const headers: string[] = [];
    mock.method(globalThis, "fetch", async (_url: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      headers.push(h.get("Referer") ?? "");
      return new Response(JSON.stringify({ _id: "acc_1" }), { status: 200 });
    });
    const atid = fakeJwt({ aud: "https://accounts.envia.com", id: "acc_1" });
    await resolveAccountsIdentity(env, atid);
    assert.deepEqual(headers, ["https://accounts.envia.com"]);
  });

  it("uses the requested sandbox host when allowlisted", async () => {
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (url: RequestInfo | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ _id: "acc_2" }), { status: 200 });
    });
    await resolveAccountsIdentity(env, fakeJwt({ id: "acc_2" }), {
      accountsBaseUrl: "https://accounts-sandbox.envia.com",
    });
    assert.equal(
      urls[0],
      "https://accounts-sandbox.envia.com/api/accounts/authorization",
    );
  });

  it("reuses a cached identity for the same atid", async () => {
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return new Response(JSON.stringify({ _id: "acc_3" }), { status: 200 });
    });
    const atid = fakeJwt({ id: "acc_3", exp: Math.floor(Date.now() / 1000) + 3600 });
    const first = await resolveAccountsIdentity(env, atid);
    const second = await resolveAccountsIdentity(env, atid);
    assert.deepEqual(first, { userId: "acc_3", orgId: "acc_3" });
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
  });
});
