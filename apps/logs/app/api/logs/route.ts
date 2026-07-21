import { NextRequest, NextResponse } from "next/server";
import { recentLogs } from "@/lib/logs";
import { adminSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const user = await adminSession();
  if (!user) return NextResponse.json({ error: "Admin session required. Sign in to the main panel first." }, { status: 401 });
  const params = request.nextUrl.searchParams;
  const from = Number(params.get("from") || 0), to = Number(params.get("to") || Number.MAX_SAFE_INTEGER);
  const worker = params.get("worker") || "", container = params.get("container") || "", actor = params.get("actor") || "all";
  const logs = (await recentLogs(user.workspaceId, Number(params.get("limit") || 1000))).filter((log) => log.createdAt >= from && log.createdAt <= to && (!worker || (log.actorType === "worker" && log.actorId === worker)) && (!container || log.context?.containerId === container) && (actor === "all" || log.actorType === actor));
  return NextResponse.json({ logs }, { headers: { "Cache-Control": "private, no-store" } });
}
