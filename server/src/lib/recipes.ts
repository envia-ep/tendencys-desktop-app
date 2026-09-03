import type { JarvisEnv } from "./env.ts";
import { completeModel } from "./model.ts";
import {
  CUSTOM_PROVIDER,
  findProviderByAlias,
  oauthConfigured,
  providersForPurpose,
  type IntegrationPurpose,
  type ProviderOperation,
  type ProviderSpec,
} from "./providers.ts";
import type { JarvisStore } from "./store.ts";
import { searchWeb, type SearchWebDeps } from "./web-search.ts";
import type {
  CredentialKind,
  IntegrationDraft,
  IntegrationRecipe,
  RecipeAuthKind,
  RecipeField,
  RecipeOperation,
} from "./types.ts";

function nowIso(): string {
  return new Date().toISOString();
}

function titleCase(value: string): string {
  return value
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || value;
}

/**
 * Client credentials a user supplies for the last-resort case: a spec that only
 * offers OAuth (no self-serve token method) and whose OAuth app the platform has
 * not pre-configured. Normal specs never ask the customer for these — see
 * {@link catalogRecipe}.
 */
const OAUTH_CLIENT_ID_FIELD: RecipeField = {
  key: "clientId",
  label: "OAuth client ID",
  help: "Create an OAuth client in the product's developer console (redirect back to Jarvis) and paste its client ID here.",
};

const OAUTH_CLIENT_SECRET_FIELD: RecipeField = {
  key: "clientSecret",
  label: "OAuth client secret",
  secret: true,
  help: "The client secret paired with the client ID above. Jarvis stores it sealed and never shows it again.",
};

/** Map a sealed CredentialKind to the recipe's non-OAuth auth kind. */
function recipeKindFor(kind: CredentialKind): RecipeAuthKind {
  if (kind === "basic" || kind === "header_map" || kind === "mcp" || kind === "bearer") {
    return kind;
  }
  return "header_map";
}

function bindingToRecipeOp(op: ProviderOperation): RecipeOperation {
  const mcpName = op.binding.mcpName;
  if (mcpName) {
    return { toolId: op.toolId, method: "MCP", path: mcpName, risk: op.risk };
  }
  return {
    toolId: op.toolId,
    method: (op.binding.method ?? "GET").toUpperCase(),
    path: op.binding.path ?? "/",
    risk: op.risk,
  };
}

function collectDocs(spec: ProviderSpec): Array<{ title: string; url: string }> {
  const docs: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const method of spec.authMethods) {
    for (const field of method.fields) {
      if (field.href && !seen.has(field.href)) {
        seen.add(field.href);
        docs.push({ title: field.label, url: field.href });
      }
    }
  }
  return docs;
}

function buildSteps(fields: RecipeField[], useOauth: boolean, oauthPreconfigured: boolean): string[] {
  const steps: string[] = [];
  for (const field of fields) {
    steps.push(`${field.label}: ${field.help}`);
  }
  if (useOauth) {
    steps.push(
      oauthPreconfigured
        ? "Click Connect with OAuth and approve the requested access."
        : "Enter the OAuth client ID and secret above, then click Connect with OAuth and approve access.",
    );
  } else {
    steps.push("Enter the values above and connect. Jarvis validates the connection before saving.");
  }
  return steps;
}

/**
 * Derive a proven "how to connect" recipe from a catalog {@link ProviderSpec}.
 *
 * Recommends the auth method the customer can actually complete on their own:
 * - OAuth one-click ONLY when the platform has the OAuth app configured
 *   ({@link oauthConfigured}) — the customer just authorizes, no client id/secret.
 * - Otherwise the self-serve `fields` method (API key / token / bot token). OAuth
 *   is dropped from the recommendation because obtaining it would require the
 *   customer to register a developer OAuth app.
 * - Last resort (spec has no self-serve method and OAuth is not configured): OAuth
 *   with a bring-your-own client id/secret and honest steps.
 */
