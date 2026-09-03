import {
  isOpenServiceId,
  isOpenShellSectionId,
  type OpenServiceId,
  type OpenShellSectionId,
} from "@/lib/pending-open-target";

export const JARVIS_CLIENT_SERVICE_IDS = [
  "envia-shipping",
  "envia-cargo",
  "envia-fulfillment",
  "envia-wms",
  "envia-returns",
  "parapaquetes",
  "ecart-pay",
  "ecart-banking",
  "ecart-api",
  "tendencys-partners",
  "home",
  "developers",
  "settings",
  "jarvis",
  "clients",
] as const;

export type JarvisOpenServiceId = (typeof JARVIS_CLIENT_SERVICE_IDS)[number];

export type JarvisOpenTarget =
  | { kind: "service"; id: OpenServiceId }
  | { kind: "section"; id: OpenShellSectionId | "jarvis" };

/** Maps the cloud enum (including the Clients alias) onto a local product or section. */
export function resolveJarvisOpenService(serviceId: string): JarvisOpenTarget | null {
  if (serviceId === "clients") {
    return { kind: "service", id: "tendencys-partners" };
  }
  if (isOpenServiceId(serviceId)) {
    return { kind: "service", id: serviceId };
  }
  if (serviceId === "jarvis" || isOpenShellSectionId(serviceId)) {
    return { kind: "section", id: serviceId };
  }
  return null;
}

export function isJarvisOpenServiceId(value: string): value is JarvisOpenServiceId {
  return (JARVIS_CLIENT_SERVICE_IDS as readonly string[]).includes(value);
}
