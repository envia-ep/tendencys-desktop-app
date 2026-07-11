export type QuickLink = {
  label: string;
  path: string;
};

/**
 * How the desktop shell authenticates into this product after shell login.
 * - login-sites: Accounts `/login-sites` with this siteId (Cargo, Fulfillment, Shipping, Ecart Pay, Banking)
 * - server-entry: product server builds Accounts redirect (legacy; prefer login-sites when callback exists)
 * - unsupported: no Accounts SSO yet (WMS) — open product URL only
 */
export type ServiceAuthMode = "login-sites" | "server-entry" | "unsupported";

export type ServiceDefinition = {
  id: string;
  name: string;
  url: string;
  siteId: string;
  icon: string;
  accentColor: string;
  quickLinks: QuickLink[];
  authMode: ServiceAuthMode;
  /** Path Accounts redirects to after SSO (must be whitelisted on the product site). */
  authCallbackPath: string;
  /** For server-entry: product route that starts Accounts login. */
  serverEntryPath?: string;
  /**
   * Whether the product's `authCallbackPath` actually accepts the Accounts
   * `?authorization=` handoff yet. When false the shell must not drive SSO/pre-warm
   * (it would land on a missing route). Defaults to true.
   */
  ssoReady?: boolean;
};

export const SERVICES: ServiceDefinition[] = [
  {
    id: "envia-shipping",
    name: "Envia Shipping",
    url:
      import.meta.env.VITE_ENVIA_SHIPPING_URL ||
      "https://shipping.envia.com",
    siteId:
      import.meta.env.VITE_ENVIA_SHIPPING_SITE_ID ||
      "62f1259459ad8b9e8dc0b85c",
    icon: "shipping",
    accentColor: "#0066CC",
    authMode: "login-sites",
    authCallbackPath: "/authentication",
    // GAP: envia-clients still uses the legacy PHP `u_t_e.com` cookie and has no
    // `/authentication` route, so the Accounts handoff has nowhere to land yet.
    ssoReady: false,
    quickLinks: [
      { label: "Dashboard", path: "/" },
      { label: "Shipments", path: "/shipments" },
      { label: "Settings", path: "/settings" },
    ],
  },
  {
    id: "envia-cargo",
    name: "Envia Cargo",
    url: import.meta.env.VITE_ENVIA_CARGO_URL || "https://cargo.envia.com",
    siteId:
      import.meta.env.VITE_ENVIA_CARGO_SITE_ID || "69390d0f1000c02033074ca6",
    icon: "cargo",
    accentColor: "#1A365D",
    authMode: "login-sites",
    authCallbackPath: "/authentication",
    quickLinks: [
      { label: "Dashboard", path: "/" },
      { label: "Loads", path: "/loads" },
      { label: "Settings", path: "/settings" },
    ],
  },
  {
    id: "envia-fulfillment",
    name: "Envia Fulfillment",
    url:
      import.meta.env.VITE_ENVIA_FULFILLMENT_URL ||
      "https://fulfillment.envia.com",
    siteId:
      import.meta.env.VITE_ENVIA_FULFILLMENT_SITE_ID ||
      "65a6de68d6dcf23d52936fcf",
    icon: "fulfillment",
    accentColor: "#2B6CB0",
    authMode: "login-sites",
    authCallbackPath: "/authentication",
    quickLinks: [
      { label: "Dashboard", path: "/" },
      { label: "Inventory", path: "/inventory" },
      { label: "Orders", path: "/orders" },
    ],
  },
  {
    id: "envia-returns",
    name: "Envia Returns",
    url: import.meta.env.VITE_ENVIA_RETURNS_URL || "https://returns.envia.com",
    siteId:
      import.meta.env.VITE_ENVIA_RETURNS_SITE_ID ||
      "60f60b20f3e511efd1d6f28c",
    icon: "returns",
    accentColor: "#DD6B20",
    authMode: "login-sites",
    authCallbackPath: "/authentication",
    quickLinks: [
      { label: "Dashboard", path: "/" },
      { label: "Settings", path: "/settings" },
    ],
  },
  {
    id: "parapaquetes",
    name: "Parapaquetes",
    url: import.meta.env.VITE_PARAPAQUETES_URL || "https://parapaquetes.com",
    siteId: "",
    icon: "parapaquetes",
    accentColor: "#805AD5",
    // Doesn't use Accounts — open the site directly, no SSO handoff.
    authMode: "unsupported",
    authCallbackPath: "",
    quickLinks: [],
  },
  {
    id: "ecart-pay",
    name: "Ecart Pay",
    // Must equal ecart-payment's HOSTNAME (`https://app.ecart.com`) — the origin
    // used for the handoff JWT `aud` (from `redirect_url`), the `referer`
    // ecart-payment sends to Accounts when exchanging the handoff, and the `_tid`
    // audience checked on every API call. Using `ecartpay.com` here makes
    // `aud != HOSTNAME`, so Accounts rejects the exchange ("token is not valid").
    url: import.meta.env.VITE_ECART_PAY_URL || "https://app.ecart.com",
    siteId:
      import.meta.env.VITE_ECART_PAY_SITE_ID || "60e778d10a598b653ae466d8",
    icon: "ecart-pay",
    accentColor: "#38A169",
    // `/authentication` accepts the Accounts `?authorization=` handoff. Drive
    // silent SSO via `/login-sites` + shared `_atid` instead of product `/login`
    // (server-entry), which redirects to Accounts interactive `/login` with a
    // legacy site_id and lands on app.ecart.com — blank/broken in the shell.
    authMode: "login-sites",
    authCallbackPath: "/authentication",
    quickLinks: [
      { label: "Dashboard", path: "/" },
      { label: "Transactions", path: "/transactions" },
      { label: "Settings", path: "/settings" },
    ],
  },
  {
    id: "ecart-banking",
    name: "Ecart Banking",
    url:
      import.meta.env.VITE_ECART_BANKING_URL || "https://bank.ecart.com",
    siteId:
      import.meta.env.VITE_ECART_BANKING_SITE_ID ||
      "699e00dccfd0922c0b0e50d6",
    icon: "ecart-banking",
    accentColor: "#1A202C",
    // `/api/auth/callback` accepts the Accounts `?authorization=` handoff, so drive
    // it via `/login-sites` for a silent handoff using the shared `_atid` instead
    // of `/api/auth/login` (which bounces to the interactive Accounts form).
    // Prereq: banking site_id + this callback must be in the accounts.envia.com allowlist.
    authMode: "login-sites",
    authCallbackPath: "/api/auth/callback",
    quickLinks: [
      { label: "Dashboard", path: "/dashboard" },
      { label: "Accounts", path: "/accounts" },
      { label: "Settings", path: "/settings" },
    ],
  },
  {
    id: "ecart-api",
    name: "Ecart API",
    // Must equal the ecartapi-dashboard deployment's `API_BASE`
    // (`https://app.ecartapi.com`) — the origin used for the handoff JWT `aud`
    // (from `redirect_url`) and the `Referer` the dashboard sends to Accounts when
    // exchanging the handoff via `/api/auth/validate`. Using the marketing host
    // `ecartapi.com` makes `aud != API_BASE` (and 404s), so Accounts rejects the
    // exchange ("token is not valid"). The dashboard exchanges against
    // `accounts.ecartapi.com`, which shares the same `ecartdb` as the shell's
    // `accounts.ecart.com`, so the login-sites handoff validates.
    url: import.meta.env.VITE_ECART_API_URL || "https://app.ecartapi.com",
    siteId:
      import.meta.env.VITE_ECART_API_SITE_ID || "696695a6ae23f53b010f5b16",
    icon: "ecart-api",
    accentColor: "#0D9488",
    // `/authentication` (Nuxt page in ecartapi-dashboard) accepts the Accounts
    // `?authorization=` handoff and exchanges it for the product session.
    authMode: "login-sites",
    authCallbackPath: "/authentication",
    quickLinks: [
      { label: "Dashboard", path: "/dashboard" },
      { label: "Apps", path: "/dashboard/apps" },
      { label: "Settings", path: "/dashboard/settings" },
    ],
  },
  {
    id: "tendencys-partners",
    name: "Tendencys Partners",
    url:
      import.meta.env.VITE_TENDENCYS_PARTNERS_URL ||
      "https://partners.tendencys.com",
    siteId:
      import.meta.env.VITE_TENDENCYS_PARTNERS_SITE_ID ||
      "6a3b5bb1b1b2e322b10d86b3",
    icon: "partners",
    accentColor: "#6B46C1",
    authMode: "login-sites",
    authCallbackPath: "/authentication",
    quickLinks: [
      { label: "Dashboard", path: "/" },
      { label: "Settings", path: "/settings" },
    ],
  },
];

export function getServiceById(id: string): ServiceDefinition | undefined {
  return SERVICES.find((service) => service.id === id);
}

/** First product that can run Accounts SSO on first paint (skip Shipping/API gaps). */
export function getDefaultService(): ServiceDefinition {
  return (
    SERVICES.find(
      (s) => s.authMode !== "unsupported" && s.ssoReady !== false,
    ) ?? SERVICES[0]
  );
}
