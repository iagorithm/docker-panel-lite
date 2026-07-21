import { cookies } from "next/headers";
import { adminAuth } from "@/lib/firebase-admin";

export async function adminSession() {
  const value = (await cookies()).get("docker_panel_session")?.value;
  if (!value) return null;
  try {
    const claims = await adminAuth.verifySessionCookie(value, true);
    const role = String(claims.role || process.env.DEFAULT_USER_ROLE || "admin");
    if (role !== "admin") return null;
    return { uid: claims.uid, email: claims.email || "", workspaceId: String(claims.workspaceId || process.env.DEFAULT_WORKSPACE_ID || "default") };
  } catch { return null; }
}
