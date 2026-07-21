import { NextResponse } from "next/server";

import { adminDatabase } from "@/lib/firebase-admin";
import { getSessionUser } from "@/lib/session";
import type { CredentialSummary, Repository } from "@/lib/types";

export const dynamic = "force-dynamic";

function values<T>(value: Record<string, T> | null): T[] {
  return Object.values(value ?? {});
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const root = adminDatabase.ref(`workspaces/${user.workspaceId}`);
  const [repositories, credentials] = await Promise.all([
    root.child("repositories").get(),
    root.child("credentials").get(),
  ]);

  return NextResponse.json(
    {
      repositories: values<Repository>(repositories.val()),
      credentials: values<CredentialSummary>(credentials.val()),
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
