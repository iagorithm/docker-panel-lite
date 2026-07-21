import { NextResponse } from "next/server";

import { adminDatabase } from "@/lib/firebase-admin";
import { canAccessCredential, sanitizeCredentialForClient, type CredentialAccessRecord } from "@/lib/credential-access";
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
  const visibleCredentials = values<CredentialSummary>(credentials.val())
    .filter((credential) => canAccessCredential(credential as CredentialAccessRecord, user))
    .map((credential) => sanitizeCredentialForClient(credential as CredentialAccessRecord, user) as CredentialSummary);
  const visibleCredentialIds = new Set(visibleCredentials.map((credential) => credential.id));
  const visibleRepositories = values<Repository>(repositories.val()).map((repository) => (
    repository.credentialId && !visibleCredentialIds.has(repository.credentialId)
      ? { ...repository, credentialId: "" }
      : repository
  ));

  return NextResponse.json(
    {
      repositories: visibleRepositories,
      credentials: visibleCredentials,
    },
    { headers: { "Cache-Control": "private, no-store, max-age=0" } },
  );
}
