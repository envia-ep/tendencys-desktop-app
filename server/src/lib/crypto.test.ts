import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateVaultKey,
  openSecret,
  parseVaultKey,
  sealSecret,
  timingSafeEqualText,
} from "./crypto.ts";

describe("vault envelope", () => {
  it("round-trips and binds AAD to the row", () => {
    const master = generateVaultKey();
    const sealed = sealSecret({
      plaintext: "shpat_secret_token",
      masterKey: master,
      orgId: "org_acme",
      recordId: "crd_1",
      kind: "bearer",
    });
    assert.equal(JSON.parse(sealed).alg, "aes-256-gcm");
    assert.equal(sealed.includes("shpat_secret_token"), false);
    assert.equal(
      openSecret({
        sealed,
        masterKey: master,
        orgId: "org_acme",
        recordId: "crd_1",
        kind: "bearer",
        keyVersion: 1,
      }),
      "shpat_secret_token",
    );
    assert.throws(() =>
      openSecret({
        sealed,
        masterKey: master,
        orgId: "org_acme",
        recordId: "crd_other",
        kind: "bearer",
        keyVersion: 1,
      }),
    );
    assert.throws(() =>
      openSecret({
        sealed,
        masterKey: generateVaultKey(),
        orgId: "org_acme",
        recordId: "crd_1",
        kind: "bearer",
        keyVersion: 1,
      }),
    );
  });

  it("opens with the previous key after rotation", () => {
    const previous = generateVaultKey();
    const current = generateVaultKey();
    const sealed = sealSecret({
      plaintext: "old",
      masterKey: previous,
      orgId: "org_acme",
      recordId: "crd_1",
      kind: "bearer",
      keyVersion: 1,
    });
    assert.equal(
      openSecret({
        sealed,
        masterKey: current,
        previousKey: previous,
        orgId: "org_acme",
        recordId: "crd_1",
        kind: "bearer",
        keyVersion: 1,
      }),
      "old",
    );
  });

  it("rejects a short vault key", () => {
    assert.throws(() => parseVaultKey("too-short"));
  });

  it("compares webhook signatures in constant time", () => {
    assert.equal(timingSafeEqualText("abc", "abc"), true);
    assert.equal(timingSafeEqualText("abc", "abd"), false);
  });
});
