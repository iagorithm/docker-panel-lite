import { NextResponse } from "next/server";

import { adminDatabase } from "@/lib/firebase-admin";
import { getSessionUser } from "@/lib/session";
import { canAccessWorker, sanitizeWorkerForClient, type WorkerAccessRecord } from "@/lib/worker-access";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const snapshot = await adminDatabase.ref(`workspaces/${user.workspaceId}/agents`).get();
  const agents = (snapshot.val() ?? {}) as Record<string, WorkerAccessRecord>;
  const workers = Object.values(agents)
    .filter((agent) => agent && typeof agent === "object" && canAccessWorker(agent, user))
    .map((agent) => sanitizeWorkerForClient(agent, user));

  return NextResponse.json(
    { workers },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
