import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { adminDatabase } from "@/lib/firebase-admin";
import { requireSession } from "@/lib/session";
import { decryptSecret } from "@/lib/secrets";

const requestSchema = z.object({
  url: z.string().trim().min(1),
  credentialId: z.string().trim().default(""),
});

function parseGitHubRepository(rawUrl: string) {
  const https = rawUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (https) return { owner: https[1], repo: https[2] };

  const ssh = rawUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };

  const sshUrl = rawUrl.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshUrl) return { owner: sshUrl[1], repo: sshUrl[2] };

  return null;
}

async function credentialToken(workspaceId: string, credentialId: string) {
  if (!credentialId) return "";
  const snapshot = await adminDatabase.ref(`secrets/credentials/${workspaceId}/${credentialId}`).get();
  const encrypted = snapshot.val();
  if (!encrypted) throw new Error("Credential not found");
  return decryptSecret(encrypted);
}

export async function POST(request: NextRequest) {
  const user = await requireSession("operator");
  const input = requestSchema.parse(await request.json());
  const repository = parseGitHubRepository(input.url);
  if (!repository) {
    return NextResponse.json({ error: "Branch discovery currently supports GitHub repositories." }, { status: 400 });
  }

  const token = await credentialToken(user.workspaceId, input.credentialId);
  const headers: HeadersInit = {
    accept: "application/vnd.github+json",
    "user-agent": "docker-panel-lite",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const repoResponse = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}`, {
    headers,
    cache: "no-store",
  });
  if (!repoResponse.ok) {
    return NextResponse.json({ error: "Could not read repository metadata." }, { status: repoResponse.status });
  }
  const repoPayload = await repoResponse.json() as { default_branch?: string };

  const branches: string[] = [];
  let nextUrl: string | null = `https://api.github.com/repos/${repository.owner}/${repository.repo}/branches?per_page=100`;
  while (nextUrl && branches.length < 500) {
    const response: Response = await fetch(nextUrl, { headers, cache: "no-store" });
    if (!response.ok) return NextResponse.json({ error: "Could not read repository branches." }, { status: response.status });
    const payload = await response.json() as Array<{ name?: string }>;
    branches.push(...payload.map((branch) => branch.name).filter((name): name is string => Boolean(name)));
    nextUrl = response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }

  const unique = [...new Set(branches)].sort((a, b) => a.localeCompare(b));
  const defaultBranch = repoPayload.default_branch || unique[0] || "";
  if (defaultBranch && unique.includes(defaultBranch)) {
    unique.splice(unique.indexOf(defaultBranch), 1);
    unique.unshift(defaultBranch);
  }

  return NextResponse.json({ branches: unique, defaultBranch });
}
