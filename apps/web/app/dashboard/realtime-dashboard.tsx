"use client";

import { signOut } from "firebase/auth";
import { onValue, ref } from "firebase/database";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  cancelDeployment,
  deleteCommandPreset,
  deleteCredential,
  deleteRepository,
  deleteWorker,
  enqueueAllContainerLogs,
  enqueueAllRepositories,
  enqueueContainerCommand,
  enqueueContainerAction,
  enqueueDeployment,
  enqueueInventoryRefresh,
  importRepositoriesJson,
  saveCommandPreset,
  saveCredential,
  saveCredentialsJson,
  saveRepository,
} from "@/app/actions";
import { firebaseAuth, realtimeDatabase } from "@/lib/firebase-client";
import type { Agent, CommandPreset, CredentialSummary, Deployment, ManagedContainer, Repository } from "@/lib/types";

type Props = {
  workspaceId: string;
  user: { email: string; role: string };
  initialRepositories: Repository[];
  initialDeployments: Deployment[];
  initialAgents: Agent[];
  initialCredentials: CredentialSummary[];
  initialContainers: ManagedContainer[];
  initialCommandPresets: CommandPreset[];
};

type View = "containers" | "repositories";
type RepositoryAction = "sync" | "deploy" | "stop" | "build" | "discover_branches" | "read_compose" | "worker_command";
type ContainerAction = "container_start" | "container_stop" | "container_restart" | "container_delete" | "container_logs";
const defaultComposeFile = "compose.yml";
const defaultContainerCommand = 'docker compose -f docker-compose-local-setup.yaml exec -it api bash "/vagrant/scripts/nuke_database.sh"';
const workerOnlineFreshness = 45_000;
const orphanWorkerDeleteAge = 2 * 60 * 1000;
const activeJobMaxAge = 15 * 60 * 1000;
const pendingButtonMaxAge = 15 * 1000;

function useCollection<T>(path: string, initial: T[]) {
  const [items, setItems] = useState(initial);
  useEffect(
    () =>
      onValue(ref(realtimeDatabase, path), (snapshot) => {
        setItems(Object.values(snapshot.val() ?? {}) as T[]);
      }),
    [path],
  );
  return items;
}

function elapsed(timestamp?: number) {
  if (!timestamp) return "Never";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function ResourceGlyph({ kind = "container" }: { kind?: "container" | "repo" }) {
  return <span className={`resource-glyph ${kind === "repo" ? "repo-glyph" : ""}`} aria-hidden="true"><span /></span>;
}

function GithubMark() {
  return (
    <span className="github-mark" aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.65 7.65 0 0 1 8 4.84a7.65 7.65 0 0 1 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    </span>
  );
}

function Icon({ name }: { name: "add" | "key" | "sync" | "sliders" | "document" | "play" | "stop" | "logs" | "terminal" | "trash" | "logout" | "container" | "repo" | "close" | "branch" | "download" | "help" | "layers" | "chevron" | "worker" | "expand" | "collapse" }) {
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 2.05 };
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === "add" ? <path {...common} d="M12 4.75v14.5M4.75 12h14.5" /> : null}
      {name === "key" ? <path {...common} d="M7.75 14.25a4.25 4.25 0 1 1 3.7-6.34 4.25 4.25 0 0 1-3.7 6.34Zm4.05-4.25h8.2m-2.7 0v2.2m-2.55-2.2v1.55M6.55 10h.01" /> : null}
      {name === "sync" ? <path {...common} d="M17.6 6.2A7.25 7.25 0 0 0 5.35 9.05M17.6 6.2V3.45m0 2.75h-2.75M6.4 17.8a7.25 7.25 0 0 0 12.25-2.85M6.4 17.8v2.75m0-2.75h2.75" /> : null}
      {name === "sliders" ? <path {...common} d="M4.25 7.1h6.9m4.45 0h4.15M13.3 7.1a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 0 0-4.5 0ZM4.25 16.9h4.15m4.45 0h6.9M8.4 16.9a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 0 0-4.5 0Z" /> : null}
      {name === "document" ? <path {...common} d="M7 3.75h6.2l3.8 3.8V20a1.25 1.25 0 0 1-1.25 1.25H7A1.25 1.25 0 0 1 5.75 20V5A1.25 1.25 0 0 1 7 3.75Zm6 0v4h4M8.9 12.15h6.2M8.9 16.1h6.2" /> : null}
      {name === "play" ? <path d="M8.75 6.45v11.1a1 1 0 0 0 1.55.84l8.15-5.55a1 1 0 0 0 0-1.68L10.3 5.61a1 1 0 0 0-1.55.84Z" fill="currentColor" /> : null}
      {name === "stop" ? <rect x="7.75" y="7.75" width="8.5" height="8.5" rx="1.45" fill="currentColor" /> : null}
      {name === "logs" ? <path {...common} d="M6.5 4.75h11A1.25 1.25 0 0 1 18.75 6v12A1.25 1.25 0 0 1 17.5 19.25h-11A1.25 1.25 0 0 1 5.25 18V6A1.25 1.25 0 0 1 6.5 4.75ZM8.5 8.15h7M8.5 11.05h7M8.5 13.95h5.6M8.5 16.85h3.8" /> : null}
      {name === "terminal" ? <path {...common} d="M4.5 6.25h15v11.5h-15zM8.2 10l2.15 2-2.15 2M12.35 14h4.2" /> : null}
      {name === "trash" ? <path {...common} d="M4.75 7h14.5M9.75 11v5.75M14.25 11v5.75M8 7l1.1-3h5.8L16 7M6.75 7l.9 13.25h8.7L17.25 7" /> : null}
      {name === "logout" ? <path {...common} d="M10.25 5.75h-4.5v12.5h4.5M14.25 8.25 18 12l-3.75 3.75M8.25 12H18" /> : null}
      {name === "container" ? <path {...common} d="M5.25 4h13.5A1.25 1.25 0 0 1 20 5.25v13.5A1.25 1.25 0 0 1 18.75 20H5.25A1.25 1.25 0 0 1 4 18.75V5.25A1.25 1.25 0 0 1 5.25 4ZM6.75 8h10.5M6.75 12h10.5M6.75 16h10.5" /> : null}
      {name === "repo" ? <path {...common} d="M6.25 4.75h11.5v14.5H6.25zM9.1 8.5h5.8M9.1 12h5.8M9.1 15.5h3.2" /> : null}
      {name === "close" ? <path {...common} d="M6.75 6.75l10.5 10.5M17.25 6.75 6.75 17.25" /> : null}
      {name === "branch" ? <path {...common} d="M7 6.9a2.15 2.15 0 1 0 0-4.3 2.15 2.15 0 0 0 0 4.3Zm0 0v5.25a3.35 3.35 0 0 0 3.35 3.35h3.3M17 17.4a2.15 2.15 0 1 0 0-4.3 2.15 2.15 0 0 0 0 4.3Zm0-10.5a2.15 2.15 0 1 0 0-4.3 2.15 2.15 0 0 0 0 4.3Zm0 0v1.85a3.35 3.35 0 0 1-3.35 3.35h-2" /> : null}
      {name === "download" ? <path {...common} d="M12 4.25v10.1M8.35 10.7 12 14.35l3.65-3.65M5.25 19.75h13.5" /> : null}
      {name === "help" ? <path {...common} d="M9.45 9a2.65 2.65 0 1 1 4.2 2.15c-.95.66-1.65 1.15-1.65 2.45M12 17.4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /> : null}
      {name === "layers" ? <path {...common} d="m12 3.75 8 4.35-8 4.35-8-4.35 8-4.35Zm-5.9 8.4L12 15.25l5.9-3.1M6.1 16.05 12 19.25l5.9-3.2" /> : null}
      {name === "chevron" ? <path {...common} d="m9 6 6 6-6 6" /> : null}
      {name === "worker" ? <path {...common} d="M6.5 4.75h11A1.25 1.25 0 0 1 18.75 6v7A1.25 1.25 0 0 1 17.5 14.25h-11A1.25 1.25 0 0 1 5.25 13V6A1.25 1.25 0 0 1 6.5 4.75ZM8 18.75h8M12 14.25v4.5M8.25 8.25h.01M11 8.25h4.75M8.25 11h.01M11 11h4.75" /> : null}
      {name === "expand" ? <path {...common} d="M8.25 4.75h-3.5v3.5M4.75 4.75l5 5M15.75 4.75h3.5v3.5M19.25 4.75l-5 5M8.25 19.25h-3.5v-3.5M4.75 19.25l5-5M15.75 19.25h3.5v-3.5M19.25 19.25l-5-5" /> : null}
      {name === "collapse" ? <path {...common} d="M9.75 4.75v5h-5M9.75 9.75l-5-5M14.25 4.75v5h5M14.25 9.75l5-5M9.75 19.25v-5h-5M9.75 14.25l-5 5M14.25 19.25v-5h5M14.25 14.25l5 5" /> : null}
    </svg>
  );
}

