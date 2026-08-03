import {
  CATALOG_PRINT_SIZE_IDS,
  LETTER_SIZE_IDS,
  THERMAL_4X6_SIZE_IDS,
  thermalOtherSizeIds,
} from "@/config/catalog-print-sizes";

/** @deprecated Kept for migration from older prefs only. */
export type LabelSizeFamily = "thermal_4x6" | "thermal_other" | "letter";

/** @deprecated Kept for migration from older prefs only. */
export type LabelPrintersBySize = Partial<Record<LabelSizeFamily, string>>;

export type PrinterRule = {
  printer: string;
  sizeIds: string[];
};

/**
 * Normalize Shipping / Packages size ids so aliases match catalog checkboxes
 * (e.g. truncated A4 id → `PAPER_8.27X11.67`).
 */
export function normalizePrintSizeId(
  sizeId: string | null | undefined,
): string | null {
  if (!sizeId || typeof sizeId !== "string") {
    return null;
  }
  const id = sizeId.trim().toUpperCase();
  if (!id) {
    return null;
  }
  if (id === "PAPER_8.27X11" || id.startsWith("PAPER_8.27X11.")) {
    return "PAPER_8.27X11.67";
  }
  if (id.startsWith("STOCK_4X6.75")) {
    return "STOCK_4X6.75_LEADING_DOC_TAB";
  }
  return id;
}

/**
 * Map a Shipping `catalog_print_sizes` id to a legacy size family (migration).
 */
export function sizeIdToFamily(
  sizeId: string | null | undefined,
): LabelSizeFamily | null {
  const id = normalizePrintSizeId(sizeId);
  if (!id) {
    return null;
  }
  if ((THERMAL_4X6_SIZE_IDS as readonly string[]).includes(id)) {
    return "thermal_4x6";
  }
  if ((LETTER_SIZE_IDS as readonly string[]).includes(id)) {
    return "letter";
  }
  if (id.startsWith("STOCK_") || id.startsWith("PAPER_")) {
    return "thermal_other";
  }
  return null;
}

/** Classify a PDF page size in inches (either orientation) → catalog id. */
export function inchesToCatalogSizeId(
  widthIn: number,
  heightIn: number,
): string | null {
  const short = Math.min(widthIn, heightIn);
  const long = Math.max(widthIn, heightIn);
  if (short >= 3.5 && short <= 4.75 && long >= 5.0 && long <= 7.25) {
    return "STOCK_4X6";
  }
  if (short >= 8.0 && short <= 8.7 && long >= 10.5 && long <= 12.0) {
    return "PAPER_LETTER";
  }
  return null;
}

function migrateLabelPrintersBySize(
  bySize: LabelPrintersBySize | null | undefined,
  labelPrinter: string,
): LabelPrintersBySize {
  const next: LabelPrintersBySize = { ...(bySize ?? {}) };
  if (!next.thermal_4x6 && labelPrinter) {
    next.thermal_4x6 = labelPrinter;
  }
  return next;
}

function sizeIdsForFamily(family: LabelSizeFamily): string[] {
  if (family === "thermal_4x6") {
    return [...THERMAL_4X6_SIZE_IDS];
  }
  if (family === "letter") {
    return [...LETTER_SIZE_IDS];
  }
  return thermalOtherSizeIds();
}

/**
 * Build Instant printer rules from legacy `labelPrintersBySize` (+ optional
 * single `labelPrinter` when the by-size map was never saved).
 */
export function migrateToLabelPrinterRules(
  bySize: LabelPrintersBySize | null | undefined,
  labelPrinter: string,
  hadBySize: boolean,
): PrinterRule[] {
  const map = hadBySize
    ? { ...(bySize ?? {}) }
    : migrateLabelPrintersBySize(bySize, labelPrinter);

  const byPrinter = new Map<string, Set<string>>();
  for (const family of ["thermal_4x6", "thermal_other", "letter"] as const) {
    const printer = map[family]?.trim();
    if (!printer) {
      continue;
    }
    let set = byPrinter.get(printer);
    if (!set) {
      set = new Set();
      byPrinter.set(printer, set);
    }
    for (const sizeId of sizeIdsForFamily(family)) {
      set.add(sizeId);
    }
  }

  return [...byPrinter.entries()].map(([printer, sizeIds]) => ({
    printer,
    sizeIds: [...sizeIds].sort(),
  }));
}

export function normalizePrinterRules(raw: unknown): PrinterRule[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: PrinterRule[] = [];
  const seenPrinters = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const obj = entry as Record<string, unknown>;
    const printer = typeof obj.printer === "string" ? obj.printer.trim() : "";
    if (!printer || seenPrinters.has(printer)) {
      continue;
    }
    seenPrinters.add(printer);
    const sizeIdsRaw = Array.isArray(obj.sizeIds) ? obj.sizeIds : [];
    const sizeIds: string[] = [];
    const seenSizes = new Set<string>();
    for (const value of sizeIdsRaw) {
      const normalized = normalizePrintSizeId(
        typeof value === "string" ? value : null,
      );
      if (!normalized || seenSizes.has(normalized)) {
        continue;
      }
      if (
        !(CATALOG_PRINT_SIZE_IDS as readonly string[]).includes(normalized) &&
        !normalized.startsWith("STOCK_") &&
        !normalized.startsWith("PAPER_")
      ) {
        continue;
      }
      seenSizes.add(normalized);
      sizeIds.push(normalized);
    }
    out.push({ printer, sizeIds });
  }
  return out;
}

/**
 * Assign a catalog size to one printer (exclusive across rules).
 */
export function assignSizeToPrinter(
  rules: PrinterRule[],
  printer: string,
  sizeId: string,
  checked: boolean,
): PrinterRule[] {
  const normalized = normalizePrintSizeId(sizeId);
  if (!normalized || !printer.trim()) {
    return rules;
  }
  return rules.map((rule) => {
    const without = rule.sizeIds.filter((id) => id !== normalized);
    if (rule.printer !== printer) {
      return { ...rule, sizeIds: without };
    }
    if (!checked) {
      return { ...rule, sizeIds: without };
    }
    return { ...rule, sizeIds: [...without, normalized].sort() };
  });
}

/**
 * Resolve OS printer for a catalog size id.
 * Match → that printer; miss / unknown → defaultPrinter (empty = OS default).
 */
export function printerForSizeId(
  rules: PrinterRule[] | null | undefined,
  sizeId: string | null | undefined,
  defaultPrinter: string,
): string {
  const normalized = normalizePrintSizeId(sizeId);
  if (normalized) {
    for (const rule of rules ?? []) {
      if (rule.sizeIds.includes(normalized) && rule.printer.trim()) {
        return rule.printer;
      }
    }
  }
  return defaultPrinter;
}