export function catalogRecipe(
  spec: ProviderSpec,
  env: Record<string, string | undefined> = {},
): IntegrationRecipe {
  const oauthMethod = spec.authMethods.find((method) => method.kind === "oauth");
  const fieldsMethod = spec.authMethods.find((method) => method.kind === "fields");
  const purpose = (spec.purposes[0] as IntegrationPurpose | undefined) ?? "custom";
  const baseUrl = typeof spec.origin === "string" ? spec.origin : null;
  const docs = collectDocs(spec);
  const operations = spec.operations.map(bindingToRecipeOp);
  const base = {
    slug: spec.id,
    displayName: titleCase(spec.id),
    aliases: spec.aliases,
    purpose,
    baseUrl,
    docs,
    operations,
    credentialKind: spec.credentialKind,
    source: "catalog" as const,
    successCount: 0,
    lastUsedAt: null,
    updatedAt: nowIso(),
  };

  // OAuth one-click: only when the platform already registered the OAuth app.
  if (oauthMethod?.oauth && oauthConfigured(spec, env)) {
    const requiredFields: RecipeField[] = [...oauthMethod.fields];
    return {
      ...base,
      recommendedAuth: {
        kind: "oauth",
        oauth: {
          authorizeUrl: oauthMethod.oauth.authorizeUrl,
          tokenUrl: oauthMethod.oauth.tokenUrl,
          scopes: oauthMethod.oauth.scopes,
        },
      },
      requiredFields,
      fallbackAuth: fieldsMethod
        ? { auth: { kind: recipeKindFor(spec.credentialKind) }, fields: fieldsMethod.fields }
        : null,
      steps: buildSteps(requiredFields, true, true),
      confidence: 0.95,
    };
  }

  // Self-serve method the customer can complete alone (no developer OAuth app).
  if (fieldsMethod) {
    const requiredFields = fieldsMethod.fields;
    return {
      ...base,
      recommendedAuth: { kind: recipeKindFor(spec.credentialKind) },
      requiredFields,
      fallbackAuth: null,
      steps: buildSteps(requiredFields, false, false),
      confidence: 0.9,
    };
  }

  // Last resort: OAuth-only spec with no configured app — ask for a bring-your-own client.
  if (oauthMethod?.oauth) {
    const requiredFields: RecipeField[] = [
      ...oauthMethod.fields,
      OAUTH_CLIENT_ID_FIELD,
      OAUTH_CLIENT_SECRET_FIELD,
    ];
    return {
      ...base,
      recommendedAuth: {
        kind: "oauth",
        oauth: {
          authorizeUrl: oauthMethod.oauth.authorizeUrl,
          tokenUrl: oauthMethod.oauth.tokenUrl,
          scopes: oauthMethod.oauth.scopes,
        },
      },
      requiredFields,
      fallbackAuth: null,
      steps: buildSteps(requiredFields, true, false),
      confidence: 0.6,
    };
  }

  const requiredFields = spec.authMethods[0]?.fields ?? [];
  return {
    ...base,
    recommendedAuth: { kind: recipeKindFor(spec.credentialKind) },
    requiredFields,
    fallbackAuth: null,
    steps: buildSteps(requiredFields, false, false),
    confidence: 0.9,
  };
}

/** Look up a previously-proven recipe by slug (platform-wide, shared across orgs). */
export function findLearnedRecipe(store: JarvisStore, slug: string): IntegrationRecipe | undefined {
  return store.integrationRecipes.get(slug);
}

/**
 * Upsert a proven recipe into the platform-wide library. Never carries a secret
 * value — only the connection shape. An existing slug bumps `successCount` and
 * `lastUsedAt` and keeps the highest-confidence field/step data.
 *
 * @returns The stored recipe.
 */
export function rememberRecipe(store: JarvisStore, recipe: IntegrationRecipe): IntegrationRecipe {
  const existing = store.integrationRecipes.get(recipe.slug);
  const merged: IntegrationRecipe = {
    ...recipe,
    source: "learned",
    successCount: (existing?.successCount ?? 0) + 1,
    confidence: Math.max(existing?.confidence ?? 0, recipe.confidence),
    lastUsedAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.integrationRecipes.set(merged.slug, merged);
  return merged;
}

const SECRET_KEY = /secret|token|password|api[_-]?key|client[_-]?secret|\bkey\b/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "api";
}

/**
 * Build a recipe from a registered engineer draft plus the exact fields the
 * user filled to make the connection work. The field keys become the recipe's
 * `requiredFields` so the next user is asked for the same inputs. No values are
 * copied — only keys/labels/secret-masking.
 */
