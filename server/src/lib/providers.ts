import type { CapabilityBinding, CredentialKind, ToolRisk } from "./types.ts";

export type IntegrationPurpose = "commerce" | "email" | "messaging" | "calendar" | "custom";

export type AuthField = {
  key: string;
  label: string;
  help: string;
  href?: string;
  secret?: boolean;
};

export type ProviderOAuth = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
  envClientId: string;
  envClientSecret: string;
};

export type AuthMethod = {
  kind: "oauth" | "fields";
  fields: AuthField[];
  oauth?: ProviderOAuth;
};

export type ProviderOperation = {
  toolId: string;
  risk: ToolRisk;
  binding: CapabilityBinding;
};

export type ProviderSpec = {
  id: string;
  aliases: string[];
  purposes: IntegrationPurpose[];
  origin: string | { fromField: string; template: string };
  credentialKind: CredentialKind;
  authMethods: AuthMethod[];
  operations: ProviderOperation[];
};

export type IntegrationNeed = {
  purposes: IntegrationPurpose[];
  product?: string;
};

export type ResolvedProvider = {
  spec?: ProviderSpec;
  ask?: "product";
};

const CUSTOM_FIELDS: AuthField[] = [
  {
    key: "origin",
    label: "HTTPS origin",
    help: "The API base URL, including https://, from that product’s developer settings. Do not use localhost or a private network.",
  },
  {
    key: "secret",
    label: "API token",
    secret: true,
    help: "A bearer token or API key from that product’s developer settings. Jarvis stores it sealed and never shows it again.",
  },
];

export const CUSTOM_PROVIDER: ProviderSpec = {
  id: "custom",
  aliases: ["custom", "api", "http"],
  purposes: ["custom", "commerce", "email", "messaging", "calendar"],
  origin: { fromField: "origin", template: "{origin}" },
  credentialKind: "bearer",
  authMethods: [{ kind: "fields", fields: CUSTOM_FIELDS }],
  operations: [{ toolId: "custom.request", risk: "sensitive_read", binding: { method: "GET", path: "/" } }],
};

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "shopify",
    aliases: ["shopify"],
    purposes: ["commerce"],
    origin: { fromField: "shop", template: "https://{shop}" },
    credentialKind: "bearer",
    authMethods: [
      {
        kind: "oauth",
        fields: [
          {
            key: "shop",
            label: "Shop domain",
            help: "Use your-store.myshopify.com from the admin URL. This box is not a token.",
          },
        ],
        oauth: {
          authorizeUrl: "https://{shop}/admin/oauth/authorize",
          tokenUrl: "https://{shop}/admin/oauth/access_token",
          scopes: ["read_orders", "read_customers"],
          envClientId: "JARVIS_OAUTH_SHOPIFY_CLIENT_ID",
          envClientSecret: "JARVIS_OAUTH_SHOPIFY_CLIENT_SECRET",
        },
      },
      {
        kind: "fields",
        fields: [
          {
            key: "shop",
            label: "Shop domain",
            help: "Use your-store.myshopify.com from the admin URL. This box is not a token.",
          },
          {
            key: "secret",
            label: "Admin API token",
            secret: true,
            help: "Admin → Settings → Apps and sales channels → Develop apps → Create an app → Admin API scopes read_orders and read_customers → Install → reveal Admin API access token (shown once).",
            href: "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin",
          },
        ],
      },
    ],
    operations: [
      {
        toolId: "shopify.orders.list",
        risk: "sensitive_read",
        binding: { method: "GET", path: "/admin/api/2024-10/orders.json" },
      },
      {
        toolId: "shopify.customers.list",
        risk: "sensitive_read",
        binding: { method: "GET", path: "/admin/api/2024-10/customers.json" },
      },
    ],
  },
  {
    id: "gmail",
    aliases: ["gmail", "google mail", "google email"],
    purposes: ["email"],
    origin: "https://gmail.googleapis.com",
    credentialKind: "bearer",
    authMethods: [
      {
        kind: "oauth",
        fields: [],
        oauth: {
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
          envClientId: "JARVIS_OAUTH_GMAIL_CLIENT_ID",
          envClientSecret: "JARVIS_OAUTH_GMAIL_CLIENT_SECRET",
        },
      },
      {
        kind: "fields",
        fields: [
          {
            key: "secret",
            label: "Access token",
            secret: true,
            help: "From a Google Cloud OAuth client with gmail.send. Paste an access token only if you are not using Connect with OAuth.",
            href: "https://developers.google.com/gmail/api/auth/about-auth",
          },
        ],
      },
    ],
    operations: [
      {
        toolId: "gmail.messages.send",
        risk: "external_write",
        binding: { method: "POST", path: "/gmail/v1/users/me/messages/send" },
      },
    ],
  },
  {
    id: "email",
    aliases: ["sendgrid", "mailgun"],
    purposes: ["email"],
    origin: { fromField: "origin", template: "{origin}" },
    credentialKind: "bearer",
    authMethods: [{ kind: "fields", fields: CUSTOM_FIELDS }],
    operations: [
      {
        toolId: "email.messages.send",
        risk: "external_write",
        binding: { method: "POST", path: "/send" },
      },
    ],
  },
  {
    id: "slack",
    aliases: ["slack"],
    purposes: ["messaging"],
    origin: "https://slack.com",
    credentialKind: "bearer",
    authMethods: [
      {
        kind: "oauth",
        fields: [],
        oauth: {
          authorizeUrl: "https://slack.com/oauth/v2/authorize",
          tokenUrl: "https://slack.com/api/oauth.v2.access",
          scopes: ["chat:write"],
          envClientId: "JARVIS_OAUTH_SLACK_CLIENT_ID",
          envClientSecret: "JARVIS_OAUTH_SLACK_CLIENT_SECRET",
        },
      },
      {
        kind: "fields",
        fields: [
          {
            key: "secret",
            label: "Bot token",
            secret: true,
            help: "api.slack.com → Your Apps → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-).",
            href: "https://api.slack.com/authentication/token-types#bot",
          },
        ],
      },
    ],
    operations: [
      {
        toolId: "slack.chat.post",
        risk: "external_write",
        binding: { method: "POST", path: "/api/chat.postMessage" },
      },
    ],
  },
  CUSTOM_PROVIDER,
];

