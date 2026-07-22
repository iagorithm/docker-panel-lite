"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDatabase } from "@/lib/firebase-admin";
import {
  canAccessCredential,
  canManageCredential,
  credentialOwnerUid,
  credentialSharingMode,
  normalizeCredentialEmail,
  type CredentialAccessRecord,
} from "@/lib/credential-access";
import { requireSession } from "@/lib/session";
import { encryptSecret } from "@/lib/secrets";
import type { Repository } from "@/lib/types";
import {
  canAccessRepository,
  canManageRepository,
  normalizeRepositoryEmail,
  repositoryOwnerUid,
  repositorySharingMode,
  type RepositoryAccessRecord,
} from "@/lib/repository-access";
import { canAccessWorker, canManageWorker, normalizeWorkerEmail, type WorkerAccessRecord } from "@/lib/worker-access";

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const branchPattern = /^(?![-./])(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[^\s~^:?*[\\]+$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const defaultComposeFile = "docker-compose.yaml";
const workerOnlineFreshness = 45_000;
const orphanWorkerDeleteAge = 2 * 60_000;
type RepositoryAction = "sync" | "deploy" | "stop" | "build" | "discover_branches" | "read_compose" | "worker_command" | "tunnel_start" | "tunnel_stop";
type ContainerJobAction = "container_start" | "container_stop" | "container_restart" | "container_delete" | "container_logs" | "container_exec" | "container_tunnel_start";
type JobAction = RepositoryAction | ContainerJobAction;

function sanitizeAppLogMessage(value: unknown) {
  return String(value || "Unknown error")
    .replace(/([?&](?:access_token|token|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(authorization:\s*(?:bearer|basic)\s+)[^\s]+/gi, "$1[REDACTED]")
    .slice(0, 2000);
}

async function writeUiAppLog(input: { workspaceId: string; user: { uid: string; email?: string }; action: string; source: string; functionName?: string; message: unknown; context?: Record<string, unknown> }) {
  const ref = adminDatabase.ref(`workspaces/${input.workspaceId}/app_logs`).push();
  await ref.set({ id: ref.key, actorType: "ui", actorId: input.user.uid, actorEmail: input.user.email || "", runtime: "web", functionName: String(input.functionName || input.source || "unknown").slice(0, 240), action: String(input.action || "unknown").slice(0, 120), source: String(input.source || "ui").slice(0, 160), severity: "error", message: sanitizeAppLogMessage(input.message), context: input.context || {}, createdAt: Date.now() });
}

const repositorySchema = z.object({
  repositoryId: z.string().optional(),
  alias: z.string().trim().regex(aliasPattern, "Invalid alias"),
  url: z.string().trim().refine((value) => /^(https:\/\/|git@|ssh:\/\/)/.test(value), "Invalid Git URL"),
  branch: z.string().trim().refine((value) => !value || branchPattern.test(value), "Invalid branch"),
  mode: z.enum(["compose", "dockerfile"]),
  composeFile: z.string().trim().default(defaultComposeFile),
  dockerfile: z.string().trim().default("Dockerfile"),
  credentialId: z.string().trim().default(""),
  environmentJson: z.string().default("{}"),
  environmentFormat: z.enum(["env", "json"]).default("env"),
  domain: z.string().trim().refine((value) => !value || hostnamePattern.test(value), "Invalid domain"),
  service: z.string().trim().default("web"),
  internalPort: z.coerce.number().int().min(1).max(65535).default(3000),
  ports: z.string().trim().default(""),
  publicTunnelEnabled: z.preprocess((value) => value === "on" || value === "true" || value === true, z.boolean()).default(false),
  publicTunnelDomain: z.string().trim().default(""),
  publicTunnelDomainsJson: z.string().trim().default(""),
  publicTunnelPortsJson: z.string().trim().default(""),
  ngrokAuthtoken: z.string().trim().default(""),
  poolId: z.string().trim().regex(aliasPattern).default("default"),
  defaultWorkerId: z.string().trim().default(""),
  sharing: z.enum(["private", "shared", "public"]).default("private"),
  sharedEmails: z.string().trim().max(4000).default(""),
});

const credentialSchema = z.object({
  alias: z.string().trim().regex(aliasPattern, "Invalid credential alias"),
  username: z.string().trim().max(200).default(""),
  token: z.string().trim().min(1, "Token is required"),
});

const commandPresetSchema = z.object({
  commandId: z.string().trim().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).default(""),
  command: z.string().trim().min(1).max(4000),
});

const workerSharingSchema = z.object({
  workerId: z.string().min(1),
  sharing: z.enum(["private", "shared", "public"]),
  sharedEmails: z.string().trim().max(4000).default(""),
});

const workerClaimSchema = z.object({
  workerToken: z.string().trim().min(8),
});

const credentialSharingSchema = z.object({
  credentialId: z.string().min(1),
  sharing: z.enum(["private", "shared", "public"]),
  sharedEmails: z.string().trim().max(4000).default(""),
});

const repositoryImportSchema = z.object({
  alias: z.string().trim().optional(),
  id: z.string().trim().optional(),
  name: z.string().trim().optional(),
  url: z.string().trim().refine((value) => /^(https:\/\/|git@|ssh:\/\/)/.test(value), "Invalid Git URL"),
  branch: z.string().trim().optional().default(""),
  mode: z.enum(["compose", "dockerfile"]).optional().default("compose"),
  composeFile: z.string().trim().optional(),
  compose_file: z.string().trim().optional(),
  dockerfile: z.string().trim().optional().default("Dockerfile"),
  credentialId: z.string().trim().optional(),
  credential: z.string().trim().optional(),
  environment: z.unknown().optional(),
  env_vars: z.unknown().optional(),
  env: z.unknown().optional(),
  domain: z.string().trim().optional().default(""),
  service: z.string().trim().optional().default("web"),
  internalPort: z.coerce.number().int().min(1).max(65535).optional(),
  internal_port: z.coerce.number().int().min(1).max(65535).optional(),
  ports: z.string().trim().optional().default(""),
  publicTunnelEnabled: z.boolean().optional(),
  public_tunnel_enabled: z.boolean().optional(),
  exposePublic: z.boolean().optional(),
  expose_public: z.boolean().optional(),
  publicTunnelDomain: z.string().trim().optional(),
  public_tunnel_domain: z.string().trim().optional(),
  publicTunnelDomains: z.unknown().optional(),
  public_tunnel_domains: z.unknown().optional(),
  publicTunnelPorts: z.unknown().optional(),
  public_tunnel_ports: z.unknown().optional(),
  publicDomain: z.string().trim().optional(),
  ngrokDomain: z.string().trim().optional(),
  ngrokAuthtoken: z.string().trim().optional(),
  ngrok_authtoken: z.string().trim().optional(),
  ngrokApiKey: z.string().trim().optional(),
  ngrok_api_key: z.string().trim().optional(),
  poolId: z.string().trim().optional(),
  pool_id: z.string().trim().optional(),
  added_at: z.string().trim().optional(),
  createdAt: z.number().optional(),
});

export type RepositorySaveState = {
  status: "idle" | "success" | "error";
  message: string;
};

export type DeploymentQueueState = {
  status: "idle" | "success" | "error";
  message: string;
};

const uiAppLogSchema = z.object({
  action: z.string().trim().min(1).max(120).default("ui_runtime"),
  source: z.string().trim().min(1).max(160).default("browser"),
  functionName: z.string().trim().max(240).default(""),
  message: z.string().trim().min(1).max(4000),
  path: z.string().trim().max(500).default(""),
  repositoryId: z.string().trim().max(200).default(""),
});

export async function recordUiAppLog(payload: unknown) {
  const user = await requireSession();
  const input = uiAppLogSchema.parse(payload);
  await writeUiAppLog({ workspaceId: user.workspaceId, user, action: input.action, source: input.source, functionName: input.functionName, message: input.message, context: { path: input.path, repositoryId: input.repositoryId } });
}

function formObject(formData: FormData) {
  return Object.fromEntries(formData.entries());
}

function parseJsonInput(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return JSON.parse(value.replace(/,\s*([}\]])/g, "$1"));
  }
}

function aliasFromUrl(url: string) {
  const tail = url.split("/").filter(Boolean).at(-1) || "repository";
  return tail.replace(/\.git$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "repository";
}

function aliasFromName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "command";
}

function safeDockerName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").toLowerCase().slice(0, 63);
}

type PublishedPort = {
  hostPort: number;
  protocol: "tcp" | "udp";
};

function publishedPortKey(binding: PublishedPort) {
  return `${binding.protocol}:${binding.hostPort}`;
}