export function recipeFromDraft(
  draft: IntegrationDraft,
  fields: Record<string, string>,
): IntegrationRecipe {
  const authKind = (draft.discoveredAuth?.kind as CredentialKind | undefined) ?? "bearer";
  const keys = Object.keys(fields).filter((key) => key !== "operations");
  const requiredFields: RecipeField[] =
    keys.length > 0
      ? keys.map((key) => ({ key, label: titleCase(key), help: "", secret: isSecretKey(key) }))
      : [{ key: "secret", label: "API token", help: "The bearer token or API key for this product.", secret: true }];
  const operations: RecipeOperation[] = draft.proposedCapabilities.map((cap) => ({
    toolId: cap.toolId,
    method: cap.method,
    path: cap.path,
    risk: cap.risk,
  }));
  return {
    slug: slugify(draft.name),
    displayName: titleCase(draft.name),
    aliases: [draft.name.toLowerCase()],
    purpose: "custom",
    baseUrl: draft.baseUrl,
    recommendedAuth: { kind: recipeKindFor(authKind) },
    requiredFields,
    fallbackAuth: null,
    steps: requiredFields.map((field) => `${field.label}: ${field.help || "Provide this value from the product's settings."}`),
    docs: [],
    operations,
    credentialKind: authKind,
    source: "ai",
    confidence: 0.7,
    successCount: 0,
    lastUsedAt: null,
    updatedAt: nowIso(),
  };
}

// --- AI discovery (new products) --------------------------------------------

export type DiscoverDeps = {
  fetch?: typeof fetch;
  env?: Pick<JarvisEnv, "modelApiKey" | "modelBaseUrl" | "modelName">;
  /** Env map read for `oauthConfigured` (the platform's `JARVIS_OAUTH_*` client ids/secrets). */
  oauthEnv?: Record<string, string | undefined>;
};

function safeJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asFields(value: unknown): RecipeField[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const fields: RecipeField[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.key !== "string" || typeof row.label !== "string") {
      continue;
    }
    fields.push({
      key: row.key,
      label: row.label,
      help: typeof row.help === "string" ? row.help : "",
      href: typeof row.href === "string" ? row.href : undefined,
      secret: row.secret === true,
    });
  }
  return fields;
}

/** Minimal recipe when neither web search nor the model is available. */
function fallbackRecipe(product: string, purpose: string): IntegrationRecipe {
  return {
    slug: slugify(product),
    displayName: titleCase(product),
    aliases: [product.toLowerCase()],
    purpose,
    baseUrl: null,
    recommendedAuth: { kind: "bearer" },
    requiredFields: [...CUSTOM_PROVIDER.authMethods[0].fields],
    fallbackAuth: null,
    steps: [
      "Find this product's API base URL (https://…) in its developer settings.",
      "Create an API token or key with the scopes you need.",
      "Enter the base URL and token above and connect.",
    ],
    docs: [],
    operations: [],
    credentialKind: "bearer",
    source: "ai",
    confidence: 0.3,
    updatedAt: nowIso(),
    successCount: 0,
    lastUsedAt: null,
  };
}

/**
 * Discover a connection recipe for a brand-new product by reviewing its docs.
 * Searches the web for auth/base-URL/scope details, then asks the model to
 * extract a structured, self-serve-first recipe including the exact
 * `requiredFields`. The platform has no OAuth app for an unknown product, so the
 * model is told to prefer an API key / personal access token the customer can
 * create alone, and to pick OAuth only when no token option exists.
 * Falls back to a low-confidence custom-token recipe when deps are absent.
 */