const PURPOSE_WORDS: Array<{ purpose: IntegrationPurpose; pattern: RegExp }> = [
  {
    purpose: "commerce",
    pattern:
      /\b(bought|buyers|customers|orders|sales|store|shop|shopify|woocommerce|commerce)\b/i,
  },
  {
    purpose: "email",
    pattern: /\b(email|e-mail|gmail|inbox|send them)\b/i,
  },
  {
    purpose: "messaging",
    pattern: /\b(slack|whatsapp|teams|dm|direct message)\b/i,
  },
  {
    purpose: "calendar",
    pattern: /\b(calendar|schedule a meeting|book a slot)\b/i,
  },
];

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function findProviderByAlias(product: string): ProviderSpec | undefined {
  const needle = normalizeAlias(product);
  return PROVIDERS.find(
    (row) => row.id === needle || row.aliases.some((alias) => normalizeAlias(alias) === needle),
  );
}

export function providersForPurpose(purpose: IntegrationPurpose): ProviderSpec[] {
  return PROVIDERS.filter((row) => row.id !== "custom" && row.purposes.includes(purpose));
}

export function inferIntegrationNeeds(prompt: string): IntegrationNeed {
  const purposes = PURPOSE_WORDS.filter((row) => row.pattern.test(prompt)).map((row) => row.purpose);
  const unique = [...new Set(purposes)];
  const named = PROVIDERS.find((row) =>
    row.aliases.some((alias) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(prompt)),
  );
  if (named && named.id !== "custom") {
    for (const purpose of named.purposes) {
      if (purpose !== "custom" && !unique.includes(purpose)) {
        unique.push(purpose);
      }
    }
    return { purposes: unique.length > 0 ? unique : [named.purposes[0] ?? "custom"], product: named.id };
  }
  return { purposes: unique };
}

export function resolveProvider(input: { product?: string; purpose?: IntegrationPurpose }): ResolvedProvider {
  if (input.product) {
    return { spec: findProviderByAlias(input.product) ?? CUSTOM_PROVIDER };
  }
  if (input.purpose) {
    return { ask: "product" };
  }
  return { spec: CUSTOM_PROVIDER };
}

export function oauthConfigured(spec: ProviderSpec, env: Record<string, string | undefined>): boolean {
  const oauth = spec.authMethods.find((row) => row.kind === "oauth")?.oauth;
  if (!oauth) {
    return false;
  }
  return Boolean(env[oauth.envClientId]?.trim() && env[oauth.envClientSecret]?.trim());
}

export function presentedAuthMethods(
  spec: ProviderSpec,
  env: Record<string, string | undefined>,
): AuthMethod[] {
  return spec.authMethods.filter((row) => row.kind === "fields" || oauthConfigured(spec, env));
}

export function normalizePurpose(value: string | undefined): IntegrationPurpose | undefined {
  if (value === "shop") {
    return "commerce";
  }
  if (value === "outbound") {
    return "email";
  }
  if (
    value === "commerce" ||
    value === "email" ||
    value === "messaging" ||
    value === "calendar" ||
    value === "custom"
  ) {
    return value;
  }
  return undefined;
}

export function connectorMatchesPurpose(purpose: string | undefined, needed: IntegrationPurpose): boolean {
  const normalized = normalizePurpose(purpose);
  return normalized === needed;
}