function StatusBadge({ label, running }: { label: string; running: boolean }) {
  const display = label ? `${label.charAt(0).toUpperCase()}${label.slice(1)}` : "Unknown";
  return <span className={`ui-status-badge ${running ? "is-running" : "is-stopped"}`}><span className="ui-status-badge__dot" aria-hidden="true" />{display}</span>;
}

function Spinner() {
  return <span className="button-spinner" aria-hidden="true" />;
}

function IconButton({ title, children, onClick, primary = false, disabled = false }: { title: string; children: React.ReactNode; onClick?: () => void; primary?: boolean; disabled?: boolean }) {
  return <button className={`icon-button ${primary ? "primary-icon" : ""}`} title={title} aria-label={title} data-tooltip={title} onClick={onClick} disabled={disabled}>{children}</button>;
}

function useVisiblePending(pending: boolean) {
  const [pendingStartedAt, setPendingStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!pending) {
      setPendingStartedAt(null);
      return;
    }
    setPendingStartedAt((current) => current ?? Date.now());
    const timer = setTimeout(() => setTick((current) => current + 1), pendingButtonMaxAge + 50);
    return () => clearTimeout(timer);
  }, [pending, tick]);
  return pending && (!pendingStartedAt || Date.now() - pendingStartedAt < pendingButtonMaxAge);
}

function PendingIconButton({ title, children, onClick, primary = false, busy = false, disabled = false }: { title: string; children: React.ReactNode; onClick?: () => void; primary?: boolean; busy?: boolean; disabled?: boolean }) {
  const { pending } = useFormStatus();
  const isBusy = useVisiblePending(pending) || busy;
  return <IconButton title={isBusy ? `${title}...` : title} primary={primary} onClick={onClick} disabled={disabled || isBusy}>{isBusy ? <Spinner /> : children}</IconButton>;
}

function PendingSubmitButton({ children, className = "primary", formAction, tooltip }: { children: React.ReactNode; className?: string; formAction?: (formData: FormData) => void | Promise<void>; tooltip?: string }) {
  const { pending } = useFormStatus();
  const visiblePending = useVisiblePending(pending);
  return <button className={className} type="submit" title={tooltip} data-tooltip={tooltip} formAction={formAction} disabled={visiblePending}>{visiblePending ? <Spinner /> : children}</button>;
}

function QueueButton({ repositoryId, action, children, title, primary = false, busy = false, disabled = false, targetWorkerId = "" }: {
  repositoryId: string;
  action: RepositoryAction;
  children: React.ReactNode;
  title: string;
  primary?: boolean;
  busy?: boolean;
  disabled?: boolean;
  targetWorkerId?: string;
}) {
  return (
    <form action={enqueueDeployment}>
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <input type="hidden" name="action" value={action} />
      <input type="hidden" name="targetWorkerId" value={targetWorkerId || ""} />
      <PendingIconButton title={disabled ? "Select a worker first" : title} primary={primary} busy={busy} disabled={disabled}>{children}</PendingIconButton>
    </form>
  );
}

function activeRepositoryJobKey(job: Deployment) {
  return `${job.repositoryId}:${job.action}:${job.targetWorkerId || ""}`;
}

function EmptyState({ title, copy }: { title: string; copy: string }) {
  return <div className="empty-state"><span className="empty-state-icon" aria-hidden="true" /><h3>{title}</h3><p>{copy}</p></div>;
}

function matchesQuery(values: Array<string | undefined>, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return values.some((value) => (value || "").toLowerCase().includes(normalized));
}

function containerPrimaryAction(status: string): ContainerAction {
  return status === "running" ? "container_stop" : "container_start";
}

function isWorkerControlContainer(container: ManagedContainer) {
  const name = container.name.toLowerCase();
  const composeService = (container.composeService || "").toLowerCase();
  return Boolean(container.isWorkerContainer || composeService === "worker" || /(^|[-_])worker([-_]1)?$/.test(name));
}

function isProtectedContainerAction(container: ManagedContainer, action: string) {
  return Boolean(container.protectedActions?.includes(action) || (isWorkerControlContainer(container) && ["container_stop", "container_delete", "container_exec"].includes(action)));
}

function containerActionMeta(action: ContainerAction) {
  if (action === "container_start") return { title: "Start container", icon: "play" as const };
  if (action === "container_stop") return { title: "Stop container", icon: "stop" as const };
  if (action === "container_logs") return { title: "View logs", icon: "logs" as const };
  if (action === "container_restart") return { title: "Restart container", icon: "sync" as const };
  return { title: "Delete container", icon: "trash" as const };
}

function isActiveJob(job: Deployment, now = Date.now(), maxAge = activeJobMaxAge) {
  if (!["queued", "leased", "running"].includes(job.status)) return false;
  if (job.finishedAt) return false;
  if (job.leaseExpiresAt && job.leaseExpiresAt < now - 30_000) return false;
  return now - (job.startedAt || job.createdAt || now) < maxAge;
}

function containerActionMaxAge(job: Deployment) {
  if (job.action === "container_exec") return (Number(job.timeoutSeconds || 600) + 30) * 1000;
  if (job.action === "container_logs") return 20_000;
  return 30_000;
}

function isBusyContainerJob(job: Deployment, now: number, onlineWorkerIds?: Set<string>) {
  if (!job.containerId || !job.action.startsWith("container_")) return false;
  if (job.targetWorkerId && onlineWorkerIds && !onlineWorkerIds.has(job.targetWorkerId)) return false;
  return isActiveJob(job, now, containerActionMaxAge(job));
}

function containerActionSettled(action: string, displayStatus: string) {
  if (action === "container_start") return displayStatus === "running";
  if (action === "container_stop" || action === "container_delete") return displayStatus !== "running";
  return false;
}

function workerDisplayName(agent: Agent) {
  return agent.label || agent.hostname || agent.id;
}

function isWorkerOnline(agent: Agent, now: number, freshness = workerOnlineFreshness) {
  return agent.status === "online" && now - agent.lastHeartbeat < freshness;
}

function workerStatusLabel(agent: Agent, now: number) {
  if (agent.status === "stopping") return "stopping";
  if (isWorkerOnline(agent, now)) return "online";
  return "offline";
}

