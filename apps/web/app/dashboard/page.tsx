import { adminDatabase } from "@/lib/firebase-admin";
import { requireSession } from "@/lib/session";
import type { Agent, CommandPreset, CredentialSummary, Deployment, ManagedContainer, Repository } from "@/lib/types";
import { canAccessWorker, sanitizeWorkerForClient, type WorkerAccessRecord } from "@/lib/worker-access";
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
  const visibleAgents = values<Agent>(agents.val()).filter((agent) => canAccessWorker(agent as WorkerAccessRecord, user));
  const visibleWorkerIds = new Set(visibleAgents.map((agent) => agent.id));
  const visibleContainers = values<ManagedContainer>(containers.val()).filter((container) => Boolean(container.workerId && visibleWorkerIds.has(container.workerId)));
  const visibleDeployments = values<Deployment>(deployments.val()).filter((deployment) => !deployment.targetWorkerId || visibleWorkerIds.has(deployment.targetWorkerId));

  return (
    <RealtimeDashboard
      workspaceId={user.workspaceId}
      user={{ uid: user.uid, email: user.email ?? "", role: user.role }}
      initialRepositories={values<Repository>(repositories.val())}
      initialDeployments={visibleDeployments}
      initialAgents={visibleAgents.map((agent) => sanitizeWorkerForClient(agent as WorkerAccessRecord, user) as Agent)}
      initialCredentials={values<CredentialSummary>(credentials.val())}
      initialContainers={visibleContainers}
      initialCommandPresets={values<CommandPreset>(commandPresets.val())}
    />
  );
}
