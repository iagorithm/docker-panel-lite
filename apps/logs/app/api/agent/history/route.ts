import { NextRequest, NextResponse } from "next/server";

import { adminSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await adminSession();
  if (!user) return NextResponse.json({ error: "Admin session required" }, { status: 401 });
  const endpoint = process.env.LOGS_AGENT_URL?.replace(/\/$/, "");
  const secret = process.env.LOGS_AGENT_SECRET;
  if (!endpoint || !secret) return NextResponse.json({ error: "Independent CrewAI service is not configured" }, { status: 503 });
  try {
    const body = await request.json();
    const response = await fetch(`${endpoint}/v1/history`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-secret": secret },
      body: JSON.stringify({ ...body, workspaceId: user.workspaceId, requestedBy: user.uid, requestedByEmail: user.email }),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (!response.ok) return NextResponse.json({ error: payload.detail || "Could not save agent result" }, { status: response.status });
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save agent result" }, { status: 502 });
  }
}