function parseConfiguredPublishedPorts(value: unknown): PublishedPort[] {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const result: PublishedPort[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const match = entry.match(/(?:^|:)(\d+):(\d+)(?:\/(tcp|udp))?$/i);
    if (!match) throw new Error(`Invalid port mapping '${entry}'. Use host:container, for example 8080:80.`);
    const hostPort = Number(match[1]);
    const containerPort = Number(match[2]);
    if (hostPort < 1 || hostPort > 65535 || containerPort < 1 || containerPort > 65535) {
      throw new Error(`Invalid port mapping '${entry}'. Ports must be between 1 and 65535.`);
    }
    const binding: PublishedPort = { hostPort, protocol: match[3]?.toLowerCase() === "udp" ? "udp" : "tcp" };
    const key = publishedPortKey(binding);
    if (seen.has(key)) throw new Error(`Port ${hostPort}/${binding.protocol} is declared more than once.`);
    seen.add(key);
    result.push(binding);
  }
  return result;
}

function parseInventoryPublishedPorts(value: unknown): PublishedPort[] {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  const result: PublishedPort[] = [];
  for (const item of entries) {
    const raw = String(item || "").trim();
    const match = raw.match(/(?:^|:)(\d+)->\d+(?:\/(tcp|udp))?$/i);
    if (!match) continue;
    result.push({ hostPort: Number(match[1]), protocol: match[2]?.toLowerCase() === "udp" ? "udp" : "tcp" });
  }
  return result;
}

function assertConfiguredPortsAvailable(input: {
  repositoryId: string;
  poolId: string;
  mode: string;
  ports: string;
  repositories: Record<string, Partial<Repository>>;
}) {
  if (input.mode !== "dockerfile") return;
  const requested = parseConfiguredPublishedPorts(input.ports);
  if (!requested.length) return;
  const requestedKeys = new Set(requested.map(publishedPortKey));
  for (const [otherId, repository] of Object.entries(input.repositories)) {
    if (otherId === input.repositoryId || repository.mode !== "dockerfile") continue;
    if (String(repository.poolId || "default") !== input.poolId) continue;
    for (const binding of parseConfiguredPublishedPorts(repository.ports)) {
      if (requestedKeys.has(publishedPortKey(binding))) {
        throw new Error(`Port ${binding.hostPort}/${binding.protocol} is already reserved by repository '${repository.alias || otherId}' in pool '${input.poolId}'.`);
      }
    }
  }
}

async function findOpenDeploymentPortCollision(input: {
  workspaceId: string;
  repositoryId: string;
  repository: Partial<Repository>;
  targetWorkerId: string;
}) {
  if (input.repository.mode !== "dockerfile") return "";
  const requested = parseConfiguredPublishedPorts(input.repository.ports);
  if (!requested.length) return "";
  const requestedKeys = new Set(requested.map(publishedPortKey));
  const project = safeDockerName(String(input.repository.alias || input.repositoryId));
  const snapshot = await adminDatabase.ref(`workspaces/${input.workspaceId}/containers`).get();
  const containers = (snapshot.val() ?? {}) as Record<string, Record<string, unknown>>;
  for (const container of Object.values(containers)) {
    if (String(container.workerId || "") !== input.targetWorkerId) continue;
    if (!["running", "restarting", "created"].includes(String(container.status || "").toLowerCase())) continue;
    if (safeDockerName(String(container.project || container.name || "")) === project) continue;
    for (const binding of parseInventoryPublishedPorts(container.ports)) {
      if (requestedKeys.has(publishedPortKey(binding))) {
        return `Port ${binding.hostPort}/${binding.protocol} is already open on worker '${input.targetWorkerId}' by container '${container.name || container.id || "unknown"}'.`;
      }
    }
  }
  return "";
}

function secretMask(value: string) {
  return value.length > 10 ? `${value.slice(0, 5)}••••••••${value.slice(-4)}` : "••••••••";
}

function normalizeEnvKey(key: string) {
  const normalized = key.trim();
  return envKeyPattern.test(normalized) ? normalized : "";
}

function compactJsonText(value: string) {
  const text = value.trim();
  if (!text || !["{", "["].includes(text[0])) return value;
  try {
    return JSON.stringify(parseJsonInput(text));
  } catch {
    return value;
  }
}

function normalizeEnvValue(item: unknown) {
  if (item == null) return "";
  if (typeof item === "object") return JSON.stringify(item);
  return compactJsonText(String(item)).replace(/\u0000/g, "");
}

function environmentFromObject(value: Record<string, unknown>) {
  const result: Record<string, string> = {};
  for (const [rawKey, item] of Object.entries(value)) {
    const key = normalizeEnvKey(rawKey);
    if (key) result[key] = normalizeEnvValue(item);
  }
  return result;
}

function parseEnvValue(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"') : inner;
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseEnvironment(value: string, format: "env" | "json" = "env", fallback: Record<string, string> = {}): Record<string, string> {
  const raw = value.trim();
  if (!raw) return {};
  if (format === "json" || raw.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = parseJsonInput(raw);
    } catch {
      return fallback;
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return fallback;
    }
    return environmentFromObject(parsed as Record<string, unknown>);
  }
  const result: Record<string, string> = {};
  let currentKey = "";
  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) {
      currentKey = match[1];
      result[currentKey] = normalizeEnvValue(parseEnvValue(match[2]));
      continue;
    }
    if (currentKey) result[currentKey] = normalizeEnvValue(`${result[currentKey]}\n${rawLine}`);
  }
  return result;
}

