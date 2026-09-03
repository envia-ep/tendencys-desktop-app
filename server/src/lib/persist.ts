import type { JarvisEnv } from "./env.ts";
import type { JarvisStore } from "./store.ts";
import type {
  CapabilityVersion,
  ConnectorHealth,
  ConnectorVersion,
  IntegrationDraft,
  IntegrationRecipe,
  IntegrationSource,
  IntegrationValidation,
} from "./types.ts";

type Row = Record<string, unknown>;

export function createPersister(env: JarvisEnv) {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) {
    return null;
  }
  const base = `${env.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  const headers = {
    apikey: env.supabaseServiceRoleKey,
    Authorization: `Bearer ${env.supabaseServiceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=minimal",
  };

  async function upsert(table: string, row: unknown): Promise<void> {
    const mapped = toRow(table, row as Row);
    if (!mapped) {
      return;
    }
    const conflict =
      table === "organizations"
        ? "company_id"
        : table === "thread_summaries"
          ? "thread_id"
          : table === "connector_health"
            ? "connector_id"
            : table === "integration_recipes"
              ? "slug"
              : "id";
    const response = await fetch(`${base}/${table}?on_conflict=${conflict}`, {
      method: "POST",
      headers,
      body: JSON.stringify(mapped),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`[jarvis/persist] ${table} ${response.status} ${text}`);
    }
  }

  async function select(table: string): Promise<Row[]> {
    const response = await fetch(`${base}/${table}?select=*`, {
      headers: { apikey: headers.apikey, Authorization: headers.Authorization },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`[jarvis/persist] hydrate ${table} ${response.status}`);
    }
    return (await response.json()) as Row[];
  }

  async function hydrate(store: JarvisStore): Promise<void> {
    for (const row of await select("organizations")) {
      store.organizations.set(String(row.company_id), {
        companyId: String(row.company_id),
        name: String(row.name ?? ""),
        graphRevision: Number(row.graph_revision ?? 0),
        createdAt: String(row.created_at ?? new Date().toISOString()),
      });
    }
    for (const row of await select("agents")) {
      store.agents.set(String(row.id), {
        id: String(row.id),
        orgId: String(row.org_id),
        name: String(row.name),
        handle: String(row.handle ?? "agent"),
        createdAt: String(row.created_at ?? new Date().toISOString()),
      });
    }
    for (const row of await select("agent_versions")) {
      store.agentVersions.set(String(row.id), {
        id: String(row.id),
        agentId: String(row.agent_id),
        version: Number(row.version),
        identity: String(row.identity),
        jobs: String(row.jobs),
        toolIds: asStringArray(row.tool_ids),
        requestedToolIds: asStringArray(row.requested_tool_ids),
        roleIds: asStringArray(row.role_ids),
        skillVersionIds: asStringArray(row.skill_version_ids),
        compiledInstructions: String(row.compiled_instructions ?? ""),
        responsibilities: asStringArray(row.responsibilities),
        expectedOutcomes: asStringArray(row.expected_outcomes),
        memoryPolicy: (row.memory_policy as { allowScopes: ["personal"] }) ?? {
          allowScopes: ["personal", "agent", "organization", "conversation"],
        },
        modelTier: (row.model_tier as "sol") ?? "sol",
        createdAt: String(row.created_at ?? new Date().toISOString()),
      });
    }
    for (const row of await select("principals")) {
      store.principals.set(String(row.id), {
        id: String(row.id),
        orgId: String(row.org_id),
        type: row.type === "human" ? "human" : "agent",
        userId: row.user_id ? String(row.user_id) : null,
        agentId: row.agent_id ? String(row.agent_id) : null,
        displayName: String(row.display_name),
      });
    }
    for (const row of await select("access_grants")) {
      store.accessGrants.set(String(row.id), {
        id: String(row.id),
        orgId: String(row.org_id),
        principalId: String(row.principal_id),
        toolId: String(row.tool_id),
        kind: row.kind === "can_read" ? "can_read" : "can_use",
      });
    }
    for (const row of await select("threads")) {
      store.threads.set(String(row.id), {
        id: String(row.id),
        orgId: String(row.org_id),
        actorId: String(row.actor_id),
        agentId: String(row.agent_id),
        title: row.title ? String(row.title) : null,
        createdAt: String(row.created_at ?? new Date().toISOString()),
      });
    }
    for (const row of await select("messages")) {
      store.messages.push({
        id: String(row.id),
        threadId: String(row.thread_id),
        role: row.role === "assistant" ? "assistant" : row.role === "system" ? "system" : "user",
        content: String(row.content),
        embedding: asNumberArray(row.embedding),
        createdAt: String(row.created_at ?? new Date().toISOString()),
      });
    }
    for (const row of await select("memories")) {
      store.memories.push({
        id: String(row.id),
        orgId: String(row.org_id),
        scopeType: row.scope_type as "personal",
        scopeId: row.scope_id ? String(row.scope_id) : null,
        subjectUserId: row.subject_user_id ? String(row.subject_user_id) : null,
        createdByAgentId: row.created_by_agent_id ? String(row.created_by_agent_id) : null,
        source: row.source === "inferred" ? "inferred" : "explicit",
        content: String(row.content),
        importance: Number(row.importance ?? 0.5),
        confidence: Number(row.confidence ?? 1),
        sensitivity: String(row.sensitivity ?? "normal"),
        embedding: asNumberArray(row.embedding),
        createdAt: String(row.created_at ?? new Date().toISOString()),
        lastConfirmedAt: row.last_confirmed_at ? String(row.last_confirmed_at) : null,
        expiresAt: row.expires_at ? String(row.expires_at) : null,
      });
    }
    try {
      for (const row of await select("action_outcomes")) {
        store.actionOutcomes.push({
          id: String(row.id),
          orgId: String(row.org_id),
          agentId: String(row.agent_id),
          threadId: String(row.thread_id),
          taskId: row.task_id ? String(row.task_id) : null,
          runId: String(row.run_id),
          tool: String(row.tool),
          summary: String(row.summary),
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
      for (const row of await select("thread_summaries")) {
        store.threadSummaries.set(String(row.thread_id), {
          threadId: String(row.thread_id),
          summary: String(row.summary),
          throughMessageId: String(row.through_message_id),
          updatedAt: String(row.updated_at ?? new Date().toISOString()),
        });
      }
    } catch {
      // 003 not applied yet
    }
    for (const row of await select("skills")) {
      store.skills.set(String(row.id), {
        id: String(row.id),
        orgId: String(row.org_id),
        name: String(row.name),
      });
    }
    for (const row of await select("skill_versions")) {
      store.skillVersions.set(String(row.id), {
        id: String(row.id),
        skillId: String(row.skill_id),
        version: Number(row.version),
        instructions: String(row.instructions),
        inputSchema: (row.input_schema as Record<string, unknown>) ?? {},
        outputSchema: (row.output_schema as Record<string, unknown>) ?? {},
        requiredTools: asStringArray(row.required_tools),
        requiredKnowledge: asStringArray(row.required_knowledge),
        evaluationPolicy: (row.evaluation_policy as Record<string, unknown>) ?? {},
      });
    }
    for (const row of await select("roles")) {
      store.roles.set(String(row.id), {
        id: String(row.id),
        orgId: String(row.org_id),
        name: String(row.name),
        requiredToolIds: asStringArray(row.required_tool_ids),
      });
    }
    try {
      for (const row of await select("agent_roles")) {
        store.agentRoles.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          agentId: String(row.agent_id),
          roleId: String(row.role_id),
          priority: Number(row.priority ?? 0),
        });
      }
      for (const row of await select("agent_skills")) {
        store.agentSkills.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          agentId: String(row.agent_id),
          skillId: String(row.skill_id),
          skillVersionId: row.skill_version_id ? String(row.skill_version_id) : null,
        });
      }
      for (const row of await select("role_skills")) {
        store.roleSkills.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          roleId: String(row.role_id),
          skillId: String(row.skill_id),
        });
      }
    } catch {
      // skill link tables not applied yet
    }
    try {
      for (const row of await select("objectives")) {
        store.objectives.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          name: String(row.name),
          description: String(row.description ?? ""),
          status: row.status === "done" ? "done" : "open",
          projectUnitId: row.project_unit_id ? String(row.project_unit_id) : null,
        });
      }
    } catch {
      // 005 not applied yet
    }
    try {
      for (const row of await select("organizational_units")) {
        store.units.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          type: row.type as "company" | "department" | "team" | "project",
          name: String(row.name),
          parentUnitId: row.parent_unit_id ? String(row.parent_unit_id) : null,
        });
      }
      for (const row of await select("unit_memberships")) {
        store.unitMemberships.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          principalId: String(row.principal_id),
          unitId: String(row.unit_id),
        });
      }
      for (const row of await select("principal_relationships")) {
        store.principalRelationships.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          kind: String(row.kind),
          fromPrincipalId: String(row.from_principal_id),
          toPrincipalId: String(row.to_principal_id),
        });
      }
    } catch {
      // org structure tables not applied yet
    }
    try {
      for (const row of await select("credentials")) {
        store.credentials.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          label: String(row.label),
          kind: row.kind as "bearer",
          sealed: String(row.sealed),
          keyVersion: Number(row.key_version ?? 1),
          createdBy: String(row.created_by ?? ""),
          createdAt: String(row.created_at ?? new Date().toISOString()),
          rotatedAt: row.rotated_at ? String(row.rotated_at) : null,
          revokedAt: row.revoked_at ? String(row.revoked_at) : null,
        });
      }
      for (const row of await select("connectors")) {
        store.connectors.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          kind: row.kind === "mcp" || row.kind === "webhook" ? row.kind : "openapi",
          name: String(row.name),
          status: row.status === "disabled" ? "disabled" : "active",
          revision: Number(row.revision ?? 1),
          credentialId: row.credential_id ? String(row.credential_id) : null,
          publicConfig: (row.public_config as { origin: string }) ?? { origin: "" },
          specHash: row.spec_hash ? String(row.spec_hash) : null,
          authSealed: row.auth_sealed ? String(row.auth_sealed) : null,
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
      for (const row of await select("capabilities")) {
        store.capabilities.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          connectorId: String(row.connector_id),
          toolId: String(row.tool_id),
          version: Number(row.version ?? 1),
          side: row.side === "client" || row.side === "native" ? row.side : "cloud",
          risk: (row.risk as "low") ?? "low",
          inputSchema: (row.input_schema as Record<string, unknown>) ?? {},
          outputSchema: (row.output_schema as Record<string, unknown>) ?? {},
          binding: (row.binding as { method?: string }) ?? {},
          enabled: row.enabled !== false,
        });
      }
      for (const row of await select("custom_tools")) {
        store.customTools.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          toolId: String(row.tool_id),
          definition: (row.definition as { steps: [] }) ?? { steps: [] },
          risk: (row.risk as "low") ?? "low",
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
      for (const row of await select("webhook_deliveries")) {
        store.webhookDeliveries.set(String(row.id), {
          id: String(row.id),
          connectorId: String(row.connector_id),
          nonce: String(row.nonce),
          timestamp: String(row.timestamp),
          bodySealed: String(row.body_sealed),
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
    } catch {
      // 008 not applied yet
    }
    try {
      for (const row of await select("connect_sessions")) {
        store.connectSessions.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          runId: row.run_id ? String(row.run_id) : null,
          agentId: String(row.agent_id),
          createdBy: String(row.created_by),
          providerId: row.provider_id ? String(row.provider_id) : null,
          purpose: row.purpose ? String(row.purpose) : null,
          status: row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "pending",
          oauthState: row.oauth_state ? String(row.oauth_state) : null,
          toolIds: asStringArray(row.tool_ids),
          fields: (row.fields as Record<string, string>) ?? {},
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
      for (const row of await select("integration_drafts")) {
        store.integrationDrafts.set(String(row.id), {
          id: String(row.id),
          orgId: String(row.org_id),
          name: String(row.name),
          sourceType: row.source_type ? (String(row.source_type) as IntegrationDraft["sourceType"]) : null,
          status: String(row.status ?? "DRAFT") as IntegrationDraft["status"],
          specHash: row.spec_hash ? String(row.spec_hash) : null,
          baseUrl: row.base_url ? String(row.base_url) : null,
          discoveredAuth: (row.discovered_auth as Record<string, unknown> | null) ?? null,
          discoveredOperations: (row.discovered_operations as IntegrationDraft["discoveredOperations"]) ?? [],
          proposedCapabilities: (row.proposed_capabilities as IntegrationDraft["proposedCapabilities"]) ?? [],
          validationState: row.validation_state ? String(row.validation_state) : null,
          questions: asStringArray(row.questions),
          createdBy: String(row.created_by ?? ""),
          createdAt: String(row.created_at ?? new Date().toISOString()),
          updatedAt: String(row.updated_at ?? new Date().toISOString()),
        });
      }
      for (const row of await select("integration_sources")) {
        store.integrationSources.set(String(row.id), {
          id: String(row.id),
          draftId: String(row.draft_id),
          type: String(row.type) as IntegrationSource["type"],
          ref: row.ref ? String(row.ref) : null,
          content: row.content ? String(row.content) : null,
          sha: row.sha ? String(row.sha) : null,
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
      for (const row of await select("integration_validations")) {
        store.integrationValidations.set(String(row.id), {
          id: String(row.id),
          draftId: String(row.draft_id),
          level: String(row.level) as IntegrationValidation["level"],
          status: String(row.status ?? "pending") as IntegrationValidation["status"],
          detail: (row.detail as Record<string, unknown>) ?? {},
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
    } catch {
      // 011 not applied yet
    }

    try {
      for (const row of await select("connector_health")) {
        store.connectorHealth.set(String(row.connector_id), {
          connectorId: String(row.connector_id),
          orgId: String(row.org_id),
          state: String(row.state ?? "READY") as ConnectorHealth["state"],
          detail: row.detail ? String(row.detail) : null,
          checkedAt: String(row.checked_at ?? new Date().toISOString()),
        });
      }
    } catch {
      // 012 not applied yet
    }

    try {
      for (const row of await select("connector_versions")) {
        store.connectorVersions.set(String(row.id), {
          id: String(row.id),
          connectorId: String(row.connector_id),
          orgId: String(row.org_id),
          revision: Number(row.revision ?? 1),
          specHash: row.spec_hash ? String(row.spec_hash) : null,
          publicConfig: (row.public_config as { origin: string }) ?? { origin: "" },
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
      for (const row of await select("capability_versions")) {
        store.capabilityVersions.set(String(row.id), {
          id: String(row.id),
          capabilityId: String(row.capability_id),
          connectorVersionId: String(row.connector_version_id),
          orgId: String(row.org_id),
          toolId: String(row.tool_id),
          version: Number(row.version ?? 1),
          side: row.side === "client" || row.side === "native" ? row.side : "cloud",
          risk: (row.risk as "low") ?? "low",
          binding: (row.binding as { method?: string }) ?? {},
          createdAt: String(row.created_at ?? new Date().toISOString()),
        });
      }
    } catch {
      // 013 not applied yet
    }

    try {
      for (const row of await select("integration_recipes")) {
        store.integrationRecipes.set(String(row.slug), {
          slug: String(row.slug),
          displayName: String(row.display_name ?? row.slug),
          aliases: asStringArray(row.aliases),
          purpose: String(row.purpose ?? "custom"),
          baseUrl: row.base_url ? String(row.base_url) : null,
          recommendedAuth: (row.recommended_auth as IntegrationRecipe["recommendedAuth"]) ?? { kind: "bearer" },
          requiredFields: (row.required_fields as IntegrationRecipe["requiredFields"]) ?? [],
          fallbackAuth: (row.fallback_auth as IntegrationRecipe["fallbackAuth"]) ?? null,
          steps: asStringArray(row.steps),
          docs: (row.docs as IntegrationRecipe["docs"]) ?? [],
          operations: (row.operations as IntegrationRecipe["operations"]) ?? [],
          credentialKind: (row.credential_kind as IntegrationRecipe["credentialKind"]) ?? "bearer",
          source: (row.source as IntegrationRecipe["source"]) ?? "learned",
          confidence: Number(row.confidence ?? 0.5),
          successCount: Number(row.success_count ?? 0),
          lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
          updatedAt: String(row.updated_at ?? new Date().toISOString()),
        });
      }
    } catch {
      // 014 not applied yet
    }
  }

  return { upsert, hydrate };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function asNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map(Number);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.map(Number) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function toRow(table: string, row: Row): Row | null {
  if (table === "memories") {
    return {
      id: row.id,
      org_id: row.orgId,
      scope_type: row.scopeType,
      scope_id: row.scopeId,
      subject_user_id: row.subjectUserId,
      created_by_agent_id: row.createdByAgentId,
      source: row.source,
      content: row.content,
      importance: row.importance,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      embedding: row.embedding,
      created_at: row.createdAt,
      last_confirmed_at: row.lastConfirmedAt,
      expires_at: row.expiresAt,
    };
  }
  if (table === "messages") {
    return {
      id: row.id,
      thread_id: row.threadId,
      role: row.role,
      content: row.content,
      embedding: row.embedding,
      created_at: row.createdAt,
    };
  }
  if (table === "action_outcomes") {
    return {
      id: row.id,
      org_id: row.orgId,
      agent_id: row.agentId,
      thread_id: row.threadId,
      task_id: row.taskId,
      run_id: row.runId,
      tool: row.tool,
      summary: row.summary,
      created_at: row.createdAt,
    };
  }
  if (table === "thread_summaries") {
    return {
      thread_id: row.threadId,
      summary: row.summary,
      through_message_id: row.throughMessageId,
      updated_at: row.updatedAt,
    };
  }
  if (table === "agents") {
    return {
      id: row.id,
      org_id: row.orgId,
      name: row.name,
      handle: row.handle,
      created_at: row.createdAt,
    };
  }
  if (table === "threads") {
    return {
      id: row.id,
      org_id: row.orgId,
      actor_id: row.actorId,
      agent_id: row.agentId,
      title: row.title,
      created_at: row.createdAt,
    };
  }
  if (table === "organizations") {
    return {
      company_id: row.companyId,
      name: row.name,
      graph_revision: row.graphRevision,
      created_at: row.createdAt,
    };
  }
  if (table === "agent_versions") {
    return {
      id: row.id,
      agent_id: row.agentId,
      version: row.version,
      identity: row.identity,
      jobs: row.jobs,
      tool_ids: row.toolIds ?? row.requestedToolIds,
      requested_tool_ids: row.requestedToolIds ?? row.toolIds,
      role_ids: row.roleIds,
      skill_version_ids: row.skillVersionIds,
      compiled_instructions: row.compiledInstructions,
      responsibilities: row.responsibilities,
      expected_outcomes: row.expectedOutcomes,
      memory_policy: row.memoryPolicy,
      model_tier: row.modelTier,
      created_at: row.createdAt,
    };
  }
  if (table === "principals") {
    return {
      id: row.id,
      org_id: row.orgId,
      type: row.type,
      user_id: row.userId,
      agent_id: row.agentId,
      display_name: row.displayName,
    };
  }
  if (table === "access_grants") {
    return {
      id: row.id,
      org_id: row.orgId,
      principal_id: row.principalId,
      tool_id: row.toolId,
      kind: row.kind,
    };
  }
  if (table === "skills") {
    return {
      id: row.id,
      org_id: row.orgId,
      name: row.name,
    };
  }
  if (table === "skill_versions") {
    return {
      id: row.id,
      skill_id: row.skillId,
      version: row.version,
      instructions: row.instructions,
      input_schema: row.inputSchema,
      output_schema: row.outputSchema,
      required_tools: row.requiredTools,
      required_knowledge: row.requiredKnowledge,
      evaluation_policy: row.evaluationPolicy,
    };
  }
  if (table === "roles") {
    return {
      id: row.id,
      org_id: row.orgId,
      name: row.name,
      required_tool_ids: row.requiredToolIds,
    };
  }
  if (table === "objectives") {
    return {
      id: row.id,
      org_id: row.orgId,
      name: row.name,
      description: row.description,
      status: row.status,
      project_unit_id: row.projectUnitId,
    };
  }
  if (table === "organizational_units") {
    return {
      id: row.id,
      org_id: row.orgId,
      type: row.type,
      name: row.name,
      parent_unit_id: row.parentUnitId,
    };
  }
  if (table === "unit_memberships") {
    return {
      id: row.id,
      org_id: row.orgId,
      principal_id: row.principalId,
      unit_id: row.unitId,
    };
  }
  if (table === "principal_relationships") {
    return {
      id: row.id,
      org_id: row.orgId,
      kind: row.kind,
      from_principal_id: row.fromPrincipalId,
      to_principal_id: row.toPrincipalId,
    };
  }
  if (table === "agent_roles") {
    return {
      id: row.id,
      org_id: row.orgId,
      agent_id: row.agentId,
      role_id: row.roleId,
      priority: row.priority,
    };
  }
  if (table === "agent_skills") {
    return {
      id: row.id,
      org_id: row.orgId,
      agent_id: row.agentId,
      skill_id: row.skillId,
      skill_version_id: row.skillVersionId,
    };
  }
  if (table === "role_skills") {
    return {
      id: row.id,
      org_id: row.orgId,
      role_id: row.roleId,
      skill_id: row.skillId,
    };
  }
  if (table === "credentials") {
    return {
      id: row.id,
      org_id: row.orgId,
      label: row.label,
      kind: row.kind,
      sealed: row.sealed,
      key_version: row.keyVersion,
      created_by: row.createdBy,
      created_at: row.createdAt,
      rotated_at: row.rotatedAt,
      revoked_at: row.revokedAt,
    };
  }
  if (table === "connectors") {
    return {
      id: row.id,
      org_id: row.orgId,
      kind: row.kind,
      name: row.name,
      status: row.status,
      revision: row.revision,
      credential_id: row.credentialId,
      public_config: row.publicConfig,
      spec_hash: row.specHash,
      auth_sealed: row.authSealed,
      created_at: row.createdAt,
    };
  }
  if (table === "capabilities") {
    return {
      id: row.id,
      org_id: row.orgId,
      connector_id: row.connectorId,
      tool_id: row.toolId,
      version: row.version,
      side: row.side,
      risk: row.risk,
      input_schema: row.inputSchema,
      output_schema: row.outputSchema,
      binding: row.binding,
      enabled: row.enabled,
    };
  }
  if (table === "custom_tools") {
    return {
      id: row.id,
      org_id: row.orgId,
      tool_id: row.toolId,
      definition: row.definition,
      risk: row.risk,
      created_at: row.createdAt,
    };
  }
  if (table === "webhook_deliveries") {
    return {
      id: row.id,
      connector_id: row.connectorId,
      nonce: row.nonce,
      timestamp: row.timestamp,
      body_sealed: row.bodySealed,
      created_at: row.createdAt,
    };
  }
  if (table === "connect_sessions") {
    return {
      id: row.id,
      org_id: row.orgId,
      run_id: row.runId,
      agent_id: row.agentId,
      created_by: row.createdBy,
      provider_id: row.providerId,
      purpose: row.purpose,
      status: row.status,
      oauth_state: row.oauthState,
      tool_ids: row.toolIds,
      fields: row.fields,
      created_at: row.createdAt,
    };
  }
  if (table === "integration_drafts") {
    return {
      id: row.id,
      org_id: row.orgId,
      name: row.name,
      source_type: row.sourceType,
      status: row.status,
      spec_hash: row.specHash,
      base_url: row.baseUrl,
      discovered_auth: row.discoveredAuth,
      discovered_operations: row.discoveredOperations,
      proposed_capabilities: row.proposedCapabilities,
      validation_state: row.validationState,
      questions: row.questions,
      created_by: row.createdBy,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  }
  if (table === "integration_sources") {
    return {
      id: row.id,
      draft_id: row.draftId,
      type: row.type,
      ref: row.ref,
      content: row.content,
      sha: row.sha,
      created_at: row.createdAt,
    };
  }
  if (table === "integration_validations") {
    return {
      id: row.id,
      draft_id: row.draftId,
      level: row.level,
      status: row.status,
      detail: row.detail,
      created_at: row.createdAt,
    };
  }
  if (table === "connector_health") {
    return {
      connector_id: row.connectorId,
      org_id: row.orgId,
      state: row.state,
      detail: row.detail,
      checked_at: row.checkedAt,
    };
  }
  if (table === "integration_recipes") {
    return {
      slug: row.slug,
      display_name: row.displayName,
      aliases: row.aliases,
      purpose: row.purpose,
      base_url: row.baseUrl,
      recommended_auth: row.recommendedAuth,
      required_fields: row.requiredFields,
      fallback_auth: row.fallbackAuth,
      steps: row.steps,
      docs: row.docs,
      operations: row.operations,
      credential_kind: row.credentialKind,
      source: row.source,
      confidence: row.confidence,
      success_count: row.successCount,
      last_used_at: row.lastUsedAt,
      updated_at: row.updatedAt,
    };
  }
  if (table === "connector_versions") {
    return {
      id: row.id,
      connector_id: row.connectorId,
      org_id: row.orgId,
      revision: row.revision,
      spec_hash: row.specHash,
      public_config: row.publicConfig,
      created_at: row.createdAt,
    };
  }
  if (table === "capability_versions") {
    return {
      id: row.id,
      capability_id: row.capabilityId,
      connector_version_id: row.connectorVersionId,
      org_id: row.orgId,
      tool_id: row.toolId,
      version: row.version,
      side: row.side,
      risk: row.risk,
      binding: row.binding,
      created_at: row.createdAt,
    };
  }
  return null;
}

export async function persistOrgSnapshot(store: JarvisStore, orgId: string): Promise<void> {
  const org = store.organizations.get(orgId);
  if (!org) {
    return;
  }
  for (const proposal of store.studioProposals.values()) {
    if (proposal.orgId === orgId && proposal.status === "draft") {
      store.studioProposals.delete(proposal.id);
    }
  }
  await store.persist("organizations", org);
  for (const agent of store.listAgents(orgId)) {
    await store.persist("agents", agent);
    const version = store.latestVersion(agent.id);
    if (version) {
      await store.persist("agent_versions", version);
    }
  }
  for (const principal of store.principals.values()) {
    if (principal.orgId === orgId) {
      await store.persist("principals", principal);
    }
  }
  for (const grant of store.accessGrants.values()) {
    if (grant.orgId === orgId) {
      await store.persist("access_grants", grant);
    }
  }
  for (const credential of store.credentials.values()) {
    if (credential.orgId === orgId) {
      await store.persist("credentials", credential);
    }
  }
  for (const connector of store.connectors.values()) {
    if (connector.orgId === orgId) {
      await store.persist("connectors", connector);
    }
  }
  for (const health of store.connectorHealth.values()) {
    if (health.orgId === orgId) {
      await store.persist("connector_health", health);
    }
  }
  for (const version of store.connectorVersions.values()) {
    if (version.orgId === orgId) {
      await store.persist("connector_versions", version);
    }
  }
  for (const capability of store.capabilities.values()) {
    if (capability.orgId === orgId) {
      await store.persist("capabilities", capability);
    }
  }
  for (const version of store.capabilityVersions.values()) {
    if (version.orgId === orgId) {
      await store.persist("capability_versions", version);
    }
  }
  for (const custom of store.customTools.values()) {
    if (custom.orgId === orgId) {
      await store.persist("custom_tools", custom);
    }
  }
  for (const skill of store.skills.values()) {
    if (skill.orgId === orgId) {
      await store.persist("skills", skill);
    }
  }
  for (const version of store.skillVersions.values()) {
    const skill = store.skills.get(version.skillId);
    if (skill?.orgId === orgId) {
      await store.persist("skill_versions", version);
    }
  }
  for (const role of store.roles.values()) {
    if (role.orgId === orgId) {
      await store.persist("roles", role);
    }
  }
  for (const objective of store.objectives.values()) {
    if (objective.orgId === orgId) {
      await store.persist("objectives", objective);
    }
  }
  for (const unit of store.units.values()) {
    if (unit.orgId === orgId) {
      await store.persist("organizational_units", unit);
    }
  }
  for (const row of store.unitMemberships.values()) {
    if (row.orgId === orgId) {
      await store.persist("unit_memberships", row);
    }
  }
  for (const row of store.principalRelationships.values()) {
    if (row.orgId === orgId) {
      await store.persist("principal_relationships", row);
    }
  }
  await persistSkillLinks(store, orgId);
}

export async function persistGraphWrite(store: JarvisStore, orgId: string): Promise<void> {
  const org = store.organizations.get(orgId);
  if (!org) {
    return;
  }
  await store.persist("organizations", org);
  for (const skill of store.skills.values()) {
    if (skill.orgId === orgId) {
      await store.persist("skills", skill);
    }
  }
  for (const version of store.skillVersions.values()) {
    const skill = store.skills.get(version.skillId);
    if (skill?.orgId === orgId) {
      await store.persist("skill_versions", version);
    }
  }
  for (const row of store.unitMemberships.values()) {
    if (row.orgId === orgId) {
      await store.persist("unit_memberships", row);
    }
  }
  for (const row of store.principalRelationships.values()) {
    if (row.orgId === orgId) {
      await store.persist("principal_relationships", row);
    }
  }
  await persistSkillLinks(store, orgId);
  for (const agent of store.listAgents(orgId)) {
    const version = store.latestVersion(agent.id);
    if (version) {
      await store.persist("agent_versions", version);
    }
  }
}

async function persistSkillLinks(store: JarvisStore, orgId: string): Promise<void> {
  for (const row of store.agentRoles.values()) {
    if (row.orgId === orgId) {
      await store.persist("agent_roles", row);
    }
  }
  for (const row of store.agentSkills.values()) {
    if (row.orgId === orgId) {
      await store.persist("agent_skills", row);
    }
  }
  for (const row of store.roleSkills.values()) {
    if (row.orgId === orgId) {
      await store.persist("role_skills", row);
    }
  }
}

/** Persist a single connect session so a half-finished connect survives restart. */
export async function persistConnectSession(store: JarvisStore, connectId: string): Promise<void> {
  const session = store.connectSessions.get(connectId);
  if (session) {
    await store.persist("connect_sessions", session);
  }
}

/** Persist the latest health row for a connector. */
export async function persistConnectorHealth(store: JarvisStore, connectorId: string): Promise<void> {
  const health = store.connectorHealth.get(connectorId);
  if (health) {
    await store.persist("connector_health", health);
  }
}

/** Persist one platform-wide learned recipe (connection shape only, no secret). */
export async function persistRecipe(store: JarvisStore, slug: string): Promise<void> {
  const recipe = store.integrationRecipes.get(slug);
  if (recipe) {
    await store.persist("integration_recipes", recipe);
  }
}

/** Persist an integration draft together with its sources and validation rows. */
export async function persistDraft(store: JarvisStore, draftId: string): Promise<void> {
  const draft = store.integrationDrafts.get(draftId);
  if (!draft) {
    return;
  }
  await store.persist("integration_drafts", draft);
  for (const source of store.sourcesForDraft(draftId)) {
    await store.persist("integration_sources", source);
  }
  for (const validation of store.validationsForDraft(draftId)) {
    await store.persist("integration_validations", validation);
  }
}

export async function persistThreadWrite(
  store: JarvisStore,
  threadId: string,
  message?: { id: string },
): Promise<void> {
  const thread = store.threads.get(threadId);
  if (thread) {
    await store.persist("threads", thread);
  }
  const row = message
    ? store.messages.find((item) => item.id === message.id)
    : store.messagesFor(threadId).at(-1);
  if (row) {
    await store.persist("messages", row);
  }
  const summary = store.threadSummaries.get(threadId);
  if (summary) {
    await store.persist("thread_summaries", summary);
  }
}
