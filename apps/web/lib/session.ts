import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { adminAuth } from "@/lib/firebase-admin";

export const SESSION_COOKIE = "docker_panel_session";

export type SessionUser = {
  uid: string;
  email: string;
  role: string;
  workspaceId: string;
};

function defaultRole() {
  const role = process.env.DEFAULT_USER_ROLE || "admin";
  return ["viewer", "operator", "admin"].includes(role) ? role : "admin";
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return null;
  try {
    const claims = await adminAuth.verifySessionCookie(session, true);
    return {
      uid: claims.uid,
      email: claims.email ?? "",
      role: String(claims.role ?? defaultRole()),
      workspaceId: String(claims.workspaceId ?? process.env.DEFAULT_WORKSPACE_ID ?? "default"),
    };
  } catch {
    return null;
  }
}

export async function requireSession(requiredRole?: "operator" | "admin") {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (requiredRole) {
    const rank = { viewer: 0, operator: 1, admin: 2 } as const;
    if ((rank[user.role as keyof typeof rank] ?? 0) < rank[requiredRole]) {
      throw new Error("Forbidden");
    }
  }
  return user;
}
