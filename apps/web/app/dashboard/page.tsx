import { adminDatabase } from "@/lib/firebase-admin";
import { requireSession } from "@/lib/session";
import type { Agent, CommandPreset, CredentialSummary, Deployment, ManagedContainer, Repository } from "@/lib/types";
import { RealtimeDashboard } from "./realtime-dashboard";

function values<T>(value: Record<string, T> | null): T[] {
  return Object.values(value ?? {});
}

export default async function DashboardPage() {
  const user = await requireSession();
  const root = adminDatabase.ref(`workspaces/${user.workspaceId}`);
  const [repositories, deployments, agents, credentials, containers, commandPresets] = await Promise.all([
    root.child("repositories").get(),
    root.child("deployments").get(),
    root.child("agents").get(),
    root.child("credentials").get(),
    root.child("containers").get(),
    root.child("commandPresets").get(),
  ]);

  return (
    <RealtimeDashboard
      workspaceId={user.workspaceId}
      user={{ email: user.email ?? "", role: user.role }}
      initialRepositories={values<Repository>(repositories.val())}
      initialDeployments={values<Deployment>(deployments.val())}
      initialAgents={values<Agent>(agents.val())}
      initialCredentials={values<CredentialSummary>(credentials.val())}
      initialContainers={values<ManagedContainer>(containers.val())}
      initialCommandPresets={values<CommandPreset>(commandPresets.val())}
    />
  );
}
