import assert from "node:assert/strict";
import {
  assignSizeToPrinter,
  inchesToCatalogSizeId,
  migrateToLabelPrinterRules,
  normalizePrintSizeId,
  printerForSizeId,
  sizeIdToFamily,
} from "./label-print-size.ts";
import { normalizePrefs } from "./preferences.ts";

{
  assert.equal(normalizePrintSizeId("PAPER_8.27X11"), "PAPER_8.27X11.67");
  assert.equal(normalizePrintSizeId("paper_8.27x11.67"), "PAPER_8.27X11.67");
  assert.equal(
    normalizePrintSizeId("STOCK_4X6.75_LEFT"),
    "STOCK_4X6.75_LEADING_DOC_TAB",
  );
  assert.equal(normalizePrintSizeId("STOCK_4X6"), "STOCK_4X6");
  assert.equal(normalizePrintSizeId(""), null);
}

{
  assert.equal(sizeIdToFamily("STOCK_4X6"), "thermal_4x6");
  assert.equal(sizeIdToFamily("PAPER_LETTER"), "letter");
  assert.equal(sizeIdToFamily("PAPER_8.27X11"), "letter");
  assert.equal(sizeIdToFamily("STOCK_4X8"), "thermal_other");
}

{
  assert.equal(inchesToCatalogSizeId(4, 6), "STOCK_4X6");
  assert.equal(inchesToCatalogSizeId(8.5, 11), "PAPER_LETTER");
  assert.equal(inchesToCatalogSizeId(4, 8), null);
}

{
  const rules = migrateToLabelPrinterRules(
    { thermal_4x6: "DYMO", letter: "Brother" },
    "",
    true,
  );
  assert.equal(rules.length, 2);
  assert.ok(rules.find((r) => r.printer === "DYMO")?.sizeIds.includes("STOCK_4X6"));
  assert.ok(
    rules.find((r) => r.printer === "Brother")?.sizeIds.includes("PAPER_LETTER"),
  );
  assert.equal(printerForSizeId(rules, "STOCK_4X6", "fallback"), "DYMO");
  assert.equal(printerForSizeId(rules, "PAPER_8.27X11", "fallback"), "Brother");
  assert.equal(printerForSizeId(rules, "STOCK_4X9", "fallback"), "fallback");
}

{
  let rules = [
    { printer: "DYMO", sizeIds: ["STOCK_4X6"] },
    { printer: "Brother", sizeIds: [] as string[] },
  ];
  rules = assignSizeToPrinter(rules, "Brother", "STOCK_4X6", true);
  assert.deepEqual(rules[0].sizeIds, []);
  assert.deepEqual(rules[1].sizeIds, ["STOCK_4X6"]);
}

{
  const prefs = normalizePrefs({
    labelPrintMode: "instant",
    labelPrinter: "Brother_QL",
  });
  assert.equal(prefs.labelPrinterDefault, "Brother_QL");
  assert.ok(prefs.labelPrinterRules.some((r) => r.printer === "Brother_QL"));
  assert.ok(
    prefs.labelPrinterRules
      .find((r) => r.printer === "Brother_QL")
      ?.sizeIds.includes("STOCK_4X6"),
  );

  const withRules = normalizePrefs({
    labelPrintMode: "instant",
    labelPrinterDefault: "HP",
    labelPrinterRules: [{ printer: "DYMO", sizeIds: ["STOCK_4X6"] }],
    labelPrintersBySize: { letter: "ignored" },
  });
  assert.equal(withRules.labelPrinterDefault, "HP");
  assert.equal(withRules.labelPrinterRules.length, 1);
  assert.deepEqual(withRules.labelPrinterRules[0].sizeIds, ["STOCK_4X6"]);

  const fromBySize = normalizePrefs({
    labelPrintMode: "instant",
    labelPrinter: "legacy",
    labelPrintersBySize: { letter: "HP_Laser" },
  });
  assert.equal(fromBySize.labelPrinterDefault, "legacy");
  assert.ok(
    fromBySize.labelPrinterRules
      .find((r) => r.printer === "HP_Laser")
      ?.sizeIds.includes("PAPER_LETTER"),
  );
}
