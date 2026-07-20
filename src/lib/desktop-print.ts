import { invoke } from "@tauri-apps/api/core";

export type PrinterInfo = {
  name: string;
  isDefault: boolean;
};

export async function listPrinters(): Promise<PrinterInfo[]> {
  return invoke<PrinterInfo[]>("list_printers");
}

export async function printTestPage(serviceId: string): Promise<void> {
  await invoke("print_test_page", { serviceId });
}
