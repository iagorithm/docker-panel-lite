import { NextRequest, NextResponse } from "next/server";

import { adminSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function apiError(payload: Record<string, unknown>, fallback: string) {
  const detail = payload.detail ?? payload.error;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => {
    if (!item || typeof item !== "object") return String(item);
    const issue = item as { loc?: unknown[]; msg?: string };
    return `${issue.loc?.join(".") || "request"}: ${issue.msg || JSON.stringify(item)}`;
  }).join("; ");
  if (detail) return JSON.stringify(detail);
  return fallback;
}

export async function POST(request: NextRequest) {
  const user = await adminSession();
  if (!user) return NextResponse.json({ error: "Admin session required" }, { status: 401 });
  const endpoint = process.env.LOGS_AGENT_URL?.replace(/\/$/, "");
  const secret = process.env.LOGS_AGENT_SECRET;
  if (!endpoint || !secret) return NextResponse.json({ error: "Independent CrewAI service is not configured" }, { status: 503 });
  try {
    const body = await request.json();
    const response = await fetch(`${endpoint}/v1/commit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-secret": secret },
      body: JSON.stringify({ ...body, workspaceId: user.workspaceId, requestedBy: user.uid, requestedByEmail: user.email }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text || "Agent returned an empty response" }; }
    if (!response.ok) return NextResponse.json({ error: apiError(payload, "Could not commit previewed fix") }, { status: response.status });
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not commit previewed fix" }, { status: 502 });
  }
}
