import { adminDatabase } from "@/lib/firebase-admin";

export type AppLog = {
  id: string;
  actorType: "worker" | "ui";
  actorId: string;
  actorEmail?: string;
  actorLabel?: string;
  userId?: string;
  userEmail?: string;
  runtime?: "worker-python" | "worker-go" | "web";
  functionName?: string;
  action: string;
  source: string;
  severity: "error";
  message: string;
  context?: Record<string, string>;
  analyzed?: boolean;
  analysisCount?: number;
  lastAnalyzedAt?: number;
  lastAnalyzedBy?: string;
  createdAt: number;
};

export async function recentLogs(workspaceId: string, limit = 1000) {
  const snapshot = await adminDatabase.ref(`workspaces/${workspaceId}/app_logs`).get();
  const logs = Object.entries((snapshot.val() || {}) as Record<string, Partial<AppLog>>)
    .map(([id, value]) => ({
      ...value,
      id: String(value.id || id),
      actorType: value.actorType === "worker" ? "worker" as const : "ui" as const,
      actorId: String(value.actorId || ""),
      runtime: value.runtime || (value.actorType === "worker" ? "worker-python" : "web"),
      functionName: String(value.functionName || value.source || "unknown"),
      action: String(value.action || "unknown"),
      source: String(value.source || "unknown"),
      severity: "error" as const,
      message: String(value.message || "Unknown error"),
      context: value.context || {},
      createdAt: Number(value.createdAt || 0),
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.min(1000, Math.max(1, limit)));

  await Promise.all(logs.map(async (log) => {
    if (log.userId || log.actorType !== "worker" || !log.context.jobId) return;
    const job = (await adminDatabase.ref(`jobs/${log.context.jobId}`).get()).val();
    if (!job) return;
    log.userId = String(job.requestedBy || "");
    log.userEmail = String(job.requestedByEmail || "");
  }));

  return logs;
}