function SidebarWorkers({ agents, now, onOpenWorkers }: { agents: Agent[]; now: number; onOpenWorkers: () => void }) {
  const sortedAgents = [...agents].sort((a, b) => {
    const aOnline = Number(isWorkerOnline(a, now));
    const bOnline = Number(isWorkerOnline(b, now));
    return bOnline - aOnline || workerDisplayName(a).localeCompare(workerDisplayName(b));
  });
  const visibleAgents = sortedAgents.slice(0, 12);
  const onlineCount = sortedAgents.filter((agent) => isWorkerOnline(agent, now)).length;
  return (
    <section className="sidebar-workers" aria-label="Workers">
      <button className="sidebar-workers-header" type="button" title="View workers" data-tooltip="View workers" onClick={onOpenWorkers}>
        <span><Icon name="worker" /></span>
        <strong>Workers</strong>
        <small>{onlineCount}/{sortedAgents.length}</small>
      </button>
      {visibleAgents.length ? (
        <div className="sidebar-worker-list">
          {visibleAgents.map((agent) => {
            const online = isWorkerOnline(agent, now);
            const label = workerDisplayName(agent);
            const status = workerStatusLabel(agent, now);
            return (
              <button className="sidebar-worker-item" type="button" title={`${label} · ${status}`} data-tooltip={`${label} · ${status}`} onClick={onOpenWorkers} key={agent.id}>
                <span className={`sidebar-worker-dot ${online ? "is-online" : ""}`} aria-hidden="true" />
                <span>
                  <strong>{label}</strong>
                  <small>{agent.poolId || "default"} · {elapsed(agent.lastHeartbeat)}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="sidebar-workers-empty">No workers</p>
      )}
      {sortedAgents.length > visibleAgents.length ? <small className="sidebar-workers-more">+{sortedAgents.length - visibleAgents.length} more</small> : null}
    </section>
  );
}

function environmentToText(environment: Record<string, string> = {}) {
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n");
}

function EnvironmentEditor({ environment = {}, initialEnvText, className = "environment-field" }: { environment?: Record<string, string>; initialEnvText?: string; className?: string }) {
  const [mode, setMode] = useState<"env" | "json">("env");
  const [envText, setEnvText] = useState(initialEnvText ?? environmentToText(environment));
  const [jsonText, setJsonText] = useState(JSON.stringify(environment, null, 2));
  const value = mode === "env" ? envText : jsonText;
  return (
    <div className={`env-editor ${className}`}>
      <input type="hidden" name="environmentFormat" value={mode} />
      <div className="env-editor-header">
        <span>Environment variables</span>
        <div className="env-tabs" aria-label="Environment format">
          <button type="button" className={mode === "env" ? "is-active" : ""} aria-pressed={mode === "env"} onClick={() => setMode("env")}>KEY=VALUE</button>
          <button type="button" className={mode === "json" ? "is-active" : ""} aria-pressed={mode === "json"} onClick={() => setMode("json")}>JSON</button>
        </div>
      </div>
      <textarea
        name="environmentJson"
        value={value}
        onChange={(event) => (mode === "env" ? setEnvText(event.target.value) : setJsonText(event.target.value))}
        rows={4}
        spellCheck={false}
        placeholder={mode === "env" ? "PORT=8080\nDEBUG=true" : '{\n  "PORT": "8080",\n  "DEBUG": "true"\n}'}
      />
    </div>
  );
}

export function RealtimeDashboard(props: Props) {
  const router = useRouter();
  const base = `workspaces/${props.workspaceId}`;
  const repositories = useCollection<Repository>(`${base}/repositories`, props.initialRepositories);
  const deployments = useCollection<Deployment>(`${base}/deployments`, props.initialDeployments);
  const agents = useCollection<Agent>(`${base}/agents`, props.initialAgents);
  const credentials = useCollection<CredentialSummary>(`${base}/credentials`, props.initialCredentials);
  const containers = useCollection<ManagedContainer>(`${base}/containers`, props.initialContainers);
  const commandPresets = useCollection<CommandPreset>(`${base}/commandPresets`, props.initialCommandPresets);
  const [view, setView] = useState<View>("containers");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const onlineAgents = useMemo(() => agents.filter((agent) => isWorkerOnline(agent, now)), [agents, now]);
  const active = deployments.filter((item) => isActiveJob(item, now));
  const sortedDeployments = [...deployments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);

  async function logout() {
    await Promise.allSettled([signOut(firebaseAuth), fetch("/api/session", { method: "DELETE" })]);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="app-frame">
      <aside className="app-sidebar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <div><strong>Control</strong><span>Container workspace</span></div>
        </div>

        <p className="sidebar-label">Workspace</p>
        <nav className="sidebar-nav" aria-label="Workspace">
          <button className={view === "containers" ? "is-active" : ""} title="View containers" data-tooltip="View containers" onClick={() => setView("containers")}><span><Icon name="container" /></span>Containers</button>
          <button className={view === "repositories" ? "is-active" : ""} title="View repositories" data-tooltip="View repositories" onClick={() => setView("repositories")}><span><Icon name="repo" /></span>Repositories</button>
        </nav>

        <SidebarWorkers agents={agents} now={now} onOpenWorkers={() => setView("containers")} />

        <div className="sidebar-footer">
          <div className="session-user"><span aria-hidden="true" /><div><small>Signed in</small><strong>{props.user.email || props.user.role}</strong></div></div>
          <IconButton title="Sign out" onClick={logout}><Icon name="logout" /></IconButton>
        </div>
      </aside>

      <main className="main-shell">
        {view === "containers" ? (
          <ContainersView containers={containers} commandPresets={commandPresets} deployments={sortedDeployments} agents={agents} activeJobs={active.length} now={now} />
        ) : (
          <RepositoriesView repositories={repositories} commandPresets={commandPresets} credentials={credentials} deployments={sortedDeployments} agents={agents} activeJobs={active.length} now={now} />
        )}
      </main>
    </div>
  );
}

function ContainersView({ containers, commandPresets, deployments, agents, activeJobs, now }: {
  containers: ManagedContainer[];
  commandPresets: CommandPreset[];
  deployments: Deployment[];
  agents: Agent[];
  activeJobs: number;
  now: number;
}) {
  const [query, setQuery] = useState("");
  const [showLogsMonitor, setShowLogsMonitor] = useState(false);
  const [showCommandTerminal, setShowCommandTerminal] = useState(false);
  const [selectedLogContainerId, setSelectedLogContainerId] = useState("");
  const [containerViewMode, setContainerViewMode] = useState<"containers" | "groups" | "workers">("groups");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [expandedWorkers, setExpandedWorkers] = useState<Set<string>>(new Set());
  const [expandedWorkerStacks, setExpandedWorkerStacks] = useState<Set<string>>(new Set());
  const onlineWorkerIds = useMemo(
    () => new Set(agents.filter((agent) => isWorkerOnline(agent, now)).map((agent) => agent.id)),
    [agents, now],
  );
  const workerById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  function containerDisplayStatus(container: ManagedContainer) {
    if (!container.workerId) return "";
    const worker = workerById.get(container.workerId);
    if (!worker) return "";
    if (!isWorkerOnline(worker, now)) return "stopped";
    return container.status === "running" ? "running" : "stopped";
  }
  const visibleContainerRecords = containers.filter((container) => {
    return Boolean(containerDisplayStatus(container));
  });
  const sortedContainers = [...visibleContainerRecords].sort((a, b) => Number(containerDisplayStatus(b) === "running") - Number(containerDisplayStatus(a) === "running") || a.name.localeCompare(b.name));
  const filteredContainers = sortedContainers.filter((container) =>
    matchesQuery([container.name, container.image, container.project, containerDisplayStatus(container), container.dockerId, container.workerLabel, container.workerHostname, container.workerId, ...(container.ports || [])], query),
  );
  function isContainerActionBusy(container: ManagedContainer, action: string, displayStatus = containerDisplayStatus(container) || "stopped") {
    if (containerActionSettled(action, displayStatus)) return false;
    return deployments.some((job) => job.containerId === container.id && job.action === action && isBusyContainerJob(job, now, onlineWorkerIds));
  }
  const groupedContainers = useMemo(() => {
    const groups = new Map<string, ManagedContainer[]>();
    for (const container of filteredContainers) {
      const key = container.project || "Ungrouped";
      groups.set(key, [...(groups.get(key) || []), container]);
    }
    return [...groups.entries()].sort(([groupA], [groupB]) => {
      if (groupA === "Ungrouped") return 1;
      if (groupB === "Ungrouped") return -1;
      return groupA.localeCompare(groupB);
    });
  }, [filteredContainers]);
  const containersByWorker = useMemo(() => {
    const workers = new Map<string, { label: string; containers: ManagedContainer[] }>();
    for (const container of filteredContainers) {
      const key = container.workerId || container.workerHostname || "unknown-worker";
      const label = container.workerLabel || container.workerHostname || container.workerId || "Unknown worker";
      const group = workers.get(key) || { label, containers: [] };
      group.containers.push(container);
      workers.set(key, group);
    }
    return [...workers.entries()].sort(([, workerA], [, workerB]) => {
      if (workerA.label === "Unknown worker") return 1;
      if (workerB.label === "Unknown worker") return -1;
      return workerA.label.localeCompare(workerB.label);
    });
  }, [filteredContainers]);
  function groupByStack(items: ManagedContainer[]) {
    const stacks = new Map<string, ManagedContainer[]>();
    for (const container of items) {
      const key = container.project || "Ungrouped";
      stacks.set(key, [...(stacks.get(key) || []), container]);
    }
    return [...stacks.entries()].sort(([stackA], [stackB]) => {
      if (stackA === "Ungrouped") return 1;
      if (stackB === "Ungrouped") return -1;
      return stackA.localeCompare(stackB);
    });
  }
  function toggleGroup(group: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }
  function toggleWorker(worker: string) {
    setExpandedWorkers((current) => {
      const next = new Set(current);
      if (next.has(worker)) next.delete(worker);
      else next.add(worker);
      return next;
    });
  }
  function toggleWorkerStack(worker: string, stack: string) {
    const key = `${worker}:${stack}`;
    setExpandedWorkerStacks((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function openLogs(containerId = "") {
    setSelectedLogContainerId(containerId);
    setShowCommandTerminal(false);
    setShowLogsMonitor(true);
  }
  function renderContainerRow(container: ManagedContainer, showDivider: boolean) {
    const displayStatus = containerDisplayStatus(container) || "stopped";
    const workerOnline = Boolean(container.workerId && onlineWorkerIds.has(container.workerId));
    const workerContainer = isWorkerControlContainer(container);
    const baseActions: ContainerAction[] = !workerOnline ? [] : displayStatus === "running"
      ? ["container_stop", "container_logs", "container_restart", "container_delete"]
      : ["container_start"];
    const actions = baseActions.filter((action) => !isProtectedContainerAction(container, action));
    const primaryAction = workerContainer && displayStatus === "running" ? "container_restart" : containerPrimaryAction(displayStatus);
    const canUseRunningTools = displayStatus === "running" && workerOnline && !workerContainer;
    const workerName = container.workerLabel || container.workerHostname || container.workerId || "Unknown worker";
    const dockerId = container.dockerId || container.id;
    const dockerIdShort = dockerId.length > 12 ? dockerId.slice(0, 12) : dockerId;
    return (
      <article className="resource-row" key={container.id}>
        {showDivider ? <div className="resource-divider" /> : null}
        <div className="resource-identity"><ResourceGlyph /><div className="resource-copy"><strong>{container.name}</strong><span>{container.image}{container.project ? ` · ${container.project}` : ""}{workerContainer ? " · Worker" : ""}</span></div></div>
        <div className="resource-metadata">
          <StatusBadge label={displayStatus} running={displayStatus === "running"} />
          <span className="container-meta-line"><b>Docker</b> <code title={dockerId}>{dockerIdShort}</code> <b>Worker</b> <code title={container.workerId || workerName}>{workerName}</code></span>
          <small>{(container.ports || []).join(", ") || "No published ports"}</small>
        </div>
        <div className="row-actions">
          {commandPresets.length && canUseRunningTools ? (
            <form action={enqueueContainerCommand} className="container-command-form">
              <input type="hidden" name="containerId" value={container.id} />
              <input type="hidden" name="containerRef" value={container.dockerId || container.name || container.id} />
              <input type="hidden" name="timeoutSeconds" value="600" />
              <select className="container-command-select" name="command" required title={`Command for ${container.name}`} aria-label={`Command for ${container.name}`}>
                {commandPresets.map((preset) => <option value={preset.command} key={preset.id}>{preset.name}</option>)}
              </select>
              <PendingIconButton title="Run command in container" busy={isContainerActionBusy(container, "container_exec", displayStatus)}><Icon name="play" /></PendingIconButton>
            </form>
          ) : null}
          {actions.map((action) => {
            const meta = containerActionMeta(action);
            return (
              <form action={enqueueContainerAction} key={action}>
                <input type="hidden" name="containerId" value={container.id} />
                <input type="hidden" name="containerRef" value={container.dockerId || container.name || container.id} />
                <input type="hidden" name="action" value={action} />
                <PendingIconButton title={meta.title} primary={action === primaryAction} busy={isContainerActionBusy(container, action, displayStatus)} onClick={action === "container_logs" ? () => openLogs(container.id) : undefined}><Icon name={meta.icon} /></PendingIconButton>
              </form>
            );
          })}
        </div>
      </article>
    );
  }
  return (
    <div className="table-workspace containers-workspace">
      <div className="top-toolbar">
        <label className="search-field"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search containers..." /></label>
        <div className="toolbar-actions">
          {!showLogsMonitor && !showCommandTerminal ? (
            <div className="icon-toggle" aria-label="Container view mode">
              <button type="button" className={containerViewMode === "containers" ? "is-active" : ""} title="View containers" aria-label="View containers" aria-pressed={containerViewMode === "containers"} data-tooltip="View containers" onClick={() => setContainerViewMode("containers")}><Icon name="container" /></button>
              <button type="button" className={containerViewMode === "groups" ? "is-active" : ""} title="View groups" aria-label="View groups" aria-pressed={containerViewMode === "groups"} data-tooltip="View groups" onClick={() => setContainerViewMode("groups")}><Icon name="layers" /></button>
              <button type="button" className={containerViewMode === "workers" ? "is-active" : ""} title="View workers" aria-label="View workers" aria-pressed={containerViewMode === "workers"} data-tooltip="View workers" onClick={() => setContainerViewMode("workers")}><Icon name="worker" /></button>
            </div>
          ) : null}
          <IconButton title={showLogsMonitor ? "Show containers" : "Monitor logs"} onClick={() => { setShowCommandTerminal(false); setShowLogsMonitor((current) => !current); }} primary={showLogsMonitor}><Icon name={showLogsMonitor ? "container" : "logs"} /></IconButton>
          <IconButton title={showCommandTerminal ? "Show containers" : "Command terminal"} onClick={() => { setShowLogsMonitor(false); setShowCommandTerminal((current) => !current); }} primary={showCommandTerminal}><Icon name={showCommandTerminal ? "container" : "terminal"} /></IconButton>
          <form action={enqueueInventoryRefresh}><PendingIconButton title="Refresh containers"><Icon name="sync" /></PendingIconButton></form>
        </div>
      </div>

      {!showLogsMonitor && !showCommandTerminal && containerViewMode === "workers" ? <WorkersPanel agents={agents} containers={containers} now={now} /> : null}

      {showLogsMonitor ? (
        <LogsView containers={containers} deployments={deployments} agents={agents} selectedContainerId={selectedLogContainerId} now={now} onSelectContainer={setSelectedLogContainerId} onClose={() => setShowLogsMonitor(false)} />
      ) : showCommandTerminal ? (
        <CommandTerminal containers={containers} commandPresets={commandPresets} agents={agents} deployments={deployments} now={now} onClose={() => setShowCommandTerminal(false)} />
      ) : (
        <section className="panel resource-panel">
          {filteredContainers.length ? (
            containerViewMode === "workers" ? containersByWorker.map(([workerKey, worker], workerIndex) => {
              const isExpanded = expandedWorkers.has(workerKey);
              const running = worker.containers.filter((container) => containerDisplayStatus(container) === "running").length;
              const stacks = groupByStack(worker.containers);
              return (
                <div className={`container-group worker-container-group ${isExpanded ? "is-expanded" : ""}`} key={workerKey}>
                  {workerIndex ? <div className="resource-divider" /> : null}
                  <button type="button" className="container-group-header worker-group-header" aria-expanded={isExpanded} onClick={() => toggleWorker(workerKey)}>
                    <span className={`group-chevron ${isExpanded ? "is-open" : ""}`}><Icon name="chevron" /></span>
                    <span className="group-stack-icon worker-stack-icon"><Icon name="worker" /></span>
                    <span className="group-title"><strong>{worker.label}</strong><small>{stacks.length} stacks · {running} running · {worker.containers.length - running} stopped</small></span>
                    <span className="group-count">{worker.containers.length}</span>
                  </button>
                  {isExpanded ? (
                    <div className="worker-stack-list">
                      {stacks.map(([stack, stackContainers], stackIndex) => (
                        <div className="worker-stack-section" key={`${workerKey}:${stack}`}>
                          {stackIndex ? <div className="resource-divider" /> : null}
                          <button type="button" className="worker-stack-header" aria-expanded={expandedWorkerStacks.has(`${workerKey}:${stack}`)} onClick={() => toggleWorkerStack(workerKey, stack)}>
                            <span className={`group-chevron stack-chevron ${expandedWorkerStacks.has(`${workerKey}:${stack}`) ? "is-open" : ""}`}><Icon name="chevron" /></span>
                            <span className="worker-stack-title"><Icon name="layers" />{stack}</span>
                            <small>{stackContainers.length} containers</small>
                          </button>
                          {expandedWorkerStacks.has(`${workerKey}:${stack}`) ? <div className="container-group-body">{stackContainers.map((container, index) => renderContainerRow(container, index > 0))}</div> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            }) : containerViewMode === "groups" ? groupedContainers.map(([group, groupContainers], groupIndex) => {
              const isExpanded = expandedGroups.has(group);
              const running = groupContainers.filter((container) => containerDisplayStatus(container) === "running").length;
              return (
                <div className={`container-group ${isExpanded ? "is-expanded" : ""}`} key={group}>
                  {groupIndex ? <div className="resource-divider" /> : null}
                  <button type="button" className="container-group-header" aria-expanded={isExpanded} onClick={() => toggleGroup(group)}>
                    <span className={`group-chevron ${isExpanded ? "is-open" : ""}`}><Icon name="chevron" /></span>
                    <span className="group-stack-icon"><Icon name="layers" /></span>
                    <span className="group-title"><strong>{group}</strong><small>{running} running · {groupContainers.length - running} stopped</small></span>
                    <span className="group-count">{groupContainers.length}</span>
                  </button>
                  {isExpanded ? <div className="container-group-body">{groupContainers.map((container, index) => renderContainerRow(container, index > 0))}</div> : null}
                </div>
              );
            }) : filteredContainers.map((container, index) => renderContainerRow(container, index > 0))
          ) : <EmptyState title={visibleContainerRecords.length ? "No matching containers" : "No containers available"} copy={visibleContainerRecords.length ? "Clear the search field to show every available container." : "Start a container or bring its worker online to see stopped containers here."} />}
        </section>
      )}
    </div>
  );
}

function CommandTerminal({ containers, commandPresets, agents, deployments, now, onClose }: {
  containers: ManagedContainer[];
  commandPresets: CommandPreset[];
  agents: Agent[];
  deployments: Deployment[];
  now: number;
  onClose: () => void;
}) {
  const onlineWorkerIds = useMemo(
    () => new Set(agents.filter((agent) => isWorkerOnline(agent, now)).map((agent) => agent.id)),
    [agents, now],
  );
  const sortedContainers = useMemo(
    () => containers
      .filter((container) => container.status === "running" && container.workerId && onlineWorkerIds.has(container.workerId) && !isWorkerControlContainer(container))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [containers, onlineWorkerIds],
  );
  const sortedCommandPresets = useMemo(
    () => [...commandPresets].sort((a, b) => a.name.localeCompare(b.name)),
    [commandPresets],
  );
  const [selectedCommandId, setSelectedCommandId] = useState("");
  const [commandText, setCommandText] = useState(sortedCommandPresets[0]?.command || defaultContainerCommand);
  const defaultContainerId = sortedContainers[0]?.id || "";
  useEffect(() => {
    if (!selectedCommandId && sortedCommandPresets[0] && commandText === defaultContainerCommand) {
      setSelectedCommandId(sortedCommandPresets[0].id);
      setCommandText(sortedCommandPresets[0].command);
    }
  }, [commandText, selectedCommandId, sortedCommandPresets]);
  const commandJobs = deployments
    .filter((job) => job.action === "container_exec" || job.action === "worker_command")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 8);
  const activeCommand = commandJobs.some((job) => isActiveJob(job, now));
  const consoleText = commandJobs.map((job) => {
    const worker = agents.find((agent) => agent.id === (job.targetWorkerId || job.workerId));
    const container = containers.find((item) => item.id === job.containerId);
    const header = [
      `$ ${job.command || "worker command"}`,
      `# ${job.status}${container ? ` · ${container.name}` : ""}${worker ? ` · ${workerDisplayName(worker)}` : ""}${job.repositoryId ? ` · ${job.repositoryId}` : ""}`,
    ];
    const output = job.commandOutput?.trim() || job.message || (isActiveJob(job, now) ? "Running..." : "No output.");
    return [...header, output].join("\n");
  }).join("\n\n");
  return (
    <div className="command-workspace">
      <form action={enqueueContainerCommand} className="command-terminal-form">
        <div className="command-terminal-controls">
          <select name="containerId" required aria-label="Container" defaultValue={defaultContainerId}>
            <option value="" disabled>{sortedContainers.length ? "Select container" : "No containers available"}</option>
            {sortedContainers.map((container) => {
              const workerName = container.workerLabel || container.workerHostname || container.workerId || "Unknown worker";
              return <option value={container.id} key={container.id}>{container.name} · {container.status} · {workerName}</option>;
            })}
          </select>
          <select
            value={selectedCommandId}
            aria-label="Registered command"
            onChange={(event) => {
              const commandId = event.target.value;
              setSelectedCommandId(commandId);
              const preset = sortedCommandPresets.find((item) => item.id === commandId);
              if (preset) setCommandText(preset.command);
            }}
          >
            <option value="">{sortedCommandPresets.length ? "Custom command" : "No saved commands"}</option>
            {sortedCommandPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.name}</option>)}
          </select>
          <input name="timeoutSeconds" type="number" min={5} max={1800} defaultValue={600} aria-label="Timeout seconds" />
          <PendingSubmitButton className="primary" tooltip="Run command inside selected container">Run</PendingSubmitButton>
          <button type="button" className="icon-button" title="Close terminal" aria-label="Close terminal" data-tooltip="Close terminal" onClick={onClose}><Icon name="close" /></button>
        </div>
        <textarea
          name="command"
          rows={3}
          required
          spellCheck={false}
          value={commandText}
          onChange={(event) => {
            setSelectedCommandId("");
            setCommandText(event.target.value);
          }}
        />
      </form>
      <section className="logs-monitor command-monitor">
        <div className="logs-monitor-header">
          <div><strong>Command output</strong><span>{activeCommand ? "Running" : `${commandJobs.length} recent command${commandJobs.length === 1 ? "" : "s"}`}</span></div>
        </div>
        <pre className="logs-monitor-console"><code>{consoleText || "Run a command to see output here."}</code></pre>
      </section>
    </div>
  );
}

function LogsView({ containers, deployments, agents, selectedContainerId, now, onSelectContainer, onClose }: {
  containers: ManagedContainer[];
  deployments: Deployment[];
  agents: Agent[];
  selectedContainerId: string;
  now: number;
  onSelectContainer: (containerId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [fullscreen, setFullscreen] = useState(false);
  const onlineWorkerIds = useMemo(
    () => new Set(agents.filter((agent) => isWorkerOnline(agent, now)).map((agent) => agent.id)),
    [agents, now],
  );
  const sortedContainers = useMemo(
    () => containers
      .filter((container) => container.status === "running" && container.workerId && onlineWorkerIds.has(container.workerId))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [containers, onlineWorkerIds],
  );
  const projects = useMemo(
    () => [...new Set(sortedContainers.map((container) => container.project || "Ungrouped"))].sort((a, b) => a.localeCompare(b)),
    [sortedContainers],
  );
  const statuses = useMemo(
    () => [...new Set(sortedContainers.map((container) => container.status).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [sortedContainers],
  );
  const visibleContainers = sortedContainers.filter((container) => {
    if (selectedContainerId && container.id !== selectedContainerId) return false;
    if (projectFilter && (container.project || "Ungrouped") !== projectFilter) return false;
    if (statusFilter && container.status !== statusFilter) return false;
    if (!query.trim()) return true;
    return matchesQuery([container.name, container.image, container.project, container.status, container.logTail], query);
  });
  const activeLogJobs = useMemo(
    () => new Set(deployments.filter((job) => job.action === "container_logs" && isBusyContainerJob(job, now, onlineWorkerIds)).map((job) => job.containerId || "")),
    [deployments, now, onlineWorkerIds],
  );
  const consoleText = visibleContainers
    .map((container) => {
      const lines = [
        `$ ${container.name}  [${container.status}${container.project ? ` · ${container.project}` : ""}]`,
        container.logTail?.trim() || "No logs loaded yet. Refresh logs to request the latest tail.",
      ];
      return lines.join("\n");
    })
    .join("\n\n");
  const selectedContainer = selectedContainerId ? sortedContainers.find((container) => container.id === selectedContainerId) : undefined;
  const canRefreshSelectedContainer = Boolean(selectedContainerId && selectedContainer);
  useEffect(() => {
    if (!fullscreen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setFullscreen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  return (
    <div className={`logs-workspace ${fullscreen ? "is-fullscreen" : ""}`}>
      <div className="top-toolbar logs-toolbar">
        <label className="search-field"><span>Search logs</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter logs..." /></label>
        <div className="logs-filters">
          <select value={selectedContainerId} aria-label="Filter by container" onChange={(event) => onSelectContainer(event.target.value)}>
            <option value="">All containers</option>
            {sortedContainers.map((container) => <option value={container.id} key={container.id}>{container.name}</option>)}
          </select>
          <select value={projectFilter} aria-label="Filter by group" onChange={(event) => setProjectFilter(event.target.value)}>
            <option value="">All groups</option>
            {projects.map((project) => <option value={project} key={project}>{project}</option>)}
          </select>
          <select value={statusFilter} aria-label="Filter by status" onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">Any status</option>
            {statuses.map((status) => <option value={status} key={status}>{status}</option>)}
          </select>
        </div>
        <div className="toolbar-actions logs-actions">
          {canRefreshSelectedContainer ? (
            <form action={enqueueContainerAction}>
              <input type="hidden" name="containerId" value={selectedContainerId} />
              <input type="hidden" name="containerRef" value={selectedContainer?.dockerId || selectedContainer?.name || selectedContainerId} />
              <input type="hidden" name="action" value="container_logs" />
              <PendingIconButton title="Refresh selected logs" busy={activeLogJobs.has(selectedContainerId)}><Icon name="logs" /></PendingIconButton>
            </form>
          ) : null}
          {sortedContainers.length ? <form action={enqueueAllContainerLogs}><PendingIconButton title="Refresh all logs" busy={activeLogJobs.size > 0}><Icon name="sync" /></PendingIconButton></form> : null}
          <IconButton title={fullscreen ? "Exit fullscreen" : "Fullscreen logs"} onClick={() => setFullscreen((current) => !current)} primary={fullscreen}><Icon name={fullscreen ? "collapse" : "expand"} /></IconButton>
          <IconButton title="Close logs" onClick={onClose}><Icon name="close" /></IconButton>
        </div>
      </div>

      <section className="logs-monitor">
        <div className="logs-monitor-header">
          <div><strong>Live logs</strong><span>{visibleContainers.length} of {containers.length} containers</span></div>
          {selectedContainerId ? <button type="button" title="Show all containers" data-tooltip="Show all containers" onClick={() => onSelectContainer("")}><Icon name="close" /></button> : null}
        </div>
        <pre className="logs-monitor-console"><code>{consoleText || "No containers match the current filters."}</code></pre>
      </section>
    </div>
  );
}

function RepositoriesView({ repositories, commandPresets, credentials, deployments, agents, activeJobs, now }: {
  repositories: Repository[];
  commandPresets: CommandPreset[];
  credentials: CredentialSummary[];
  deployments: Deployment[];
  agents: Agent[];
  activeJobs: number;
  now: number;
}) {
  const [query, setQuery] = useState("");
  const [editingRepositoryId, setEditingRepositoryId] = useState<string | null>(null);
  const [viewingComposeRepositoryId, setViewingComposeRepositoryId] = useState<string | null>(null);
  const [showAddRepository, setShowAddRepository] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);
  const [showCommandPresets, setShowCommandPresets] = useState(false);
  const [selectedWorkerByRepository, setSelectedWorkerByRepository] = useState<Record<string, string>>({});
  const availableWorkers = useMemo(
    () => agents.filter((agent) => isWorkerOnline(agent, now)).sort((a, b) => workerDisplayName(a).localeCompare(workerDisplayName(b))),
    [agents, now],
  );
  const availableWorkerKey = availableWorkers.map((agent) => agent.id).join("|");
  const availableWorkerIds = useMemo(() => new Set(availableWorkers.map((agent) => agent.id)), [availableWorkerKey]);
  const busyRepositoryActions = useMemo(
    () => new Set(deployments.filter((job) => isActiveJob(job, now) && (!job.targetWorkerId || availableWorkerIds.has(job.targetWorkerId))).map(activeRepositoryJobKey)),
    [deployments, availableWorkerIds, now],
  );
  useEffect(() => {
    setSelectedWorkerByRepository((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([, workerId]) => !workerId || availableWorkerIds.has(workerId)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, [availableWorkerIds]);
  const filteredRepositories = repositories.filter((repository) =>
    matchesQuery([
      repository.alias,
      repository.url,
      repository.branch,
      repository.mode,
      repository.poolId,
      repository.domain,
      repository.service,
      repository.composeFile,
      repository.dockerfile,
    ], query),
  );
  return (
    <div className="table-workspace repositories-workspace">
      <div className="top-toolbar">
        <label className="search-field"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search repositories..." /></label>
        <div className="toolbar-actions">
          <IconButton title={showAddRepository ? "Close repository form" : "Add repository"} onClick={() => setShowAddRepository((current) => !current)} primary={showAddRepository}><Icon name={showAddRepository ? "close" : "add"} /></IconButton>
          <IconButton title={showCredentials ? "Close credentials" : "Add credential"} onClick={() => setShowCredentials((current) => !current)}><Icon name="key" /></IconButton>
          <IconButton title={showCommandPresets ? "Close commands" : "Registered commands"} onClick={() => setShowCommandPresets((current) => !current)} primary={showCommandPresets}><Icon name="terminal" /></IconButton>
          <form action={enqueueAllRepositories}><PendingIconButton title="Sync all"><Icon name="sync" /></PendingIconButton></form>
        </div>
      </div>

      {showAddRepository ? <AddRepositoryPanel credentials={credentials} /> : null}
      {showCredentials ? <CredentialsPanel credentials={credentials} /> : null}
      {showCommandPresets ? <CommandPresetsPanel commandPresets={commandPresets} /> : null}

      <section className="panel resource-panel">
        {filteredRepositories.length ? filteredRepositories.map((repository, index) => {
          const targetWorkerId = selectedWorkerByRepository[repository.id] || "";
          const workerSelected = Boolean(targetWorkerId);
          const actionKey = (action: RepositoryAction) => `${repository.id}:${action}:${targetWorkerId}`;
          return (
            <article className="resource-row repo-resource-row" key={repository.id}>
              {index ? <div className="resource-divider" /> : null}
              <div className="resource-identity"><GithubMark /><div className="resource-copy"><strong>{repository.alias}</strong><span>{repository.mode === "compose" ? "Docker Compose" : "Dockerfile"}</span></div></div>
              <div className="resource-metadata"><span title={repository.url}>{repository.url}</span><small>{repository.mode === "compose" ? repository.composeFile || defaultComposeFile : repository.dockerfile || "Dockerfile"} · Branch {repository.branch || "default"}</small></div>
              <div className="row-actions">
                <select className="worker-target-select" value={targetWorkerId} title="Run on worker" aria-label={`Run ${repository.alias} on worker`} onChange={(event) => setSelectedWorkerByRepository((current) => ({ ...current, [repository.id]: event.target.value }))}>
                  <option value="">Any worker</option>
                  {availableWorkers.map((agent) => <option value={agent.id} key={agent.id}>{workerDisplayName(agent)}</option>)}
                </select>
                <QueueButton repositoryId={repository.id} action="sync" title="Sync repository" targetWorkerId={targetWorkerId} busy={busyRepositoryActions.has(actionKey("sync"))} disabled={!workerSelected}><Icon name="sync" /></QueueButton>
                <IconButton
                  title={editingRepositoryId === repository.id ? "Close settings" : "Edit repository"}
                  onClick={() => setEditingRepositoryId((current) => current === repository.id ? null : repository.id)}
                >
                  <Icon name="sliders" />
                </IconButton>
                {repository.mode === "compose" ? (
                  viewingComposeRepositoryId === repository.id ? (
                    <IconButton title="Close Compose" onClick={() => setViewingComposeRepositoryId(null)}><Icon name="close" /></IconButton>
                  ) : (
                    <form action={enqueueDeployment}>
                      <input type="hidden" name="repositoryId" value={repository.id} />
                      <input type="hidden" name="action" value="read_compose" />
                      <input type="hidden" name="targetWorkerId" value={targetWorkerId} />
                      <PendingIconButton title={workerSelected ? "View Compose" : "Select a worker first"} busy={busyRepositoryActions.has(actionKey("read_compose"))} disabled={!workerSelected} onClick={() => setViewingComposeRepositoryId(repository.id)}><Icon name="document" /></PendingIconButton>
                    </form>
                  )
                ) : null}
                {repository.mode === "compose" ? <QueueButton repositoryId={repository.id} action="deploy" title="Deploy" targetWorkerId={targetWorkerId} primary busy={busyRepositoryActions.has(actionKey("deploy"))} disabled={!workerSelected}><Icon name="play" /></QueueButton> : <QueueButton repositoryId={repository.id} action="build" title="Build and run" targetWorkerId={targetWorkerId} primary busy={busyRepositoryActions.has(actionKey("build"))} disabled={!workerSelected}><Icon name="play" /></QueueButton>}
                <QueueButton repositoryId={repository.id} action="stop" title="Stop" targetWorkerId={targetWorkerId} busy={busyRepositoryActions.has(actionKey("stop"))} disabled={!workerSelected}><Icon name="stop" /></QueueButton>
                <form action={deleteRepository}><input type="hidden" name="repositoryId" value={repository.id} /><PendingIconButton title="Remove repository"><Icon name="trash" /></PendingIconButton></form>
              </div>
              <RepositorySettings repository={repository} credentials={credentials} open={editingRepositoryId === repository.id} />
              <ComposeViewer repository={repository} open={viewingComposeRepositoryId === repository.id} onClose={() => setViewingComposeRepositoryId(null)} />
            </article>
          );
        }) : <EmptyState title={repositories.length ? "No matching repositories" : "No repositories yet"} copy={repositories.length ? "Clear the search field to show every repository." : "Register a repository to start deploying from Git."} />}
      </section>
    </div>
  );
}

function AddRepositoryPanel({ credentials }: { credentials: CredentialSummary[] }) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [branch, setBranch] = useState("");
  const [deployMode, setDeployMode] = useState<"dockerfile" | "compose">("dockerfile");
  const [showRepositoryImport, setShowRepositoryImport] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchMessage, setBranchMessage] = useState("");
  const [loadingBranches, setLoadingBranches] = useState(false);

  async function discoverBranches() {
    if (!repositoryUrl.trim()) {
      setBranchMessage("Add a repository URL first.");
      return;
    }
    setLoadingBranches(true);
    setBranchMessage("");
    try {
      const response = await fetch("/api/branches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: repositoryUrl, credentialId }),
      });
      const payload = await response.json() as { branches?: string[]; defaultBranch?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load branches");
      const nextBranches = payload.branches || [];
      setBranches(nextBranches);
      setBranch(payload.defaultBranch || nextBranches[0] || "");
      setBranchMessage(nextBranches.length ? `${nextBranches.length} branches loaded.` : "No branches found.");
    } catch (cause) {
      setBranches([]);
      setBranchMessage(cause instanceof Error ? cause.message : "Could not load branches");
    } finally {
      setLoadingBranches(false);
    }
  }

  return (
    <section className="panel add-repository-panel">
      <form action={saveRepository} className="add-repository-form">
        <input type="hidden" name="poolId" value="default" />
        <input type="hidden" name="domain" value="" />
        <input type="hidden" name="service" value="web" />
        <input type="hidden" name="internalPort" value="3000" />

        <div className="add-repository-top">
          <fieldset className="mode-control">
            <legend>Deployment mode <Icon name="help" /></legend>
            <div className="segmented-radio">
              <label><input type="radio" name="mode" value="dockerfile" checked={deployMode === "dockerfile"} onChange={() => setDeployMode("dockerfile")} /><span>Single Dockerfile</span></label>
              <label><input type="radio" name="mode" value="compose" checked={deployMode === "compose"} onChange={() => setDeployMode("compose")} /><span>Docker Compose</span></label>
              <button type="button" className="segment-icon-button" title={showRepositoryImport ? "Close JSON import" : "Import repositories JSON"} aria-label={showRepositoryImport ? "Close JSON import" : "Import repositories JSON"} data-tooltip={showRepositoryImport ? "Close JSON import" : "Import repositories JSON"} onClick={() => setShowRepositoryImport((current) => !current)}><Icon name={showRepositoryImport ? "close" : "document"} /></button>
            </div>
          </fieldset>
          <label className="credential-select">GitHub credential<select name="credentialId" value={credentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">Public (no credential)</option>{credentials.map((item) => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
        </div>

        <div className="repository-input-card">
          <label className="url-field">Repository URL<div className="input-with-action"><input name="url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} required placeholder="https://github.com/user/repository.git" /><button type="button" title="Discover branches" aria-label="Discover branches" data-tooltip="Discover branches" onClick={discoverBranches} disabled={loadingBranches}><Icon name={loadingBranches ? "sync" : "branch"} /></button></div></label>
          <label>Display name<input name="alias" required placeholder="my-service" /></label>
          <label>Branch<input name="branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Default" list="new-repository-branches" /><datalist id="new-repository-branches">{branches.map((item) => <option key={item} value={item} />)}</datalist>{branchMessage ? <small className="field-hint">{branchMessage}</small> : null}</label>
          {deployMode === "dockerfile" ? (
            <>
              <label>Dockerfile<input name="dockerfile" defaultValue="Dockerfile" /></label>
              <label>Host:container ports<input name="ports" placeholder="8080:80" /></label>
            </>
          ) : (
            <>
              <label>Compose file<input name="composeFile" defaultValue={defaultComposeFile} /></label>
              <div className="compose-port-note"><span>Ports are read from the Compose file.</span></div>
            </>
          )}
          <EnvironmentEditor initialEnvText="" />
          <div className="register-action"><PendingSubmitButton tooltip="Clone repository and save this configuration"><Icon name="download" />Clone and register</PendingSubmitButton></div>
        </div>
      </form>
      {showRepositoryImport ? (
        <form action={importRepositoriesJson} className="repository-import-form">
          <label>Repositories JSON<textarea name="repositoriesJson" rows={6} spellCheck={false} placeholder='{"my-repo":{"url":"https://github.com/org/repo.git","mode":"compose","compose_file":"compose.yml"}}' /></label>
          <div className="form-actions"><PendingSubmitButton className="secondary" tooltip="Import repositories from JSON">Import repositories</PendingSubmitButton></div>
        </form>
      ) : null}
    </section>
  );
}

function RepositorySettings({ repository, credentials, open }: { repository: Repository; credentials: CredentialSummary[]; open: boolean }) {
  const [repositoryUrl, setRepositoryUrl] = useState(repository.url);
  const [credentialId, setCredentialId] = useState(repository.credentialId || "");
  const [branch, setBranch] = useState(repository.branch || "");
  const [branches, setBranches] = useState<string[]>(repository.availableBranches || []);
  const [branchMessage, setBranchMessage] = useState("");
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    setRepositoryUrl(repository.url);
    setCredentialId(repository.credentialId || "");
    setBranch(repository.branch || "");
    setBranches(repository.availableBranches || []);
    setBranchMessage("");
    setLoadingBranches(false);
  }, [repository.id, repository.url, repository.credentialId, repository.branch, repository.availableBranches]);

  async function discoverBranches() {
    if (!repositoryUrl.trim()) {
      setBranchMessage("Add a repository URL first.");
      return;
    }
    setLoadingBranches(true);
    setBranchMessage("");
    try {
      const response = await fetch("/api/branches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: repositoryUrl, credentialId }),
      });
      const payload = await response.json() as { branches?: string[]; defaultBranch?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load branches");
      const nextBranches = payload.branches || [];
      setBranches(nextBranches);
      setBranch(payload.defaultBranch || nextBranches[0] || branch);
      setBranchMessage(nextBranches.length ? `${nextBranches.length} branches loaded.` : "No branches found.");
    } catch (cause) {
      setBranches([]);
      setBranchMessage(cause instanceof Error ? cause.message : "Could not load branches");
    } finally {
      setLoadingBranches(false);
    }
  }

  if (!open) return null;
  return (
    <details className="inline-editor" open={open}>
      <summary><span>Edit settings</span><span>⌄</span></summary>
      <form action={saveRepository} className="form-grid">
        <input type="hidden" name="repositoryId" value={repository.id} />
        <label>Alias<input name="alias" defaultValue={repository.alias} required /></label>
        <label className="wide">Repository URL<input name="url" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} required /></label>
        <label>Branch<div className="input-with-action"><input name="branch" value={branch} onChange={(event) => setBranch(event.target.value)} placeholder="Default" list={`branches-${repository.id}`} /><button type="button" title="Discover branches" aria-label="Discover branches" data-tooltip="Discover branches" onClick={discoverBranches} disabled={loadingBranches}><Icon name={loadingBranches ? "sync" : "branch"} /></button></div><datalist id={`branches-${repository.id}`}>{branches.map((item) => <option key={item} value={item} />)}</datalist>{branchMessage ? <small className="field-hint">{branchMessage}</small> : null}</label>
        <label>Credential<select name="credentialId" value={credentialId} onChange={(event) => setCredentialId(event.target.value)}><option value="">Public repository</option>{credentials.map((item) => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
        <label>Mode<select name="mode" defaultValue={repository.mode}><option value="compose">Docker Compose</option><option value="dockerfile">Dockerfile</option></select></label>
        <label>Compose file<input name="composeFile" defaultValue={repository.composeFile} /></label>
        <label>Dockerfile<input name="dockerfile" defaultValue={repository.dockerfile} /></label>
        <label>Worker pool<input name="poolId" defaultValue={repository.poolId || "default"} /></label>
        <label>Domain<input name="domain" defaultValue={repository.domain} /></label>
        <label>Compose service<input name="service" defaultValue={repository.service || "web"} /></label>
        <label>Internal port<input name="internalPort" type="number" defaultValue={repository.internalPort || 3000} /></label>
        <label>Host:container ports<input name="ports" defaultValue={repository.ports || ""} /></label>
        <EnvironmentEditor className="full" environment={repository.environment || {}} />
        <div className="full form-actions"><PendingSubmitButton tooltip="Save repository settings">Save settings</PendingSubmitButton><PendingSubmitButton className="secondary" formAction={deleteRepository} tooltip="Remove this repository registration">Remove registration</PendingSubmitButton></div>
      </form>
    </details>
  );
}

function ComposeViewer({ repository, open, onClose }: { repository: Repository; open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="compose-viewer full-row">
      <div className="compose-viewer-header">
        <div><strong>Docker Compose</strong><span>{repository.composeFile || defaultComposeFile}</span></div>
        <button type="button" title="Close Compose" aria-label="Close Compose" data-tooltip="Close Compose" onClick={onClose}><Icon name="close" /></button>
      </div>
      <pre className="code-viewer"><code>{repository.composeContent || "Loading Compose file..."}</code></pre>
    </div>
  );
}

function CredentialsPanel({ credentials }: { credentials: CredentialSummary[] }) {
  const [showCredentialForm, setShowCredentialForm] = useState(false);
  const [showImportForm, setShowImportForm] = useState(false);
  return (
    <section className="panel credentials-panel">
      <div className="section-title panel-title-row">
        <div><h2>Credentials</h2></div>
        <div className="row-actions">
          <IconButton title={showCredentialForm ? "Close credential form" : "Add credential"} onClick={() => setShowCredentialForm((current) => !current)}>
            <Icon name={showCredentialForm ? "close" : "add"} />
          </IconButton>
          <IconButton title={showImportForm ? "Close JSON import" : "Import JSON"} onClick={() => setShowImportForm((current) => !current)}>
            <Icon name={showImportForm ? "close" : "document"} />
          </IconButton>
        </div>
      </div>
      {showCredentialForm ? (
        <form action={saveCredential} className="form-grid one-column compact-form">
          <label>Alias<input name="alias" required /></label>
          <label>Username<input name="username" /></label>
          <label>Personal access token<input name="token" type="password" required /></label>
          <a className="help-link" href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer">Generate a GitHub token</a>
          <div className="form-actions"><PendingSubmitButton tooltip="Save credential">Save credential</PendingSubmitButton></div>
        </form>
      ) : null}
      {showImportForm ? (
        <form action={saveCredentialsJson} className="form-grid one-column">
          <label>Credential JSON<textarea name="credentialsJson" rows={5} defaultValue={'{\n  "github": {\n    "username": "",\n    "token": ""\n  }\n}'} /></label>
          <div className="form-actions"><PendingSubmitButton className="secondary" tooltip="Import credentials from JSON">Import credentials</PendingSubmitButton></div>
        </form>
      ) : null}
      <div className="compact-list">{credentials.map((credential) => (
        <div className="compact-row" key={credential.id}><div><strong>{credential.alias}</strong><small>{credential.username || "GitHub"} · {credential.tokenMask}</small></div><form action={deleteCredential}><input type="hidden" name="credentialId" value={credential.id} /><PendingIconButton title="Delete credential"><Icon name="trash" /></PendingIconButton></form></div>
      ))}</div>
      {!credentials.length && !showCredentialForm ? <p className="empty-copy">No credentials saved.</p> : null}
    </section>
  );
}

function CommandPresetsPanel({ commandPresets }: { commandPresets: CommandPreset[] }) {
  const sortedCommandPresets = [...commandPresets].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="panel command-presets-panel">
      <div className="section-title"><div><h2>Registered commands</h2></div></div>
      <form action={saveCommandPreset} className="form-grid command-preset-form">
        <label>Name<input name="name" required placeholder="Nuke database" /></label>
        <label>Description<input name="description" placeholder="Runs maintenance script inside selected container" /></label>
        <label className="full">Command<textarea name="command" rows={3} required spellCheck={false} defaultValue={defaultContainerCommand} /></label>
        <div className="full form-actions"><PendingSubmitButton tooltip="Save registered command">Save command</PendingSubmitButton></div>
      </form>
      <div className="command-preset-list">
        {sortedCommandPresets.map((preset) => (
          <details className="compact-editor command-preset-item" key={preset.id}>
            <summary>
              <span><strong>{preset.name}</strong><small>{preset.description || preset.command}</small></span>
              <Icon name="chevron" />
            </summary>
            <form action={saveCommandPreset} className="form-grid">
              <input type="hidden" name="commandId" value={preset.id} />
              <label>Name<input name="name" required defaultValue={preset.name} /></label>
              <label>Description<input name="description" defaultValue={preset.description || ""} /></label>
              <label className="full">Command<textarea name="command" rows={3} required spellCheck={false} defaultValue={preset.command} /></label>
              <div className="full form-actions">
                <PendingSubmitButton tooltip="Update command">Save</PendingSubmitButton>
                <PendingSubmitButton className="secondary" formAction={deleteCommandPreset} tooltip="Delete command">Delete</PendingSubmitButton>
              </div>
            </form>
          </details>
        ))}
      </div>
      {!sortedCommandPresets.length ? <p className="empty-copy">No commands registered.</p> : null}
    </section>
  );
}

function WorkersPanel({ agents, containers, now }: { agents: Agent[]; containers: ManagedContainer[]; now: number }) {
  const sortedAgents = [...agents].sort((a, b) => {
    const aOnline = Number(isWorkerOnline(a, now));
    const bOnline = Number(isWorkerOnline(b, now));
    return bOnline - aOnline || (a.label || a.hostname || a.id).localeCompare(b.label || b.hostname || b.id);
  });
  return (
    <section className="workers-panel">
      <div className="workers-panel-header">
        <strong>Workers</strong>
        <span>{sortedAgents.filter((agent) => isWorkerOnline(agent, now)).length}/{sortedAgents.length} online</span>
      </div>
      <div className="workers-grid">{sortedAgents.map((agent) => {
        const online = isWorkerOnline(agent, now);
        const statusLabel = workerStatusLabel(agent, now);
        const ownedContainerCount = containers.filter((container) => container.workerId === agent.id).length;
        const canDelete = !online && agent.status === "offline" && now - agent.lastHeartbeat >= orphanWorkerDeleteAge;
        const displayName = agent.label || agent.hostname || agent.id;
        const docker = agent.docker;
        const deleteTitle = ownedContainerCount
          ? `Remove stale worker record and ${ownedContainerCount} stale container record${ownedContainerCount === 1 ? "" : "s"}`
          : "Remove stale worker record";
        return (
          <details className="worker-card" key={agent.id}>
            <summary>
              <StatusBadge label={statusLabel} running={online} />
              <div className="worker-card-title">
                <strong>{displayName}</strong>
                <small>{agent.poolId || "default"} · {agent.activeJobs || 0}/{agent.maxConcurrency || 1} jobs · {elapsed(agent.lastHeartbeat)}</small>
              </div>
              <span className="worker-card-chevron"><Icon name="chevron" /></span>
            </summary>
            <div className="worker-details">
              <span><strong>ID</strong><small>{agent.id}</small></span>
              <span><strong>Identity</strong><small>{agent.identitySource || "unknown"}</small></span>
              <span><strong>Host</strong><small>{agent.hostname || "Unknown"}{agent.location ? ` · ${agent.location}` : ""}</small></span>
              <span><strong>Shards</strong><small>{agent.shards?.length ? agent.shards.join(", ") : "all/default"}</small></span>
              <span><strong>Runtime</strong><small>Python {agent.pythonVersion || "unknown"} · {agent.machine || agent.system || "host"}</small></span>
              <span><strong>Paths</strong><small>{agent.cloneDir || "/app/clones"} · {agent.dataDir || "/app/data"}</small></span>
              <span><strong>Docker</strong><small>{docker?.available ? `${docker.containersRunning || 0}/${docker.containers || 0} running · ${docker.images || 0} images · ${docker.serverVersion || "Docker"}` : docker?.error || "Unavailable"}</small></span>
              <span><strong>Timing</strong><small>lease {agent.leaseSeconds || 90}s · poll {agent.pollSeconds || 5}s · started {elapsed(agent.startedAt)}</small></span>
              <span><strong>Traefik</strong><small>{agent.traefikEnabled ? agent.traefikNetwork || "proxy" : "disabled"}</small></span>
              {canDelete ? (
                <form action={deleteWorker} className="worker-delete-form">
                  <input type="hidden" name="workerId" value={agent.id} />
                  <PendingIconButton title={deleteTitle}><Icon name="trash" /></PendingIconButton>
                </form>
              ) : null}
            </div>
          </details>
        );
      })}</div>
      {!sortedAgents.length ? <p className="empty-copy">No worker has checked in yet.</p> : null}
    </section>
  );
}

function DeploymentsPanel({ deployments }: { deployments: Deployment[] }) {
  return (
    <section className="panel">
      <div className="section-title"><div><h2>Activity</h2></div></div>
      <div className="activity-list">{deployments.map((job) => (
        <article className="activity-row" key={job.id}>
          <StatusBadge label={job.status} running={job.status === "running" || job.status === "completed"} />
          <div><strong>{job.repositoryId || "job"} · {job.action}</strong><small>{job.message || `Queued ${elapsed(job.createdAt)}`}</small></div>
          {["queued", "leased", "running"].includes(job.status) ? <form action={cancelDeployment}><input type="hidden" name="jobId" value={job.id} /><PendingIconButton title="Cancel"><Icon name="close" /></PendingIconButton></form> : null}
        </article>
      ))}</div>
      {!deployments.length ? <p className="empty-copy">No deployment activity yet.</p> : null}
    </section>
  );
}
