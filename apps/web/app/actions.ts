"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { adminDatabase } from "@/lib/firebase-admin";
import { requireSession } from "@/lib/session";
import { encryptSecret } from "@/lib/secrets";

const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const branchPattern = /^(?![-./])(?!.*(?:\.\.|@\{|\/\/|\.lock(?:\/|$)))[^\s~^:?*[\\]+$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

const repositorySchema = z.object({
  repositoryId: z.string().optional(),
  alias: z.string().trim().regex(aliasPattern, "Invalid alias"),
  url: z.string().trim().refine((value) => /^(https:\/\/|git@|ssh:\/\/)/.test(value), "Invalid Git URL"),
  branch: z.string().trim().refine((value) => !value || branchPattern.test(value), "Invalid branch"),
  mode: z.enum(["compose", "dockerfile"]),
  composeFile: z.string().trim().default("docker-compose.yml"),
  dockerfile: z.string().trim().default("Dockerfile"),
  credentialId: z.string().trim().default(""),
  environmentJson: z.string().default("{}"),
  domain: z.string().trim().refine((value) => !value || hostnamePattern.test(value), "Invalid domain"),
  service: z.string().trim().default("web"),
  internalPort: z.coerce.number().int().min(1).max(65535).default(3000),
  ports: z.string().trim().default(""),
  poolId: z.string().trim().regex(aliasPattern).default("default"),
});

const credentialSchema = z.object({
  alias: z.string().trim().regex(aliasPattern, "Invalid credential alias"),
  username: z.string().trim().max(200).default(""),
  token: z.string().trim().min(1, "Token is required"),
});

function formObject(formData: FormData) {
  return Object.fromEntries(formData.entries());
}

function parseEnvironment(value: string): Record<string, string> {
  const parsed = JSON.parse(value || "{}");
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Environment JSON must be an object");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, item]) => {
      if (!key || typeof item === "object") throw new Error(`Environment value '${key}' must be scalar`);
      return [key, item == null ? "" : String(item)];
    }),
  );
}

function shardFor(value: string) {
  const shards = Math.max(1, Number(process.env.QUEUE_SHARDS ?? "16"));
  const hash = createHash("sha256").update(value).digest().readUInt32BE(0);
  return String(hash % shards).padStart(2, "0");
}

export async function saveRepository(formData: FormData) {
  const user = await requireSession("operator");
  const input = repositorySchema.parse(formObject(formData));
  const repositoryId = input.repositoryId || input.alias;
  const now = Date.now();
  const currentRef = adminDatabase.ref(`workspaces/${user.workspaceId}/repositories/${repositoryId}`);
  const current = (await currentRef.get()).val();
  await currentRef.set({
    id: repositoryId,
    alias: input.alias,
    url: input.url,
    branch: input.branch,
    mode: input.mode,
    composeFile: input.composeFile || "docker-compose.yml",
    dockerfile: input.dockerfile || "Dockerfile",
    credentialId: input.credentialId,
    environment: parseEnvironment(input.environmentJson),
    domain: input.domain,
    service: input.service || "web",
    internalPort: input.internalPort,
    ports: input.ports,
    poolId: input.poolId,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    updatedBy: user.uid,
  });
  revalidatePath("/dashboard");
}

