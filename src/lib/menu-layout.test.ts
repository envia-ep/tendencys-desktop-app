import assert from "node:assert/strict";
import type { ServiceDefinition } from "../config/services.ts";
import {
  addCustomToLayout,
  composeMenuServices,
  customItemToService,
  isCustomMenuId,
  normalizeCustomMenuInput,
  normalizeMenuLayout,
  removeCustomFromLayout,
  resolveServiceById,
  updateCustomInLayout,
  withMenuOrder,
  type MenuLayout,
} from "./menu-layout.ts";

function fakeService(id: string, name = id): ServiceDefinition {
  return {
    id,
    name,
    url: `https://example.com/${id}`,
    siteId: "site",
    icon: "shipping",
    accentColor: "#000",
    quickLinks: [],
    authMode: "login-sites",
    authCallbackPath: "/authentication",
  };
}

const catalog = [fakeService("a"), fakeService("b"), fakeService("c")];

// URL validation
assert.equal(normalizeCustomMenuInput("", "https://x.com"), null);
assert.equal(normalizeCustomMenuInput("Docs", "not-a-url"), null);
assert.equal(normalizeCustomMenuInput("Docs", "ftp://x.com"), null);
assert.deepEqual(normalizeCustomMenuInput("  Docs  ", "  https://x.com/path  "), {
  name: "Docs",
  url: "https://x.com/path",
});
assert.ok(normalizeCustomMenuInput("Local", "http://localhost:3000"));

// Custom id helper
assert.equal(isCustomMenuId("custom-abc"), true);
assert.equal(isCustomMenuId("envia-shipping"), false);

// Normalize layout drops bad rows
assert.deepEqual(
  normalizeMenuLayout({
    order: ["a", "", 1, "custom-1"],
    customItems: [
      { id: "custom-1", name: "One", url: "https://one.test" },
      { id: "bad", name: "No", url: "https://no.test" },
      { id: "custom-2", name: "", url: "https://two.test" },
    ],
  }),
  {
    order: ["a", "custom-1"],
    customItems: [{ id: "custom-1", name: "One", url: "https://one.test/" }],
  },
);

// Compose: empty order = catalog then customs not in order
{
  const layout: MenuLayout = {
    order: [],
    customItems: [{ id: "custom-1", name: "One", url: "https://one.test/" }],
  };
  const composed = composeMenuServices(catalog, layout);
  assert.deepEqual(
    composed.map((s) => s.id),
    ["a", "b", "c", "custom-1"],
  );
  assert.equal(composed[3]?.authMode, "unsupported");
}

// Compose: honor order, skip orphans, place new catalog ids after predecessors
{
  const layout: MenuLayout = {
    order: ["custom-1", "b", "gone", "a"],
    customItems: [{ id: "custom-1", name: "One", url: "https://one.test/" }],
  };
  const composed = composeMenuServices(catalog, layout);
  assert.deepEqual(
    composed.map((s) => s.id),
    ["custom-1", "b", "a", "c"],
  );
}

// Compose: new mid-catalog id slots after its predecessor, not after customs
{
  const midCatalog = [
    fakeService("fulfillment"),
    fakeService("wms"),
    fakeService("returns"),
  ];
  const layout: MenuLayout = {
    order: ["fulfillment", "returns", "custom-admon"],
    customItems: [
      { id: "custom-admon", name: "Admon", url: "https://admon.test/" },
    ],
  };
  const composed = composeMenuServices(midCatalog, layout);
  assert.deepEqual(
    composed.map((s) => s.id),
    ["fulfillment", "wms", "returns", "custom-admon"],
  );
}

// customItemToService shape
{
  const service = customItemToService({
    id: "custom-x",
    name: "X",
    url: "https://x.test/",
  });
  assert.equal(service.authMode, "unsupported");
  assert.equal(service.icon, "custom");
  assert.equal(service.siteId, "");
}

// resolveServiceById
{
  const layout: MenuLayout = {
    order: [],
    customItems: [{ id: "custom-1", name: "One", url: "https://one.test/" }],
  };
  const getBuiltIn = (id: string) => catalog.find((s) => s.id === id);
  assert.equal(resolveServiceById("custom-1", layout, getBuiltIn)?.name, "One");
  assert.equal(resolveServiceById("a", layout, getBuiltIn)?.name, "a");
  assert.equal(resolveServiceById("missing", layout, getBuiltIn), undefined);
}

// Mutators
{
  let layout: MenuLayout = { order: ["a", "b"], customItems: [] };
  layout = withMenuOrder(layout, ["b", "a"]);
  assert.deepEqual(layout.order, ["b", "a"]);

  const item = { id: "custom-1", name: "One", url: "https://one.test/" };
  layout = addCustomToLayout(layout, item, ["a", "b"]);
  assert.deepEqual(layout.order, ["b", "a", "custom-1"]);
  assert.equal(layout.customItems.length, 1);

  layout = updateCustomInLayout(layout, "custom-1", {
    name: "Two",
    url: "https://two.test/",
  });
  assert.equal(layout.customItems[0]?.name, "Two");

  layout = removeCustomFromLayout(layout, "custom-1");
  assert.deepEqual(layout.order, ["b", "a"]);
  assert.equal(layout.customItems.length, 0);
}

console.log("menu-layout: ok");