export async function discoverRecipe(
  deps: DiscoverDeps,
  input: { product: string; purpose?: string },
): Promise<IntegrationRecipe> {
  const purpose = input.purpose ?? "custom";
  const modelEnv = deps.env;
  if (!modelEnv?.modelApiKey) {
    return fallbackRecipe(input.product, purpose);
  }

  const searchDeps: SearchWebDeps = {
    fetch: deps.fetch,
    apiKey: modelEnv.modelApiKey,
    baseUrl: modelEnv.modelBaseUrl,
    model: modelEnv.modelName,
  };
  const search = await searchWeb(
    `${input.product} API authentication OAuth scopes base URL developer docs`,
    searchDeps,
  );
  const snippets = search.items
    .map((item) => `- ${item.title} (${item.url})\n  ${item.snippet}`)
    .join("\n");

  let reply: Awaited<ReturnType<typeof completeModel>>;
  try {
    reply = await completeModel(modelEnv, {
      system:
        "You are an integration engineer. From the docs snippets, output ONLY JSON describing how to connect to the product's API. " +
        "Prefer the method a customer can set up alone without registering a developer OAuth app: usually an API key or personal access token. " +
        "Choose oauth ONLY if the product has no API-key/token option; if you do, add a step noting it requires creating an OAuth app. JSON shape: " +
        '{"baseUrl":string|null,"recommendedAuth":{"kind":"oauth|bearer|header_map|basic|mcp","oauth":{"authorizeUrl":string,"tokenUrl":string,"scopes":string[]}?},' +
        '"requiredFields":[{"key":string,"label":string,"help":string,"href":string?,"secret":boolean?}],' +
        '"steps":string[],"docs":[{"title":string,"url":string}]}. ' +
        "For an API key include the header name+value. For MCP include a serverUrl field. For oauth (last resort) include clientId and clientSecret fields.",
      user: `Product: ${input.product}\nPurpose: ${purpose}\nDocs found:\n${snippets || "(no results)"}`,
      presentedTools: [],
    });
  } catch {
    reply = null;
  }

  const parsed = reply ? safeJson(reply.text) : null;
  if (!parsed) {
    const fallback = fallbackRecipe(input.product, purpose);
    if (search.items.length > 0) {
      fallback.docs = search.items.map((item) => ({ title: item.title, url: item.url }));
      fallback.confidence = 0.4;
    }
    return fallback;
  }

  const authRaw = (parsed.recommendedAuth as Record<string, unknown> | undefined) ?? {};
  const kind = ["oauth", "bearer", "header_map", "basic", "mcp"].includes(String(authRaw.kind))
    ? (authRaw.kind as RecipeAuthKind)
    : "bearer";
  const oauthRaw = authRaw.oauth as Record<string, unknown> | undefined;
  const requiredFields = asFields(parsed.requiredFields);
  const docs = Array.isArray(parsed.docs)
    ? (parsed.docs as Array<Record<string, unknown>>)
        .filter((row) => typeof row.url === "string")
        .map((row) => ({ title: String(row.title ?? row.url), url: String(row.url) }))
    : search.items.map((item) => ({ title: item.title, url: item.url }));
  const steps = Array.isArray(parsed.steps)
    ? (parsed.steps as unknown[]).filter((row): row is string => typeof row === "string")
    : [];

  const credentialKind: CredentialKind = kind === "mcp" ? "mcp" : kind === "oauth" ? "bearer" : (kind as CredentialKind);

  return {
    slug: slugify(input.product),
    displayName: titleCase(input.product),
    aliases: [input.product.toLowerCase()],
    purpose,
    baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : null,
    recommendedAuth:
      kind === "oauth" && oauthRaw
        ? {
            kind: "oauth",
            oauth: {
              authorizeUrl: String(oauthRaw.authorizeUrl ?? ""),
              tokenUrl: String(oauthRaw.tokenUrl ?? ""),
              scopes: Array.isArray(oauthRaw.scopes) ? (oauthRaw.scopes as unknown[]).map(String) : [],
            },
          }
        : { kind },
    requiredFields: requiredFields.length > 0 ? requiredFields : [...CUSTOM_PROVIDER.authMethods[0].fields],
    fallbackAuth: null,
    steps: steps.length > 0 ? steps : fallbackRecipe(input.product, purpose).steps,
    docs,
    operations: [],
    credentialKind,
    source: "ai",
    confidence: 0.6,
    successCount: 0,
    lastUsedAt: null,
    updatedAt: nowIso(),
  };
}

// --- Orchestrator ------------------------------------------------------------

export type Recommendation = { recipe: IntegrationRecipe; source: IntegrationRecipe["source"] };

/**
 * Answer "how do I connect X?" with the best available recipe, in priority
 * order: catalog (built-in) → learned (proven by another org) → AI discovery.
 * When only a purpose is known, recommends the first catalog provider for it.
 */
export async function recommendConnection(
  store: JarvisStore,
  input: { product?: string; purpose?: string },
  deps: DiscoverDeps = {},
): Promise<Recommendation> {
  const product = input.product?.trim();
  const oauthEnv = deps.oauthEnv ?? {};

  if (product) {
    const spec = findProviderByAlias(product);
    if (spec && spec.id !== "custom") {
      return { recipe: catalogRecipe(spec, oauthEnv), source: "catalog" };
    }
    const learned = findLearnedRecipe(store, slugify(product));
    if (learned) {
      return { recipe: learned, source: "learned" };
    }
    return { recipe: await discoverRecipe(deps, { product, purpose: input.purpose }), source: "ai" };
  }

  if (input.purpose) {
    const [spec] = providersForPurpose(input.purpose as IntegrationPurpose);
    if (spec) {
      return { recipe: catalogRecipe(spec, oauthEnv), source: "catalog" };
    }
  }
  return { recipe: catalogRecipe(CUSTOM_PROVIDER, oauthEnv), source: "catalog" };
}