export async function saveCredential(formData: FormData) {
  const user = await requireSession("admin");
  const input = credentialSchema.parse(formObject(formData));
  const encrypted = encryptSecret(input.token);
  const now = Date.now();
  const updates: Record<string, unknown> = {
    [`secrets/credentials/${user.workspaceId}/${input.alias}`]: {
      ...encrypted,
      username: input.username,
      updatedAt: now,
    },
    [`workspaces/${user.workspaceId}/credentials/${input.alias}`]: {
      id: input.alias,
      alias: input.alias,
      username: input.username,
      tokenMask: input.token.length > 8 ? `${input.token.slice(0, 4)}••••••••${input.token.slice(-4)}` : "••••••••",
      updatedAt: now,
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
  for (const [alias, value] of Object.entries(parsed)) {
    if (!aliasPattern.test(alias) || !value || Array.isArray(value) || typeof value !== "object") throw new Error(`Invalid credential '${alias}'`);
    const item = value as Record<string, unknown>;
    const token = z.string().min(1).parse(item.token);
    const username = z.string().max(200).default("").parse(item.username);
    updates[`secrets/credentials/${user.workspaceId}/${alias}`] = { ...encryptSecret(token), username, updatedAt: now };
    updates[`workspaces/${user.workspaceId}/credentials/${alias}`] = { id: alias, alias, username, tokenMask: token.length > 8 ? `${token.slice(0, 4)}••••••••${token.slice(-4)}` : "••••••••", updatedAt: now };
  }
  await adminDatabase.ref().update(updates);
}

export async function enqueueDeployment(formData: FormData) {
  const user = await requireSession("operator");
  const repositoryId = z.string().min(1).parse(formData.get("repositoryId"));
  const action = z.enum(["sync", "deploy", "stop", "build", "discover_branches", "read_compose"]).parse(formData.get("action"));
  const repository = (
    await adminDatabase.ref(`workspaces/${user.workspaceId}/repositories/${repositoryId}`).get()
  ).val();
  if (!repository) throw new Error("Repository not found");

  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const createdAt = Date.now();
  const shardId = shardFor(repositoryId);
  const poolId = repository.poolId || "default";
  const job = {
    id: jobId,
    workspaceId: user.workspaceId,
    repositoryId,
    action,
    poolId,
    shardId,
    status: "queued",
    progress: 0,
    attempt: 0,
    idempotencyKey: `${user.workspaceId}:${repositoryId}:${action}:${createdAt}`,
    requestedBy: user.uid,
    createdAt,
  };
  await adminDatabase.ref().update({
    [`jobs/${jobId}`]: job,
    [`queues/${poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100 },
    [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job,
  });
}

export async function enqueueAllRepositories() {
  const user = await requireSession("operator");
  const repositories = (await adminDatabase.ref(`workspaces/${user.workspaceId}/repositories`).get()).val() ?? {};
  const updates: Record<string, unknown> = {};
  const createdAt = Date.now();
  for (const [repositoryId, repository] of Object.entries(repositories) as [string, Record<string, string>][]) {
    const jobRef = adminDatabase.ref("jobs").push();
    const jobId = jobRef.key!;
    const shardId = shardFor(repositoryId);
    const poolId = repository.poolId || "default";
    const job = { id: jobId, workspaceId: user.workspaceId, repositoryId, action: "sync", poolId, shardId, status: "queued", progress: 0, attempt: 0, requestedBy: user.uid, createdAt };
    updates[`jobs/${jobId}`] = job;
    updates[`queues/${poolId}/${shardId}/${jobId}`] = { createdAt, priority: 100 };
    updates[`workspaces/${user.workspaceId}/deployments/${jobId}`] = job;
  }
  await adminDatabase.ref().update(updates);
}

export async function enqueueContainerAction(formData: FormData) {
  const user = await requireSession("operator");
  const containerId = z.string().min(1).parse(formData.get("containerId"));
  const action = z.enum(["container_start", "container_stop", "container_restart", "container_delete", "container_logs"]).parse(formData.get("action"));
  const existing = await adminDatabase.ref(`workspaces/${user.workspaceId}/containers/${containerId}`).get();
  if (!existing.exists()) throw new Error("Container not found");
  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const createdAt = Date.now();
  const shardId = shardFor(containerId);
  const poolId = "default";
  const job = { id: jobId, workspaceId: user.workspaceId, containerId, repositoryId: "", action, poolId, shardId, status: "queued", progress: 0, attempt: 0, requestedBy: user.uid, createdAt };
  await adminDatabase.ref().update({ [`jobs/${jobId}`]: job, [`queues/${poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100 }, [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job });
}

export async function enqueueInventoryRefresh() {
  const user = await requireSession("operator");
  const jobRef = adminDatabase.ref("jobs").push();
  const jobId = jobRef.key!;
  const createdAt = Date.now();
  const poolId = "default";
  const shardId = shardFor(`inventory:${user.workspaceId}`);
  const job = {
    id: jobId,
    workspaceId: user.workspaceId,
    containerId: "",
    repositoryId: "",
    action: "inventory_refresh",
    poolId,
    shardId,
    status: "queued",
    progress: 0,
    attempt: 0,
    requestedBy: user.uid,
    createdAt,
  };
  await adminDatabase.ref().update({
    [`jobs/${jobId}`]: job,
    [`queues/${poolId}/${shardId}/${jobId}`]: { createdAt, priority: 100 },
    [`workspaces/${user.workspaceId}/deployments/${jobId}`]: job,
  });
}

export async function deleteRepository(formData: FormData) {
  const user = await requireSession("operator");
  const repositoryId = z.string().min(1).parse(formData.get("repositoryId"));
  await adminDatabase.ref(`workspaces/${user.workspaceId}/repositories/${repositoryId}`).remove();
}

export async function deleteCredential(formData: FormData) {
  const user = await requireSession("admin");
  const credentialId = z.string().min(1).parse(formData.get("credentialId"));
  await adminDatabase.ref().update({ [`workspaces/${user.workspaceId}/credentials/${credentialId}`]: null, [`secrets/credentials/${user.workspaceId}/${credentialId}`]: null });
}

export async function cancelDeployment(formData: FormData) {
  const user = await requireSession("operator");
  const jobId = z.string().min(1).parse(formData.get("jobId"));
  const workspaceJob = await adminDatabase.ref(`workspaces/${user.workspaceId}/deployments/${jobId}`).get();
  if (!workspaceJob.exists()) throw new Error("Deployment not found");
  await adminDatabase.ref(`jobs/${jobId}/cancellationRequested`).set(true);
}
