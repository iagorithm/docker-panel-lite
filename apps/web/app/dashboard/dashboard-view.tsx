import { adminDatabase } from "@/lib/firebase-admin";
import { canAccessCredential, sanitizeCredentialForClient, type CredentialAccessRecord } from "@/lib/credential-access";
import { requireSession } from "@/lib/session";
import { canAccessRepository, sanitizeRepositoryForClient, type RepositoryAccessRecord } from "@/lib/repository-access";
import type { Agent, CommandPreset, CredentialSummary, Deployment, ManagedContainer, Repository } from "@/lib/types";
import { canAccessWorker, sanitizeWorkerForClient, type WorkerAccessRecord } from "@/lib/worker-access";
import { RealtimeDashboard } from "./realtime-dashboard";

export type DashboardView = "containers" | "repositories" | "logs" | "workers" | "settings";

function values<T>(value: Record<string, T> | null): T[] {
  return Object.values(value ?? {});
}

export async function DashboardViewPage({ initialView }: { initialView: DashboardView }) {
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
  const visibleCredentials = values<CredentialSummary>(credentials.val())
    .filter((credential) => canAccessCredential(credential as CredentialAccessRecord, user))
    .map((credential) => sanitizeCredentialForClient(credential as CredentialAccessRecord, user) as CredentialSummary);
  const visibleCredentialIds = new Set(visibleCredentials.map((credential) => credential.id));
  const visibleRepositories = values<Repository>(repositories.val())
    .filter((repository) => canAccessRepository(repository as RepositoryAccessRecord, user))
    .map((repository) => sanitizeRepositoryForClient(repository as RepositoryAccessRecord, user) as Repository)
    .map((repository) => repository.credentialId && !visibleCredentialIds.has(repository.credentialId) ? { ...repository, credentialId: "" } : repository);
  const visibleWorkerIds = new Set(visibleAgents.map((agent) => agent.id));
  const visibleContainers = values<ManagedContainer>(containers.val()).filter((container) => Boolean(container.workerId && visibleWorkerIds.has(container.workerId)));
  const visibleDeployments = values<Deployment>(deployments.val()).filter((deployment) => !deployment.targetWorkerId || visibleWorkerIds.has(deployment.targetWorkerId));

  return <RealtimeDashboard
    initialView={initialView}
    workspaceId={user.workspaceId}
    user={{ uid: user.uid, email: user.email ?? "", role: user.role }}
    initialRepositories={visibleRepositories}
    initialDeployments={visibleDeployments}
    initialAgents={visibleAgents.map((agent) => sanitizeWorkerForClient(agent as WorkerAccessRecord, user) as Agent)}
    initialCredentials={visibleCredentials}
    initialContainers={visibleContainers}
    initialCommandPresets={values<CommandPreset>(commandPresets.val())}
  />;
}
