import { NextRequest, NextResponse } from "next/server";

import { adminSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    const workflow = body.workflow === "analyze" ? "analyze" : body.workflow === "fix" ? "fix" : body.workflow === "legacy" ? "diagnose" : "analyze-and-fix";
    const { workflow: _workflow, ...requestPayload } = body;
    const response = await fetch(`${endpoint}/v1/${workflow}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-secret": secret },
      body: JSON.stringify({ ...requestPayload, workspaceId: user.workspaceId, requestedBy: user.uid, requestedByEmail: user.email }),
      signal: AbortSignal.timeout(295_000),
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text || "CrewAI service returned an empty response" }; }
    if (!response.ok) return NextResponse.json({ error: apiError(payload, "CrewAI diagnostics failed") }, { status: response.status });
    return NextResponse.json(payload, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "CrewAI service request failed" }, { status: 502 });
  }
}
