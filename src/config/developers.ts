/**
 * Developer / API surfaces shown in the native Developers hub.
 * Docs open in the system browser; actionPath deep-links into product webviews.
 */

export type DeveloperSurfaceStatus = "live" | "coming_soon";

export type DeveloperActionKind = "manage_keys" | "open_dashboard";

export type DeveloperSurface = {
  id: string;
  /** Matches ServiceDefinition.icon when the surface maps to a rail product. */
  icon: string;
  accentColor: string;
  status: DeveloperSurfaceStatus;
  /** SERVICE id for in-shell navigation; omit when there is no product action. */
  serviceId?: string;
  docsUrl?: string;
  /** Path inside the product webview for the primary in-shell CTA. */
  actionPath?: string;
  actionKind?: DeveloperActionKind;
};

export const DEVELOPER_SURFACES: DeveloperSurface[] = [
  {
    id: "envia-shipping",
    icon: "shipping",
    accentColor: "#0066CC",
    status: "live",
    serviceId: "envia-shipping",
    docsUrl:
      import.meta.env.VITE_ENVIA_DOCS_URL || "https://docs.envia.com",
    actionPath: "/settings/developers",
    actionKind: "manage_keys",
  },
  {
    id: "ecart-api",
    icon: "ecart-api",
    accentColor: "#0D9488",
    status: "live",
    serviceId: "ecart-api",
    docsUrl:
      import.meta.env.VITE_ECART_API_DOCS_URL || "https://docs.ecartapi.com",
    actionPath: "/dashboard/apps",
    actionKind: "open_dashboard",
  },
  {
    id: "envia-fulfillment",
    icon: "fulfillment",
    accentColor: "#2B6CB0",
    status: "live",
    docsUrl:
      import.meta.env.VITE_ENVIA_FULFILLMENT_DOCS_URL ||
      "https://api.fulfillment.envia.com/",
  },
  {
    id: "ecart-pay",
    icon: "ecart-pay",
    accentColor: "#38A169",
    status: "live",
    serviceId: "ecart-pay",
    docsUrl:
      import.meta.env.VITE_ECART_PAY_DOCS_URL || "https://docs.ecartpay.com",
    actionPath: "/dashboard/api/credentials",
    actionKind: "manage_keys",
  },
  {
    id: "envia-cargo",
    icon: "cargo",
    accentColor: "#1A365D",
    status: "live",
    serviceId: "envia-cargo",
    docsUrl:
      import.meta.env.VITE_ENVIA_CARGO_DOCS_URL ||
      "https://api.cargo.envia.com/api/docs",
    actionPath: "/en/carrier/api-keys",
    actionKind: "manage_keys",
  },
  {
    id: "envia-returns",
    icon: "returns",
    accentColor: "#DD6B20",
    status: "coming_soon",
    docsUrl:
      import.meta.env.VITE_ENVIA_DOCS_URL || "https://docs.envia.com",
  },
  {
    id: "ecart-banking",
    icon: "ecart-banking",
    accentColor: "#1A202C",
    status: "live",
    serviceId: "ecart-banking",
    actionPath: "/dashboard/dev-tools",
    actionKind: "open_dashboard",
  },
];
