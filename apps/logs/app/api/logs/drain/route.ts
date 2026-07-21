import { NextRequest, NextResponse } from "next/server";
import { adminDatabase } from "@/lib/firebase-admin";
import { recentLogs } from "@/lib/logs";
import { adminSession } from "@/lib/session";

export async function POST(request: NextRequest) {
  const user = await adminSession();
  if (!user) return NextResponse.json({ error: "Admin session required" }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const from = Number(params.get("from") || 0), to = Number(params.get("to") || Number.MAX_SAFE_INTEGER);
  const worker = params.get("worker") || "", container = params.get("container") || "", actor = params.get("actor") || "all";
  const limit = Math.min(1000, Math.max(1, Number(params.get("limit") || 1000)));
  const logs = (await recentLogs(user.workspaceId, limit)).filter((log) => log.createdAt >= from && log.createdAt <= to && (!worker || (log.actorType === "worker" && log.actorId === worker)) && (!container || log.context?.containerId === container) && (actor === "all" || log.actorType === actor));
  if (logs.length) await adminDatabase.ref(`workspaces/${user.workspaceId}/app_logs`).update(Object.fromEntries(logs.map((log) => [log.id, null])));
  const header = { format: "docker-panel-lite-app-errors/v1", workspaceId: user.workspaceId, drainedBy: user.uid, drainedAt: Date.now(), count: logs.length };
  const body = [JSON.stringify(header), ...logs.map((log) => JSON.stringify(log))].join("\n") + "\n";
  return new NextResponse(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": 'attachment; filename="app-logs.logs"', "Cache-Control": "private, no-store", "X-App-Logs-Drained": String(logs.length) } });
}
