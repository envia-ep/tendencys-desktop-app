import assert from "node:assert/strict";
import { dedupeAccountsByEmail, type PersistedAccountSlot } from "./token-store.ts";

function slot(
  id: string,
  email: string,
  expiresAt = 1,
): PersistedAccountSlot {
  return {
    account: { id, email, firstName: "A", lastName: "B" },
    expiresAt,
  };
}

{
  const out = dedupeAccountsByEmail(
    [
      slot("id-old", "marcelo@envia.com", 100),
      slot("id-new", "marcelo@envia.com", 200),
      slot("id-other", "marcelo@tendencys.com", 150),
    ],
    "id-new",
  );
  assert.equal(out.length, 2);
  assert.equal(
    out.find((s) => s.account.email === "marcelo@envia.com")?.account.id,
    "id-new",
  );
  assert.ok(out.some((s) => s.account.id === "id-other"));
}

{
  // Prefer preferredAccountId even when expiresAt is older.
  const out = dedupeAccountsByEmail(
    [
      slot("keep", "a@x.com", 1),
      slot("drop", "a@x.com", 999),
    ],
    "keep",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].account.id, "keep");
}

{
  // Case-insensitive email match.
  const out = dedupeAccountsByEmail([
    slot("a", "Foo@Example.com", 1),
    slot("b", "foo@example.com", 2),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].account.id, "b");
}

console.log("token-store.test.ts: ok");
