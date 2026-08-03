/**
 * Embedded `catalog_print_sizes` (queries DB). Keep in sync when Shipping
 * Packages adds sizes. Excludes the legacy `test` row.
 */
export type CatalogPrintSize = {
  id: string;
  description: string;
};

export const CATALOG_PRINT_SIZES: readonly CatalogPrintSize[] = [
  { id: "PAPER_4X6", description: "4 x 6" },
  { id: "PAPER_4X8", description: "4 x 8" },
  { id: "PAPER_7X4.75", description: "7 x 4.75" },
  { id: "PAPER_8.27X11.67", description: "A4" },
  { id: "PAPER_8.5X11", description: "8.5 x 11" },
  { id: "PAPER_8.5X11_BOTTOM_HALF_LABEL", description: "8.5 x 11 Label bottom" },
  { id: "PAPER_85X11_TOP_HALF_LABEL", description: "8.5 x 11 Label top" },
  { id: "PAPER_LETTER", description: "Letter-size" },
  { id: "STOCK_2.4X6", description: "2.4 x 6" },
  { id: "STOCK_2.9X5", description: "2.9 x 5" },
  { id: "STOCK_2X7", description: "2 x 7" },
  { id: "STOCK_3.8X4.2", description: "3.8 X 4.2" },
  { id: "STOCK_3.9X2.3", description: "3.9 x 2.3" },
  { id: "STOCK_3.9X3.9", description: "3.9 x 3.9" },
  { id: "STOCK_3.9X4.3", description: "3.9 x 4.3" },
  { id: "STOCK_3.9X7", description: "3.9 x 7" },
  { id: "STOCK_3X5", description: "3 x 5" },
  { id: "STOCK_4.2X4.4", description: "4.2 x 4.4" },
  { id: "STOCK_4X4", description: "4 x 4" },
  { id: "STOCK_4X5", description: "4 x 5" },
  { id: "STOCK_4X6", description: "4 x 6" },
  { id: "STOCK_4X6.5", description: "4 x 6.5" },
  { id: "STOCK_4X6.75_LEADING_DOC_TAB", description: "4 x 6.75 leading doc tab" },
  { id: "STOCK_4X7.5", description: "4 x 7.5" },
  { id: "STOCK_4X8", description: "4 x 8" },
  { id: "STOCK_4X9", description: "4 x 9" },
] as const;

export const CATALOG_PRINT_SIZE_IDS: readonly string[] = CATALOG_PRINT_SIZES.map(
  (row) => row.id,
);

/** Family → catalog ids used when migrating legacy `labelPrintersBySize`. */
export const THERMAL_4X6_SIZE_IDS: readonly string[] = [
  "STOCK_4X6",
  "PAPER_4X6",
  "STOCK_4X5",
  "STOCK_4X6.5",
  "STOCK_4X6.75_LEADING_DOC_TAB",
];

export const LETTER_SIZE_IDS: readonly string[] = [
  "PAPER_LETTER",
  "PAPER_8.5X11",
  "PAPER_8.5X11_BOTTOM_HALF_LABEL",
  "PAPER_85X11_TOP_HALF_LABEL",
  "PAPER_8.27X11.67",
];

export function thermalOtherSizeIds(): string[] {
  const claimed = new Set([...THERMAL_4X6_SIZE_IDS, ...LETTER_SIZE_IDS]);
  return CATALOG_PRINT_SIZE_IDS.filter((id) => !claimed.has(id));
}