function normalizeEnvironment(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw || /^https?:\/\//.test(raw)) return {};
    return parseEnvironment(raw);
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return environmentFromObject(value as Record<string, unknown>);
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return {};
    try {
      const parsed = parseJsonInput(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return {};
      return normalizeStringMap(parsed);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [rawKey, item] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim().replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
    if (key && item != null) result[key] = String(item).trim();
  }
  return result;
}

function shardFor(value: string) {
  const shards = Math.max(1, Number(process.env.QUEUE_SHARDS ?? "16"));
  const hash = createHash("sha256").update(value).digest().readUInt32BE(0);
  return String(hash % shards).padStart(2, "0");
}

function agentIsOnline(agent: Record<string, unknown>, now: number, freshness = workerOnlineFreshness) {
  return agent.status === "online" && now - Number(agent.lastHeartbeat || 0) < freshness;
}

function parseSharedEmails(value: string) {
  const values = value.split(/[\s,;]+/).map(normalizeWorkerEmail).filter(Boolean);
  const emails = [...new Set(values)];
  const invalid = emails.find((email) => !z.string().email().safeParse(email).success);
  if (invalid) return null;
  return emails;
}

async function userCanAccessCredential(workspaceId: string, credentialId: string, user: { uid: string; email?: string }) {
  if (!credentialId) return true;
  const credential = (await adminDatabase.ref(`workspaces/${workspaceId}/credentials/${credentialId}`).get()).val();
  return Boolean(credential && canAccessCredential(credential as CredentialAccessRecord, user));
}

function isWorkerContainerRecord(container: Record<string, unknown>) {
  const name = String(container.name || "").toLowerCase();
  const composeService = String(container.composeService || "").toLowerCase();
  return Boolean(
    container.isWorkerContainer ||
      composeService === "worker" ||
      /(^|[-_])worker([-_]1)?$/.test(name),
  );
}

async function recordFailedDeployment(input: {
  workspaceId: string;
  repositoryId: string;
  containerId?: string;
  containerRef?: string;
  action: JobAction;
  targetWorkerId: string;
  requestedBy: string;
  requestedByEmail?: string;
  message: string;
}) {
  const createdAt = Date.now();
  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const appLogRef = adminDatabase.ref(`workspaces/${input.workspaceId}/app_logs`).push();
  const job = {
    id: jobId,
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    containerId: input.containerId || "",
    containerRef: input.containerRef || "",
    action: input.action,
    poolId: "default",
    shardId: shardFor(input.repositoryId),
    targetWorkerId: input.targetWorkerId,
    status: "failed",
    progress: 0,
    attempt: 0,
    requestedBy: input.requestedBy,
    createdAt,
    finishedAt: createdAt,
    message: input.message,
  };
  await adminDatabase.ref().update({
    [`jobs/${jobId}`]: job,
    [`workspaces/${input.workspaceId}/deployments/${jobId}`]: job,
    [`workspaces/${input.workspaceId}/app_logs/${appLogRef.key}`]: {
      id: appLogRef.key,
      actorType: "ui",
      actorId: input.requestedBy,
      actorEmail: input.requestedByEmail || "",
      userId: input.requestedBy,
      userEmail: input.requestedByEmail || "",
      runtime: "web",
      functionName: "recordFailedDeployment",
      action: input.action,
      source: "server_action.preflight",
      severity: "error",
      message: sanitizeAppLogMessage(input.message),
      context: { jobId, repositoryId: input.repositoryId, containerId: input.containerId || "", targetWorkerId: input.targetWorkerId },
      createdAt,
    },
  });
}

async function resolveContainerTarget(input: {
  workspaceId: string;
  containerId: string;
  submittedContainerRef?: string;
  createdAt: number;
  action: JobAction;
  requestedBy: string;
  requestedByEmail: string;
}) {
  const workspaceRoot = `workspaces/${input.workspaceId}`;
  const existing = await adminDatabase.ref(`${workspaceRoot}/containers/${input.containerId}`).get();
  if (!existing.exists()) throw new Error("Container not found");
  const container = existing.val() as Record<string, unknown>;
  const targetWorkerId = String(container.workerId || "");
  const containerRef = String(container.dockerId || container.name || input.submittedContainerRef || input.containerId);
  if (!targetWorkerId) {
    await recordFailedDeployment({ workspaceId: input.workspaceId, repositoryId: "", containerId: input.containerId, containerRef, action: input.action, targetWorkerId, requestedBy: input.requestedBy, requestedByEmail: input.requestedByEmail, message: "Container has no assigned worker" });
    return null;
  }
  const targetWorker = (await adminDatabase.ref(`${workspaceRoot}/agents/${targetWorkerId}`).get()).val();
  if (!targetWorker || !canAccessWorker(targetWorker as WorkerAccessRecord, { uid: input.requestedBy, email: input.requestedByEmail })) {
    await recordFailedDeployment({ workspaceId: input.workspaceId, repositoryId: "", containerId: input.containerId, containerRef, action: input.action, targetWorkerId, requestedBy: input.requestedBy, requestedByEmail: input.requestedByEmail, message: "Worker is not available to this user" });
    return null;
  }
  if (!targetWorker || !agentIsOnline(targetWorker, input.createdAt)) {
    await recordFailedDeployment({ workspaceId: input.workspaceId, repositoryId: "", containerId: input.containerId, containerRef, action: input.action, targetWorkerId, requestedBy: input.requestedBy, requestedByEmail: input.requestedByEmail, message: "Container worker is not available" });
    return null;
  }
  if (isWorkerContainerRecord(container) && ["container_stop", "container_delete", "container_exec"].includes(input.action)) {
    await recordFailedDeployment({ workspaceId: input.workspaceId, repositoryId: "", containerId: input.containerId, containerRef, action: input.action, targetWorkerId, requestedBy: input.requestedBy, requestedByEmail: input.requestedByEmail, message: "Worker containers can only be restarted or inspected with logs" });
    return null;
  }
  if (isWorkerContainerRecord(container) && input.action === "tunnel_start") {
    await recordFailedDeployment({ workspaceId: input.workspaceId, repositoryId: "", containerId: input.containerId, containerRef, action: input.action, targetWorkerId, requestedBy: input.requestedBy, requestedByEmail: input.requestedByEmail, message: "Worker containers cannot be exposed publicly" });
    return null;
  }
  if (["container_stop", "container_restart", "container_logs", "container_exec"].includes(input.action) && container.status !== "running") {
    await recordFailedDeployment({ workspaceId: input.workspaceId, repositoryId: "", containerId: input.containerId, containerRef, action: input.action, targetWorkerId, requestedBy: input.requestedBy, requestedByEmail: input.requestedByEmail, message: "Container is not running" });
    return null;
  }
  if (input.action === "tunnel_start" && container.status !== "running") {
    await recordFailedDeployment({ workspaceId: input.workspaceId, repositoryId: "", containerId: input.containerId, containerRef, action: input.action, targetWorkerId, requestedBy: input.requestedBy, requestedByEmail: input.requestedByEmail, message: "Container must be running to regenerate its public URL" });
    return null;
  }
  return {
    container,
    targetWorker,
    targetWorkerId,
    containerRef,
    poolId: String(container.poolId || targetWorker.poolId || "default"),
  };
}

export async function saveRepository(formData: FormData) {
  const user = await requireSession("operator");
  const input = repositorySchema.parse(formObject(formData));
  const repositoryId = input.repositoryId || input.alias;
  const now = Date.now();
  const currentRef = adminDatabase.ref(`workspaces/${user.workspaceId}/repositories/${repositoryId}`);
  const current = (await currentRef.get()).val() as (Repository & RepositoryAccessRecord) | null;
  const currentOwnerUid = current ? repositoryOwnerUid(current) : "";
  if (current && currentOwnerUid && !canManageRepository(current, user)) throw new Error("Repository is owned by another user");
  if (current && !currentOwnerUid) throw new Error("Legacy repository has no owner. Remove it before registering it again");
  if (!(await userCanAccessCredential(user.workspaceId, input.credentialId, user))) throw new Error("Credential is not available to this user");
  if (input.defaultWorkerId) {
    const worker = (await adminDatabase.ref(`workspaces/${user.workspaceId}/agents/${input.defaultWorkerId}`).get()).val();
    if (!worker || !canAccessWorker(worker as WorkerAccessRecord, user)) throw new Error("Default worker is not available to this user");
  }
  const sharedEmails = input.sharing === "shared" ? parseSharedEmails(input.sharedEmails) : [];
  if (!sharedEmails) throw new Error("Enter valid email addresses to share this repository");
  const ownerUid = currentOwnerUid || user.uid;
  const environment = parseEnvironment(input.environmentJson, input.environmentFormat, current?.environment ?? {});
  const publicTunnelDomains = input.publicTunnelDomainsJson ? normalizeStringMap(input.publicTunnelDomainsJson) : current?.publicTunnelDomains ?? {};
  const publicTunnelPorts = input.publicTunnelPortsJson ? normalizeStringMap(input.publicTunnelPortsJson) : current?.publicTunnelPorts ?? {};
  const repositoriesSnapshot = await adminDatabase.ref(`workspaces/${user.workspaceId}/repositories`).get();
  assertConfiguredPortsAvailable({
    repositoryId,
    poolId: input.poolId,
    mode: input.mode,
    ports: input.ports,
    repositories: (repositoriesSnapshot.val() ?? {}) as Record<string, Partial<Repository>>,
  });
  const repositoryPayload = {
    id: repositoryId,
    alias: input.alias,
    url: input.url,
    branch: input.branch,
    mode: input.mode,
    composeFile: input.composeFile || defaultComposeFile,
    dockerfile: input.dockerfile || "Dockerfile",
    credentialId: input.credentialId,
    environment,
    domain: input.domain,
    service: input.service || "web",
    internalPort: input.internalPort,
    ports: input.ports,
    publicTunnelEnabled: input.publicTunnelEnabled,
    publicTunnelDomain: input.publicTunnelDomain,
    publicTunnelDomains,
    publicTunnelPorts,
    publicUrl: current?.publicUrl ?? "",
    publicUrls: current?.publicUrls ?? {},
    publicTunnels: current?.publicTunnels ?? {},
    publicTunnelStatus: current?.publicTunnelStatus ?? "stopped",
    publicTunnelTarget: current?.publicTunnelTarget ?? "",
    publicTunnelWorkerId: current?.publicTunnelWorkerId ?? "",
    publicTunnelWorkerLabel: current?.publicTunnelWorkerLabel ?? "",
    publicTunnelUpdatedAt: current?.publicTunnelUpdatedAt ?? 0,
    ngrokTokenSecret: current?.ngrokTokenSecret || Boolean(input.ngrokAuthtoken),
    ngrokTokenMask: input.ngrokAuthtoken ? secretMask(input.ngrokAuthtoken) : current?.ngrokTokenMask ?? "",
    poolId: input.poolId,
    defaultWorkerId: input.defaultWorkerId,
    scope: "workspace" as const,
    sharing: input.sharing,
    shared: input.sharing === "shared" || input.sharing === "public",
    public: input.sharing === "public",
    sharedEmails,
    ownerUid,
    ownerEmail: current?.ownerEmail || normalizeRepositoryEmail(user.email),
    sharingUpdatedAt: current?.sharing === input.sharing && JSON.stringify(current?.sharedEmails || []) === JSON.stringify(sharedEmails)
      ? current?.sharingUpdatedAt || now
      : now,
    sharingUpdatedBy: current?.sharing === input.sharing && JSON.stringify(current?.sharedEmails || []) === JSON.stringify(sharedEmails)
      ? current?.sharingUpdatedBy || ownerUid
      : user.uid,
    createdAt: current?.createdAt ?? now,
    createdBy: current?.createdBy ?? ownerUid,
    updatedAt: now,
    updatedBy: user.uid,
  };
  const updates: Record<string, unknown> = {
    [`workspaces/${user.workspaceId}/repositories/${repositoryId}`]: repositoryPayload,
  };
  if (input.ngrokAuthtoken) {
    updates[`secrets/ngrok/${user.workspaceId}/${repositoryId}`] = {
      ...encryptSecret(input.ngrokAuthtoken),
      updatedAt: now,
      updatedBy: user.uid,
    };
  }
  await adminDatabase.ref().update(updates);
  revalidatePath("/dashboard");
}

export async function saveRepositoryDefaultWorker(formData: FormData) {
  const user = await requireSession("operator");
  const repositoryId = z.string().min(1).parse(formData.get("repositoryId"));
  const defaultWorkerId = z.string().trim().default("").parse(formData.get("defaultWorkerId") || "");
  const repositoryRef = adminDatabase.ref(`workspaces/${user.workspaceId}/repositories/${repositoryId}`);
  const repository = (await repositoryRef.get()).val() as RepositoryAccessRecord | null;
  if (!repository) throw new Error("Project not found");
  if (!canManageRepository(repository, user)) throw new Error("Only the project owner can change its default worker");
  if (defaultWorkerId) {
    const worker = (await adminDatabase.ref(`workspaces/${user.workspaceId}/agents/${defaultWorkerId}`).get()).val();
    if (!worker || !canAccessWorker(worker as WorkerAccessRecord, user)) throw new Error("Worker is not available to this user");
  }
  await repositoryRef.update({ defaultWorkerId, updatedAt: Date.now(), updatedBy: user.uid });
  revalidatePath("/dashboard");
}

export async function saveRepositoryWithState(_previousState: RepositorySaveState, formData: FormData): Promise<RepositorySaveState> {
  try {
    const isEditing = Boolean(formData.get("repositoryId"));
    const registrationMode = String(formData.get("registrationMode") || "register");
    await saveRepository(formData);
    if (!isEditing && registrationMode === "register_clone") {
      const cloneRequest = new FormData();
      cloneRequest.set("repositoryId", String(formData.get("alias") || ""));
      cloneRequest.set("action", "sync");
      cloneRequest.set("targetWorkerId", String(formData.get("defaultWorkerId") || ""));
      const cloneResult = await enqueueDeploymentRequest(cloneRequest);
      if (cloneResult.status === "error") {
        return { status: "error", message: `Project registered, but clone could not start: ${cloneResult.message}` };
      }
      return { status: "success", message: "Project registered. Clone queued on the selected worker." };
    }
    return { status: "success", message: isEditing ? "Project settings saved." : "Project registered." };
  } catch (error) {
    console.error("saveRepository failed", error);
    const user = await requireSession();
    await writeUiAppLog({ workspaceId: user.workspaceId, user, action: "save_repository", source: "server_action", functionName: "saveRepositoryWithState", message: error, context: { repositoryId: String(formData.get("repositoryId") || formData.get("alias") || "") } }).catch(console.error);
    if (error instanceof z.ZodError) {
      return { status: "error", message: error.issues[0]?.message || "Check the repository fields and try again." };
    }
    const message = error instanceof Error ? error.message : "Project could not be saved.";
    if (message === "Repository is owned by another user") {
      return { status: "error", message: "That repository name is already registered by another user. Choose another display name or ask its owner to share it." };
    }
    if (message.startsWith("Legacy repository has no owner")) {
      return { status: "error", message: "That repository name belongs to a legacy record. Remove or migrate that record before registering it again." };
    }
    return { status: "error", message };
  }
}

export async function importRepositoriesJson(formData: FormData) {
  const user = await requireSession("operator");
  const raw = z.string().min(2).parse(formData.get("repositoriesJson"));
  const parsed = parseJsonInput(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Repository import must be a JSON object");

  const entries = "url" in parsed
    ? [[undefined, parsed]]
    : Object.entries(parsed as Record<string, unknown>);
  const updates: Record<string, unknown> = {};
  const now = Date.now();
  const existingSnapshot = await adminDatabase.ref(`workspaces/${user.workspaceId}/repositories`).get();
  const existingRepositories = (existingSnapshot.val() ?? {}) as Record<string, RepositoryAccessRecord & Partial<Repository>>;
  const repositoriesWithImports: Record<string, Partial<Repository>> = { ...existingRepositories };

  for (const [key, value] of entries) {
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(`Invalid repository '${key || "repository"}'`);
    const input = repositoryImportSchema.parse({ ...(value as Record<string, unknown>), alias: (value as Record<string, unknown>).alias ?? key });
    const repositoryId = input.id || input.alias || input.name || aliasFromUrl(input.url);
    if (!aliasPattern.test(repositoryId)) throw new Error(`Invalid repository alias '${repositoryId}'`);
    const current = existingRepositories[repositoryId];
    const currentOwnerUid = current ? repositoryOwnerUid(current) : "";
    if (current && currentOwnerUid && !canManageRepository(current, user)) throw new Error(`Repository '${repositoryId}' is owned by another user`);
    if (current && !currentOwnerUid) throw new Error(`Legacy repository '${repositoryId}' has no owner. Remove it before importing it again`);
    const branch = input.branch || "";
    if (branch && !branchPattern.test(branch)) throw new Error(`Invalid branch for '${repositoryId}'`);
    const credentialId = input.credentialId || input.credential || "";
    if (!(await userCanAccessCredential(user.workspaceId, credentialId, user))) throw new Error(`Credential is not available for '${repositoryId}'`);
    const environment = {
      ...normalizeEnvironment(input.env_vars),
      ...normalizeEnvironment(input.environment),
    };
    const ngrokAuthtoken = input.ngrokAuthtoken || input.ngrok_authtoken || input.ngrokApiKey || input.ngrok_api_key || "";
    const createdAt = input.createdAt || (input.added_at ? Date.parse(input.added_at) : NaN);
    const sharing = current ? repositorySharingMode(current) : "private";
    const ownerUid = currentOwnerUid || user.uid;
    const repositoryPayload = {
      id: repositoryId,
      alias: repositoryId,
      url: input.url,
      branch,
      mode: input.mode,
      composeFile: input.composeFile || input.compose_file || defaultComposeFile,
      dockerfile: input.dockerfile || "Dockerfile",
      credentialId,
      environment,
      env: typeof input.env === "string" ? input.env : "",
      domain: input.domain || "",
      service: input.service || "web",
      internalPort: input.internalPort || input.internal_port || 3000,
      ports: input.ports || "",
      publicTunnelEnabled: Boolean(input.publicTunnelEnabled ?? input.public_tunnel_enabled ?? input.exposePublic ?? input.expose_public),
      publicTunnelDomain: input.publicTunnelDomain || input.public_tunnel_domain || input.publicDomain || input.ngrokDomain || "",
      publicTunnelDomains: {
        ...normalizeStringMap(input.publicTunnelDomains),
        ...normalizeStringMap(input.public_tunnel_domains),
      },
      publicTunnelPorts: {
        ...normalizeStringMap(input.publicTunnelPorts),
        ...normalizeStringMap(input.public_tunnel_ports),
      },
      publicUrl: "",
      publicUrls: {},
      publicTunnels: {},
      publicTunnelStatus: "stopped",
      publicTunnelTarget: "",
      publicTunnelWorkerId: "",
      publicTunnelWorkerLabel: "",
      publicTunnelUpdatedAt: 0,
      ngrokTokenSecret: Boolean(ngrokAuthtoken),
      ngrokTokenMask: ngrokAuthtoken ? secretMask(ngrokAuthtoken) : "",
      poolId: input.poolId || input.pool_id || "default",
      scope: "workspace" as const,
      sharing,
      shared: sharing === "shared" || sharing === "public",
      public: sharing === "public",
      sharedEmails: current && Array.isArray(current.sharedEmails) ? current.sharedEmails : [],
      ownerUid,
      ownerEmail: current?.ownerEmail || normalizeRepositoryEmail(user.email),
      createdAt: current?.createdAt || (Number.isFinite(createdAt) ? createdAt : now),
      createdBy: current?.createdBy || ownerUid,
      updatedAt: now,
      updatedBy: user.uid,
    };
    assertConfiguredPortsAvailable({
      repositoryId,
      poolId: repositoryPayload.poolId,
      mode: repositoryPayload.mode,
      ports: repositoryPayload.ports,
      repositories: repositoriesWithImports,
    });
    repositoriesWithImports[repositoryId] = repositoryPayload;
    updates[`workspaces/${user.workspaceId}/repositories/${repositoryId}`] = repositoryPayload;
    if (ngrokAuthtoken) {
      updates[`secrets/ngrok/${user.workspaceId}/${repositoryId}`] = {
        ...encryptSecret(ngrokAuthtoken),
        updatedAt: now,
        updatedBy: user.uid,
      };
    }
  }

  if (!Object.keys(updates).length) throw new Error("No repositories to import");
  await adminDatabase.ref().update(updates);
  revalidatePath("/dashboard");
}

export async function saveCredential(formData: FormData) {
  const user = await requireSession("admin");
  const input = credentialSchema.parse(formObject(formData));
  const credentialRef = adminDatabase.ref(`workspaces/${user.workspaceId}/credentials/${input.alias}`);
  const current = (await credentialRef.get()).val() as CredentialAccessRecord | null;
  const currentOwnerUid = current ? credentialOwnerUid(current) : "";
  if (currentOwnerUid && current && !canManageCredential(current, user)) throw new Error("Credential alias is already owned by another user");
  const encrypted = encryptSecret(input.token);
  const now = Date.now();
  const sharing = current ? credentialSharingMode(current) : "private";
  const ownerUid = currentOwnerUid || user.uid;
  const updates: Record<string, unknown> = {
    [`secrets/credentials/${user.workspaceId}/${input.alias}`]: {
      ...encrypted,
      username: input.username,
      updatedAt: now,
      updatedBy: user.uid,
    },
    [`workspaces/${user.workspaceId}/credentials/${input.alias}`]: {
      id: input.alias,
      alias: input.alias,
      username: input.username,
      tokenMask: input.token.length > 8 ? `${input.token.slice(0, 4)}••••••••${input.token.slice(-4)}` : "••••••••",
      scope: "workspace",
      sharing,
      shared: sharing === "shared" || sharing === "public",
      public: sharing === "public",
      sharedEmails: current && Array.isArray(current.sharedEmails) ? current.sharedEmails : [],
      ownerUid,
      ownerEmail: current?.ownerEmail || normalizeCredentialEmail(user.email),
      createdAt: current?.createdAt || now,
      createdBy: current?.createdBy || ownerUid,
      updatedAt: now,
      updatedBy: user.uid,
    },
  };
  await adminDatabase.ref().update(updates);
  revalidatePath("/dashboard");
}

export async function saveCredentialsJson(formData: FormData) {
  const user = await requireSession("admin");
  const raw = z.string().min(2).parse(formData.get("credentialsJson"));
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Credential JSON must be an object keyed by alias");
  const updates: Record<string, unknown> = {};
  const now = Date.now();
  const existingSnapshot = await adminDatabase.ref(`workspaces/${user.workspaceId}/credentials`).get();
  const existingCredentials = (existingSnapshot.val() ?? {}) as Record<string, CredentialAccessRecord>;
  for (const [alias, value] of Object.entries(parsed)) {
    if (!aliasPattern.test(alias) || !value || Array.isArray(value) || typeof value !== "object") throw new Error(`Invalid credential '${alias}'`);
    const item = value as Record<string, unknown>;
    const token = z.string().min(1).parse(item.token);
    const username = z.string().max(200).default("").parse(item.username);
    const current = existingCredentials[alias];
    const currentOwnerUid = current ? credentialOwnerUid(current) : "";
    if (currentOwnerUid && current && !canManageCredential(current, user)) throw new Error(`Credential '${alias}' is owned by another user`);
    const sharing = current ? credentialSharingMode(current) : "private";
    const ownerUid = currentOwnerUid || user.uid;
    updates[`secrets/credentials/${user.workspaceId}/${alias}`] = { ...encryptSecret(token), username, updatedAt: now, updatedBy: user.uid };
    updates[`workspaces/${user.workspaceId}/credentials/${alias}`] = {
      id: alias,
      alias,
      username,
      tokenMask: token.length > 8 ? `${token.slice(0, 4)}••••••••${token.slice(-4)}` : "••••••••",
      scope: "workspace",
      sharing,
      shared: sharing === "shared" || sharing === "public",
      public: sharing === "public",
      sharedEmails: current && Array.isArray(current.sharedEmails) ? current.sharedEmails : [],
      ownerUid,
      ownerEmail: current?.ownerEmail || normalizeCredentialEmail(user.email),
      createdAt: current?.createdAt || now,
      createdBy: current?.createdBy || ownerUid,
      updatedAt: now,
      updatedBy: user.uid,
    };
  }
  await adminDatabase.ref().update(updates);
  revalidatePath("/dashboard");
}

export async function saveCommandPreset(formData: FormData) {
  const user = await requireSession("operator");
  const input = commandPresetSchema.parse(formObject(formData));
  const commandId = input.commandId || aliasFromName(input.name);
  if (!aliasPattern.test(commandId)) throw new Error("Invalid command id");
  const now = Date.now();
  const ref = adminDatabase.ref(`workspaces/${user.workspaceId}/commandPresets/${commandId}`);
  const current = (await ref.get()).val();
  await ref.set({
    id: commandId,
    name: input.name,
    description: input.description,
    command: input.command,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
  });
  revalidatePath("/dashboard");
}

export async function deleteCommandPreset(formData: FormData) {
  const user = await requireSession("operator");
  const commandId = z.string().min(1).parse(formData.get("commandId"));
  await adminDatabase.ref(`workspaces/${user.workspaceId}/commandPresets/${commandId}`).remove();
  revalidatePath("/dashboard");
}

async function enqueueDeploymentRequest(formData: FormData): Promise<DeploymentQueueState> {
  const user = await requireSession("operator");
  const repositoryId = z.string().min(1).parse(formData.get("repositoryId"));
  const action = z.enum(["sync", "deploy", "stop", "build", "discover_branches", "read_compose", "tunnel_start", "tunnel_stop"]).parse(formData.get("action"));
  let targetWorkerId = z.string().trim().default("").parse(formData.get("targetWorkerId") || "");
  const repository = (
    await adminDatabase.ref(`workspaces/${user.workspaceId}/repositories/${repositoryId}`).get()
  ).val();
  if (!repository) throw new Error("Repository not found");
  if (!canAccessRepository(repository as RepositoryAccessRecord, user)) throw new Error("Repository is not available to this user");
  targetWorkerId ||= String(repository.defaultWorkerId || "");
  const createdAt = Date.now();
  const requiresRepositoryCredential = ["sync", "deploy", "build", "discover_branches", "read_compose"].includes(action);
  if (requiresRepositoryCredential && !(await userCanAccessCredential(user.workspaceId, String(repository.credentialId || ""), user))) {
    const message = "Repository credential is not available to this user";
    await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId, action, targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message });
    return { status: "error", message };
  }
  if (!targetWorkerId) {
    const message = "Select a worker before running this action";
    await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId, action, targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message });
    return { status: "error", message };
  }
  const targetWorker = targetWorkerId
    ? (await adminDatabase.ref(`workspaces/${user.workspaceId}/agents/${targetWorkerId}`).get()).val()
    : null;
  if (targetWorkerId && !targetWorker) {
    const message = "Worker not found";
    await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId, action, targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message });
    return { status: "error", message };
  }
  if (targetWorkerId && !canAccessWorker(targetWorker as WorkerAccessRecord, user)) {
    const message = "Worker is not available to this user";
    await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId, action, targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message });
    return { status: "error", message };
  }
  if (targetWorkerId && !agentIsOnline(targetWorker, createdAt)) {
    const message = "Worker is not available";
    await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId, action, targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message });
    return { status: "error", message };
  }
  if (["deploy", "build"].includes(action)) {
    const portCollision = await findOpenDeploymentPortCollision({
      workspaceId: user.workspaceId,
      repositoryId,
      repository: repository as Partial<Repository>,
      targetWorkerId,
    });
    if (portCollision) {
      await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId, action, targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message: portCollision });
      return { status: "error", message: portCollision };
    }
  }
  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const shardId = shardFor(repositoryId);
  const poolId = targetWorker?.poolId || repository.poolId || "default";
  const job = {
    id: jobId,
    workspaceId: user.workspaceId,
    repositoryId,
    action,
    poolId,
    shardId,
    targetWorkerId,
    status: "queued",
    progress: 0,
    attempt: 0,
    idempotencyKey: `${user.workspaceId}:${repositoryId}:${action}:${targetWorkerId || "any"}:${createdAt}`,
    requestedBy: user.uid,
    requestedByEmail: user.email,
    createdAt,
  };
  await adminDatabase.ref().update({
    [`jobs/${jobId}`]: job,
    [`queues/${poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100, targetWorkerId },
    [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job,
  });
  return { status: "success", message: `${action} queued.` };
}

export async function enqueueDeployment(formData: FormData) {
  await enqueueDeploymentRequest(formData);
}

export async function enqueueDeploymentWithState(
  _previousState: DeploymentQueueState,
  formData: FormData,
): Promise<DeploymentQueueState> {
  try {
    const result = await enqueueDeploymentRequest(formData);
    return result;
  } catch (error) {
    console.error("enqueueDeployment failed", error);
    const user = await requireSession();
    await writeUiAppLog({ workspaceId: user.workspaceId, user, action: String(formData.get("action") || "deployment"), source: "server_action", functionName: "enqueueDeploymentWithState", message: error, context: { repositoryId: String(formData.get("repositoryId") || ""), targetWorkerId: String(formData.get("targetWorkerId") || "") } }).catch(console.error);
    return { status: "error", message: error instanceof Error ? error.message : "Deployment could not be created." };
  }
}

export async function enqueueAllRepositories() {
  const user = await requireSession("operator");
  const workspaceRoot = `workspaces/${user.workspaceId}`;
  const [repositoriesSnapshot, agentsSnapshot, credentialsSnapshot] = await Promise.all([
    adminDatabase.ref(`${workspaceRoot}/repositories`).get(),
    adminDatabase.ref(`${workspaceRoot}/agents`).get(),
    adminDatabase.ref(`${workspaceRoot}/credentials`).get(),
  ]);
  const repositories = repositoriesSnapshot.val() ?? {};
  const agents = (agentsSnapshot.val() ?? {}) as Record<string, WorkerAccessRecord>;
  const credentials = (credentialsSnapshot.val() ?? {}) as Record<string, CredentialAccessRecord>;
  const updates: Record<string, unknown> = {};
  const createdAt = Date.now();
  const targets = Object.entries(agents)
    .filter(([, agent]) => canAccessWorker(agent, user) && agentIsOnline(agent, createdAt))
    .map(([workerId, agent]) => ({ workerId, poolId: String(agent.poolId || "default") }));
  if (!targets.length) return;
  let targetIndex = 0;
  for (const [repositoryId, repository] of Object.entries(repositories) as [string, Record<string, string>][]) {
    if (!canAccessRepository(repository as RepositoryAccessRecord, user)) continue;
    const credentialId = repository.credentialId || "";
    if (credentialId && (!credentials[credentialId] || !canAccessCredential(credentials[credentialId], user))) continue;
    const target = targets[targetIndex % targets.length];
    targetIndex += 1;
    const jobRef = adminDatabase.ref("jobs").push();
    const jobId = jobRef.key!;
    const shardId = shardFor(repositoryId);
    const job = { id: jobId, workspaceId: user.workspaceId, repositoryId, action: "sync", poolId: target.poolId, shardId, targetWorkerId: target.workerId, status: "queued", progress: 0, attempt: 0, requestedBy: user.uid, requestedByEmail: user.email, createdAt };
    updates[`jobs/${jobId}`] = job;
    updates[`queues/${target.poolId}/${shardId}/${jobId}`] = { createdAt, priority: 100, targetWorkerId: target.workerId };
    updates[`workspaces/${user.workspaceId}/deployments/${jobId}`] = job;
  }
  await adminDatabase.ref().update(updates);
}

export async function enqueueContainerAction(formData: FormData) {
  const user = await requireSession("operator");
  const containerId = z.string().min(1).parse(formData.get("containerId"));
  const submittedContainerRef = z.string().optional().parse(formData.get("containerRef") || undefined);
  const action = z.enum(["container_start", "container_stop", "container_restart", "container_delete", "container_logs"]).parse(formData.get("action"));
  const createdAt = Date.now();
  const target = await resolveContainerTarget({ workspaceId: user.workspaceId, containerId, submittedContainerRef, createdAt, action, requestedBy: user.uid, requestedByEmail: user.email });
  if (!target) return;
  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const shardId = shardFor(containerId);
  const poolId = target.poolId;
  const targetWorkerId = target.targetWorkerId;
  const containerRef = target.containerRef;
  const job = { id: jobId, workspaceId: user.workspaceId, containerId, containerRef, repositoryId: "", action, poolId, shardId, targetWorkerId, status: "queued", progress: 0, attempt: 0, requestedBy: user.uid, requestedByEmail: user.email, createdAt };
  await adminDatabase.ref().update({ [`jobs/${jobId}`]: job, [`queues/${poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100, targetWorkerId }, [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job });
}

export async function enqueueWorkerCommand(formData: FormData) {
  const user = await requireSession("operator");
  const targetWorkerId = z.string().min(1).parse(formData.get("targetWorkerId"));
  const repositoryId = z.string().trim().default("").parse(formData.get("repositoryId") || "");
  const command = z.string().trim().min(1).max(4000).parse(formData.get("command"));
  const timeoutSeconds = z.coerce.number().int().min(5).max(1800).default(600).parse(formData.get("timeoutSeconds") || 600);
  const createdAt = Date.now();
  const workspaceRoot = `workspaces/${user.workspaceId}`;
  const targetWorker = (await adminDatabase.ref(`${workspaceRoot}/agents/${targetWorkerId}`).get()).val();
  if (!targetWorker) {
    await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId: repositoryId || "worker-command", action: "worker_command", targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message: "Worker not found" });
    return;
  }
  if (!canAccessWorker(targetWorker as WorkerAccessRecord, user)) {
    await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId: repositoryId || "worker-command", action: "worker_command", targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message: "Worker is not available to this user" });
    return;
  }
  if (!agentIsOnline(targetWorker, createdAt)) {
    await recordFailedDeployment({ workspaceId: user.workspaceId, repositoryId: repositoryId || "worker-command", action: "worker_command", targetWorkerId, requestedBy: user.uid, requestedByEmail: user.email, message: "Worker is not available" });
    return;
  }
  if (repositoryId) {
    const repositorySnapshot = await adminDatabase.ref(`${workspaceRoot}/repositories/${repositoryId}`).get();
    if (!repositorySnapshot.exists()) throw new Error("Repository not found");
    if (!canAccessRepository(repositorySnapshot.val() as RepositoryAccessRecord, user)) throw new Error("Repository is not available to this user");
  }

  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const shardId = shardFor(`worker-command:${targetWorkerId}:${createdAt}`);
  const poolId = String(targetWorker.poolId || "default");
  const job = {
    id: jobId,
    workspaceId: user.workspaceId,
    repositoryId,
    action: "worker_command",
    command,
    timeoutSeconds,
    poolId,
    shardId,
    targetWorkerId,
    status: "queued",
    progress: 0,
    attempt: 0,
    requestedBy: user.uid,
    requestedByEmail: user.email,
    createdAt,
  };
  await adminDatabase.ref().update({
    [`jobs/${jobId}`]: job,
    [`queues/${poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100, targetWorkerId },
    [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job,
  });
}

export async function enqueueContainerCommand(formData: FormData) {
  const user = await requireSession("operator");
  const containerId = z.string().min(1).parse(formData.get("containerId"));
  const submittedContainerRef = z.string().optional().parse(formData.get("containerRef") || undefined);
  const command = z.string().trim().min(1).max(4000).parse(formData.get("command"));
  const timeoutSeconds = z.coerce.number().int().min(5).max(1800).default(600).parse(formData.get("timeoutSeconds") || 600);
  const createdAt = Date.now();
  const target = await resolveContainerTarget({ workspaceId: user.workspaceId, containerId, submittedContainerRef, createdAt, action: "container_exec", requestedBy: user.uid, requestedByEmail: user.email });
  if (!target) return;

  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const shardId = shardFor(containerId);
  const poolId = target.poolId;
  const containerRef = target.containerRef;
  const targetWorkerId = target.targetWorkerId;
  const job = {
    id: jobId,
    workspaceId: user.workspaceId,
    containerId,
    containerRef,
    repositoryId: "",
    action: "container_exec",
    command,
    timeoutSeconds,
    poolId,
    shardId,
    targetWorkerId,
    status: "queued",
    progress: 0,
    attempt: 0,
    requestedBy: user.uid,
    requestedByEmail: user.email,
    createdAt,
  };
  await adminDatabase.ref().update({
    [`jobs/${jobId}`]: job,
    [`queues/${poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100, targetWorkerId },
    [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job,
  });
}

export async function enqueueContainerTunnelRefresh(formData: FormData) {
  const user = await requireSession("operator");
  const containerId = z.string().min(1).parse(formData.get("containerId"));
  const submittedContainerRef = z.string().optional().parse(formData.get("containerRef") || undefined);
  const createdAt = Date.now();
  const target = await resolveContainerTarget({ workspaceId: user.workspaceId, containerId, submittedContainerRef, createdAt, action: "tunnel_start", requestedBy: user.uid, requestedByEmail: user.email });
  if (!target) return;

  const container = target.container as Record<string, unknown>;
  const repositories = (await adminDatabase.ref(`workspaces/${user.workspaceId}/repositories`).get()).val() ?? {};
  const containerProject = safeDockerName(String(container.project || ""));
  const containerName = safeDockerName(String(container.name || ""));
  const match = Object.entries(repositories as Record<string, Record<string, unknown>>).find(([repositoryId, repository]) => {
    if (!canAccessRepository(repository as RepositoryAccessRecord, user)) return false;
    const alias = safeDockerName(String(repository.alias || repositoryId));
    return Boolean(alias && (alias === containerProject || alias === containerName));
  });
  if (!match) {
    const jobRef = adminDatabase.ref("jobs").push();
    const jobId = jobRef.key!;
    const shardId = shardFor(`container-tunnel:${containerId}:${createdAt}`);
    const internalPort = Number(String((Array.isArray(container.ports) ? container.ports[0] : "") || "").match(/->(\d+)/)?.[1] || 3000);
    const job = { id: jobId, workspaceId: user.workspaceId, repositoryId: "", containerId, containerRef: target.containerRef, action: "container_tunnel_start", internalPort, tunnelReset: true, poolId: target.poolId, shardId, targetWorkerId: target.targetWorkerId, status: "queued", progress: 0, attempt: 0, requestedBy: user.uid, requestedByEmail: user.email, createdAt };
    await adminDatabase.ref().update({
      [`jobs/${jobId}`]: job,
      [`queues/${target.poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100, targetWorkerId: target.targetWorkerId },
      [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job,
    });
    return;
  }

  const [repositoryId, repository] = match;
  const tunnelService = String(container.composeService || repository.service || "app").trim();
  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const shardId = shardFor(`tunnel:${containerId}:${createdAt}`);
  const job = {
    id: jobId,
    workspaceId: user.workspaceId,
    repositoryId,
    containerId,
    containerRef: target.containerRef,
    action: "tunnel_start",
    tunnelService,
    tunnelReset: true,
    poolId: target.poolId,
    shardId,
    targetWorkerId: target.targetWorkerId,
    status: "queued",
    progress: 0,
    attempt: 0,
    requestedBy: user.uid,
    requestedByEmail: user.email,
    createdAt,
  };
  await adminDatabase.ref().update({
    [`jobs/${jobId}`]: job,
    [`queues/${target.poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100, targetWorkerId: target.targetWorkerId },
    [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job,
  });
}

export async function enqueueAllContainerLogs() {
  const user = await requireSession("operator");
  const workspaceRoot = `workspaces/${user.workspaceId}`;
  const containers = (await adminDatabase.ref(`${workspaceRoot}/containers`).get()).val() ?? {};
  const agents = (await adminDatabase.ref(`${workspaceRoot}/agents`).get()).val() ?? {};
  const updates: Record<string, unknown> = {};
  const createdAt = Date.now();
  for (const [containerId, container] of Object.entries(containers) as [string, Record<string, string>][]) {
    if (container.status !== "running") continue;
    const targetWorkerId = container.workerId || "";
    const containerRef = container.dockerId || container.name || containerId;
    const targetWorker = targetWorkerId ? (agents as Record<string, Record<string, unknown>>)[targetWorkerId] : null;
    if (!targetWorker || !canAccessWorker(targetWorker as WorkerAccessRecord, user) || !agentIsOnline(targetWorker, createdAt)) continue;
    const jobRef = adminDatabase.ref("jobs").push();
    const jobId = jobRef.key!;
    const shardId = shardFor(containerId);
    const poolId = String(container.poolId || targetWorker.poolId || "default");
    const job = {
      id: jobId,
      workspaceId: user.workspaceId,
      containerId,
      containerRef,
      repositoryId: "",
      action: "container_logs",
      poolId,
      shardId,
      targetWorkerId,
      status: "queued",
      progress: 0,
      attempt: 0,
      requestedBy: user.uid,
      requestedByEmail: user.email,
      createdAt,
    };
    updates[`jobs/${jobId}`] = job;
    updates[`queues/${poolId}/${shardId}/${jobId}`] = { createdAt, priority: 100, targetWorkerId };
    updates[`workspaces/${user.workspaceId}/deployments/${jobId}`] = job;
  }
  if (Object.keys(updates).length) await adminDatabase.ref().update(updates);
}

export async function enqueueInventoryRefresh() {
  try {
    const user = await requireSession("operator");
    const createdAt = Date.now();
    const agents = (await adminDatabase.ref(`workspaces/${user.workspaceId}/agents`).get()).val() ?? {};
    const targets = Object.entries(agents as Record<string, Record<string, string>>)
      .map(([agentId, agent]) => ({ agentId, poolId: agent.poolId || "default" }))
      .filter((agent) => {
        const record = (agents as Record<string, Record<string, string | number>>)[agent.agentId] || {};
        return agent.agentId && canAccessWorker(record as WorkerAccessRecord, user) && agentIsOnline(record, createdAt);
      });
    if (!targets.length) return { ok: false, message: "No online workers are available to refresh deployments." };
    const updates: Record<string, unknown> = {};
    for (const target of targets) {
      const jobRef = adminDatabase.ref("jobs").push();
      const jobId = jobRef.key!;
      const shardId = shardFor(`inventory:${user.workspaceId}:${target.agentId || "default"}`);
      const job = {
        id: jobId, workspaceId: user.workspaceId, containerId: "", repositoryId: "", action: "inventory_refresh",
        poolId: target.poolId, shardId, targetWorkerId: target.agentId, status: "queued", progress: 0, attempt: 0,
        requestedBy: user.uid, requestedByEmail: user.email, createdAt,
      };
      updates[`jobs/${jobId}`] = job;
      updates[`queues/${target.poolId}/${shardId}/${jobId}`] = { createdAt, priority: 100, targetWorkerId: target.agentId };
      updates[`workspaces/${user.workspaceId}/deployments/${jobId}`] = job;
    }
    await adminDatabase.ref().update(updates);
    return { ok: true, message: `Refreshing deployments on ${targets.length} worker${targets.length === 1 ? "" : "s"}.` };
  } catch (error) {
    console.error("enqueueInventoryRefresh failed", error);
    return { ok: false, message: "Deployment refresh could not be queued. Please try again." };
  }
}

export async function deleteWorker(formData: FormData) {
  try {
    const user = await requireSession("operator");
    const workerId = z.string().min(1).parse(formData.get("workerId"));
    const workspaceRoot = `workspaces/${user.workspaceId}`;
    const agentSnapshot = await adminDatabase.ref(`${workspaceRoot}/agents/${workerId}`).get();
    if (!agentSnapshot.exists()) return;
    const agent = agentSnapshot.val() as Record<string, unknown>;
    if (!canManageWorker(agent as WorkerAccessRecord, user)) return;
    const now = Date.now();
    const lastHeartbeat = Number(agent.lastHeartbeat || 0);
    if (agent.status === "online" || agent.status === "stopping" || now - lastHeartbeat < orphanWorkerDeleteAge) return;

    const deployments = (await adminDatabase.ref(`${workspaceRoot}/deployments`).get()).val() ?? {};
    const containers = (await adminDatabase.ref(`${workspaceRoot}/containers`).get()).val() ?? {};
    const ownedContainers = Object.entries(containers as Record<string, Record<string, unknown> | null>).filter(([, container]) => container?.workerId === workerId);

    const updates: Record<string, unknown> = { [`${workspaceRoot}/agents/${workerId}`]: null };
    for (const [jobId, job] of Object.entries(deployments as Record<string, Record<string, unknown> | null>)) {
      if (!job || !["queued", "leased", "running"].includes(String(job.status || ""))) continue;
      if (job.workerId !== workerId && job.targetWorkerId !== workerId) continue;
      const message = `Worker ${String(agent.label || workerId)} was removed`;
      updates[`jobs/${jobId}/status`] = "failed";
      updates[`jobs/${jobId}/finishedAt`] = now;
      updates[`jobs/${jobId}/message`] = message;
      updates[`${workspaceRoot}/deployments/${jobId}/status`] = "failed";
      updates[`${workspaceRoot}/deployments/${jobId}/finishedAt`] = now;
      updates[`${workspaceRoot}/deployments/${jobId}/message`] = message;
      if (job.poolId && job.shardId) updates[`queues/${String(job.poolId)}/${String(job.shardId)}/${jobId}`] = null;
    }
    for (const [containerId] of ownedContainers) {
      updates[`${workspaceRoot}/containers/${containerId}`] = null;
    }
    await adminDatabase.ref().update(updates);
    revalidatePath("/dashboard");
  } catch (error) {
    console.error("deleteWorker failed", error);
  }
}

export async function saveWorkerSharing(formData: FormData) {
  try {
    const user = await requireSession("operator");
    const parsed = workerSharingSchema.safeParse(formObject(formData));
    if (!parsed.success) return { ok: false, message: "Invalid worker sharing settings." };
    const input = parsed.data;
    const workspaceRoot = `workspaces/${user.workspaceId}`;
    const agentRef = adminDatabase.ref(`${workspaceRoot}/agents/${input.workerId}`);
    const snapshot = await agentRef.get();
    if (!snapshot.exists()) return { ok: false, message: "Worker no longer exists." };
    const agent = snapshot.val() as WorkerAccessRecord;
    if (!canManageWorker(agent, user)) return { ok: false, message: "Only the worker owner can change access." };
    const sharedEmails = input.sharing === "shared" ? parseSharedEmails(input.sharedEmails) : [];
    if (!sharedEmails) return { ok: false, message: "Enter valid email addresses separated by commas." };
    if (input.sharing === "shared" && sharedEmails.length === 0) {
      return { ok: false, message: "Enter at least one email address to share this worker." };
    }
    const now = Date.now();
    await agentRef.update({
      sharing: input.sharing,
      shared: input.sharing === "shared" || input.sharing === "public",
      public: input.sharing === "public",
      sharedEmails,
      sharingUpdatedAt: now,
      sharingUpdatedBy: user.uid,
    });
    revalidatePath("/dashboard");
    return { ok: true, message: "Worker access updated." };
  } catch (error) {
    console.error("saveWorkerSharing failed", error);
    return { ok: false, message: "Worker access could not be updated. Try again." };
  }
}

export async function saveCredentialSharing(formData: FormData) {
  const user = await requireSession("admin");
  const parsed = credentialSharingSchema.safeParse(formObject(formData));
  if (!parsed.success) return;
  const input = parsed.data;
  const credentialRef = adminDatabase.ref(`workspaces/${user.workspaceId}/credentials/${input.credentialId}`);
  const snapshot = await credentialRef.get();
  if (!snapshot.exists()) return;
  const credential = snapshot.val() as CredentialAccessRecord;
  if (!canManageCredential(credential, user)) return;
  const sharedEmails = input.sharing === "shared" ? parseSharedEmails(input.sharedEmails) : [];
  if (!sharedEmails) return;
  const now = Date.now();
  await credentialRef.update({
    sharing: input.sharing,
    shared: input.sharing === "shared" || input.sharing === "public",
    public: input.sharing === "public",
    sharedEmails,
    sharingUpdatedAt: now,
    sharingUpdatedBy: user.uid,
  });
  revalidatePath("/dashboard");
}

export async function claimWorker(formData: FormData) {
  const user = await requireSession("operator");
  const parsed = workerClaimSchema.safeParse(formObject(formData));
  if (!parsed.success) return { ok: false, message: "Enter a valid worker token." };
  const input = parsed.data;
  const workspaceRoot = `workspaces/${user.workspaceId}`;
  const tokenHash = createHash("sha256").update(input.workerToken, "utf8").digest("hex");
  try {
    const agentsSnapshot = await adminDatabase.ref(`${workspaceRoot}/agents`).get();
    const agents = (agentsSnapshot.val() ?? {}) as Record<string, Record<string, unknown>>;
    const match = Object.entries(agents).find(([, agent]) => {
      if (!agent || typeof agent !== "object") return false;
      return agent.workerTokenHash === tokenHash || agent.claimTokenHash === tokenHash;
    });
    if (!match) return { ok: false, message: "Worker token was not found in this workspace." };
    const [workerId, matchedWorker] = match;
    const workerLabel = String(matchedWorker.label || matchedWorker.hostname || workerId);
    const matchedOwner = String(matchedWorker.ownerUid || "").trim();
    if (matchedOwner && matchedOwner !== user.uid) {
      return { ok: false, message: "This worker has already been claimed by another user." };
    }
    const now = Date.now();
    const agentRef = adminDatabase.ref(`${workspaceRoot}/agents/${workerId}`);
    const transaction = await agentRef.transaction((current) => {
      // The Admin SDK invokes this once with a local null before loading the remote value.
      if (current === null) return current;
      if (typeof current !== "object") return;
      if (current.workerTokenHash !== tokenHash && current.claimTokenHash !== tokenHash) return;
      const currentOwner = String(current.ownerUid || "").trim();
      if (currentOwner && currentOwner !== user.uid) return;
      const isExistingOwner = currentOwner === user.uid;
      const sharing = isExistingOwner && ["private", "shared", "public"].includes(String(current.sharing))
        ? current.sharing
        : "private";
      return {
        ...current,
        claimedAt: isExistingOwner ? current.claimedAt || now : now,
        claimedBy: user.uid,
        ownerUid: user.uid,
        ownerEmail: normalizeWorkerEmail(user.email),
        sharing,
        shared: sharing === "shared" || sharing === "public",
        public: sharing === "public",
        sharedEmails: isExistingOwner && Array.isArray(current.sharedEmails) ? current.sharedEmails : [],
      };
    });
    if (!transaction.committed) {
      const currentSnapshot = await agentRef.get();
      const current = currentSnapshot.val() as WorkerAccessRecord | null;
      const currentOwner = String(current?.ownerUid || "").trim();
      if (currentOwner && currentOwner !== user.uid) {
        return { ok: false, message: "This worker has already been claimed by another user." };
      }
      return { ok: false, message: "This worker is no longer available. Restart it and use its current claim token." };
    }
    const claimedWorker = transaction.snapshot.val() as WorkerAccessRecord | null;
    if (!claimedWorker || String(claimedWorker.ownerUid || "").trim() !== user.uid) {
      return { ok: false, message: "This worker is no longer available. Restart it and use its current claim token." };
    }
    const wasAlreadyOwned = String(matchedWorker.ownerUid || "").trim() === user.uid;
    revalidatePath("/dashboard");
    return {
      ok: true,
      message: wasAlreadyOwned ? `${workerLabel} is already assigned to your account.` : `${workerLabel} was claimed successfully.`,
      workerId,
    };
  } catch (error) {
    console.error("claimWorker failed", error);
    return { ok: false, message: "The worker could not be claimed. Please try again." };
  }
}

export async function deleteRepository(formData: FormData) {
  const user = await requireSession("operator");
  const repositoryId = z.string().min(1).parse(formData.get("repositoryId"));
  const confirmation = z.string().trim().parse(formData.get("repositoryNameConfirmation") || "");
  const ref = adminDatabase.ref(`workspaces/${user.workspaceId}/repositories/${repositoryId}`);
  const snapshot = await ref.get();
  if (!snapshot.exists()) return;
  const repository = snapshot.val() as Record<string, unknown>;
  if (!canManageRepository(repository as RepositoryAccessRecord, user)) return;
  const expected = String(repository.alias || repositoryId);
  if (confirmation !== expected) return;
  await adminDatabase.ref().update({
    [`workspaces/${user.workspaceId}/repositories/${repositoryId}`]: null,
    [`secrets/ngrok/${user.workspaceId}/${repositoryId}`]: null,
  });
  revalidatePath("/dashboard");
}

export async function deleteCredential(formData: FormData) {
  const user = await requireSession("admin");
  const credentialId = z.string().min(1).parse(formData.get("credentialId"));
  const credentialRef = adminDatabase.ref(`workspaces/${user.workspaceId}/credentials/${credentialId}`);
  const credential = (await credentialRef.get()).val() as CredentialAccessRecord | null;
  if (!credential || !canManageCredential(credential, user)) return;
  await adminDatabase.ref().update({ [`workspaces/${user.workspaceId}/credentials/${credentialId}`]: null, [`secrets/credentials/${user.workspaceId}/${credentialId}`]: null });
  revalidatePath("/dashboard");
}

export async function cancelDeployment(formData: FormData) {
  const user = await requireSession("operator");
  const jobId = z.string().min(1).parse(formData.get("jobId"));
  const workspaceJob = await adminDatabase.ref(`workspaces/${user.workspaceId}/deployments/${jobId}`).get();
  if (!workspaceJob.exists()) throw new Error("Deployment not found");
  const deployment = workspaceJob.val() as Record<string, unknown>;
  const targetWorkerId = String(deployment.targetWorkerId || deployment.workerId || "");
  if (targetWorkerId) {
    const worker = (await adminDatabase.ref(`workspaces/${user.workspaceId}/agents/${targetWorkerId}`).get()).val();
    if (!worker || !canAccessWorker(worker as WorkerAccessRecord, user)) throw new Error("Worker not available");
  }
  await adminDatabase.ref(`jobs/${jobId}/cancellationRequested`).set(true);
}
