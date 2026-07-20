"use client";

import { signOut } from "firebase/auth";
import { onValue, ref } from "firebase/database";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  cancelDeployment,
  deleteCredential,
  deleteRepository,
  enqueueAllRepositories,
  enqueueContainerAction,
  enqueueDeployment,
  enqueueInventoryRefresh,
  importRepositoriesJson,
  saveCredential,
  saveCredentialsJson,
  saveRepository,
} from "@/app/actions";
import { firebaseAuth, realtimeDatabase } from "@/lib/firebase-client";
import type { Agent, CredentialSummary, Deployment, ManagedContainer, Repository } from "@/lib/types";

type Props = {
  workspaceId: string;
  user: { email: string; role: string };
  initialRepositories: Repository[];
  initialDeployments: Deployment[];
  initialAgents: Agent[];
  initialCredentials: CredentialSummary[];
  initialContainers: ManagedContainer[];
};

type View = "containers" | "repositories";
type RepositoryAction = "sync" | "deploy" | "stop" | "build" | "discover_branches" | "read_compose";
type ContainerAction = "container_start" | "container_stop" | "container_restart" | "container_delete" | "container_logs";
const defaultComposeFile = "compose.yml";

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

function Icon({ name }: { name: "add" | "key" | "sync" | "sliders" | "document" | "play" | "stop" | "terminal" | "trash" | "logout" | "container" | "repo" | "close" | "branch" | "download" | "help" }) {
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
      {name === "terminal" ? <path {...common} d="M4.5 6.25h15v11.5h-15zM8.2 10l2.15 2-2.15 2M12.35 14h4.2" /> : null}
      {name === "trash" ? <path {...common} d="M4.75 7h14.5M9.75 11v5.75M14.25 11v5.75M8 7l1.1-3h5.8L16 7M6.75 7l.9 13.25h8.7L17.25 7" /> : null}
      {name === "logout" ? <path {...common} d="M10.25 5.75h-4.5v12.5h4.5M14.25 8.25 18 12l-3.75 3.75M8.25 12H18" /> : null}
      {name === "container" ? <path {...common} d="M5.25 4h13.5A1.25 1.25 0 0 1 20 5.25v13.5A1.25 1.25 0 0 1 18.75 20H5.25A1.25 1.25 0 0 1 4 18.75V5.25A1.25 1.25 0 0 1 5.25 4ZM6.75 8h10.5M6.75 12h10.5M6.75 16h10.5" /> : null}
      {name === "repo" ? <path {...common} d="M6.25 4.75h11.5v14.5H6.25zM9.1 8.5h5.8M9.1 12h5.8M9.1 15.5h3.2" /> : null}
      {name === "close" ? <path {...common} d="M6.75 6.75l10.5 10.5M17.25 6.75 6.75 17.25" /> : null}
      {name === "branch" ? <path {...common} d="M7 6.9a2.15 2.15 0 1 0 0-4.3 2.15 2.15 0 0 0 0 4.3Zm0 0v5.25a3.35 3.35 0 0 0 3.35 3.35h3.3M17 17.4a2.15 2.15 0 1 0 0-4.3 2.15 2.15 0 0 0 0 4.3Zm0-10.5a2.15 2.15 0 1 0 0-4.3 2.15 2.15 0 0 0 0 4.3Zm0 0v1.85a3.35 3.35 0 0 1-3.35 3.35h-2" /> : null}
      {name === "download" ? <path {...common} d="M12 4.25v10.1M8.35 10.7 12 14.35l3.65-3.65M5.25 19.75h13.5" /> : null}
      {name === "help" ? <path {...common} d="M9.45 9a2.65 2.65 0 1 1 4.2 2.15c-.95.66-1.65 1.15-1.65 2.45M12 17.4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /> : null}
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

function PendingIconButton({ title, children, onClick, primary = false, busy = false }: { title: string; children: React.ReactNode; onClick?: () => void; primary?: boolean; busy?: boolean }) {
  const { pending } = useFormStatus();
  const isBusy = pending || busy;
  return <IconButton title={isBusy ? `${title}...` : title} primary={primary} onClick={onClick} disabled={isBusy}>{isBusy ? <Spinner /> : children}</IconButton>;
}

function PendingSubmitButton({ children, className = "primary", formAction, tooltip }: { children: React.ReactNode; className?: string; formAction?: (formData: FormData) => void | Promise<void>; tooltip?: string }) {
  const { pending } = useFormStatus();
  return <button className={className} type="submit" title={tooltip} data-tooltip={tooltip} formAction={formAction} disabled={pending}>{pending ? <Spinner /> : children}</button>;
}

function QueueButton({ repositoryId, action, children, title, primary = false, busy = false }: {
  repositoryId: string;
  action: RepositoryAction;
  children: React.ReactNode;
  title: string;
  primary?: boolean;
  busy?: boolean;
}) {
  return (
    <form action={enqueueDeployment}>
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <input type="hidden" name="action" value={action} />
      <PendingIconButton title={title} primary={primary} busy={busy}>{children}</PendingIconButton>
    </form>
  );
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

function containerActionMeta(action: ContainerAction) {
  if (action === "container_start") return { title: "Start container", icon: "play" as const };
  if (action === "container_stop") return { title: "Stop container", icon: "stop" as const };
  if (action === "container_logs") return { title: "View logs", icon: "terminal" as const };
  if (action === "container_restart") return { title: "Restart container", icon: "sync" as const };
  return { title: "Delete container", icon: "trash" as const };
}

function isActiveJob(job: Deployment) {
  return ["queued", "leased", "running"].includes(job.status);
}

export function RealtimeDashboard(props: Props) {
  const router = useRouter();
  const base = `workspaces/${props.workspaceId}`;
  const repositories = useCollection<Repository>(`${base}/repositories`, props.initialRepositories);
  const deployments = useCollection<Deployment>(`${base}/deployments`, props.initialDeployments);
  const agents = useCollection<Agent>(`${base}/agents`, props.initialAgents);
  const credentials = useCollection<CredentialSummary>(`${base}/credentials`, props.initialCredentials);
  const containers = useCollection<ManagedContainer>(`${base}/containers`, props.initialContainers);
  const [view, setView] = useState<View>("containers");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const onlineAgents = useMemo(() => agents.filter((agent) => agent.status !== "offline" && now - agent.lastHeartbeat < 30_000), [agents, now]);
  const active = deployments.filter((item) => ["queued", "leased", "running"].includes(item.status));
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

        <div className="sidebar-footer">
          <div className="session-user"><span aria-hidden="true" /><div><small>Signed in</small><strong>{props.user.email || props.user.role}</strong></div></div>
          <IconButton title="Sign out" onClick={logout}><Icon name="logout" /></IconButton>
        </div>
      </aside>

      <main className="main-shell">
        {view === "containers" ? (
          <ContainersView containers={containers} deployments={sortedDeployments} agents={agents} activeJobs={active.length} now={now} />
        ) : (
          <RepositoriesView repositories={repositories} credentials={credentials} deployments={sortedDeployments} agents={agents} activeJobs={active.length} now={now} />
        )}
      </main>
    </div>
  );
}

function ContainersView({ containers, deployments, agents, activeJobs, now }: {
  containers: ManagedContainer[];
  deployments: Deployment[];
  agents: Agent[];
  activeJobs: number;
  now: number;
}) {
  const [query, setQuery] = useState("");
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());
  const [hiddenLogs, setHiddenLogs] = useState<Set<string>>(new Set());
  const sortedContainers = [...containers].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.name.localeCompare(b.name));
  const filteredContainers = sortedContainers.filter((container) =>
    matchesQuery([container.name, container.image, container.project, container.status, ...(container.ports || [])], query),
  );
  const busyContainerActions = useMemo(
    () => new Set(deployments.filter(isActiveJob).map((job) => `${job.containerId || ""}:${job.action}`)),
    [deployments],
  );
  function expandLog(containerId: string) {
    setExpandedLogs((current) => new Set(current).add(containerId));
    setHiddenLogs((current) => {
      const next = new Set(current);
      next.delete(containerId);
      return next;
    });
  }
  function closeLog(containerId: string) {
    setExpandedLogs((current) => {
      const next = new Set(current);
      next.delete(containerId);
      return next;
    });
    setHiddenLogs((current) => new Set(current).add(containerId));
  }
  return (
    <div className="table-workspace containers-workspace">
      <div className="top-toolbar">
        <label className="search-field"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search containers..." /></label>
        <div className="toolbar-actions">
          <form action={enqueueInventoryRefresh}><PendingIconButton title="Refresh containers"><Icon name="sync" /></PendingIconButton></form>
        </div>
      </div>

      <section className="panel resource-panel">
        {filteredContainers.length ? filteredContainers.map((container, index) => {
          const primaryAction = containerPrimaryAction(container.status);
          const actions: ContainerAction[] = [primaryAction, "container_logs", "container_restart", "container_delete"];
          return (
            <article className="resource-row" key={container.id}>
              {index ? <div className="resource-divider" /> : null}
              <div className="resource-identity"><ResourceGlyph /><div className="resource-copy"><strong>{container.name}</strong><span>{container.image}{container.project ? ` · ${container.project}` : ""}</span></div></div>
              <div className="resource-metadata"><StatusBadge label={container.status} running={container.status === "running"} /><small>{(container.ports || []).join(", ") || "No published ports"}</small></div>
              <div className="row-actions">{actions.map((action) => {
                const meta = containerActionMeta(action);
                return (
                  <form action={enqueueContainerAction} key={action}>
                    <input type="hidden" name="containerId" value={container.id} />
                    <input type="hidden" name="action" value={action} />
                    <PendingIconButton title={meta.title} primary={action === primaryAction} busy={busyContainerActions.has(`${container.id}:${action}`)} onClick={action === "container_logs" ? () => expandLog(container.id) : undefined}><Icon name={meta.icon} /></PendingIconButton>
                  </form>
                );
              })}</div>
              {expandedLogs.has(container.id) && !hiddenLogs.has(container.id) ? (
                <div className="logs-panel full-row">
                  <div className="logs-panel-header"><strong>{container.name}</strong><button type="button" title="Close logs" aria-label="Close logs" data-tooltip="Close logs" onClick={() => closeLog(container.id)}><Icon name="close" /></button></div>
                  <pre className="code-viewer"><code>{container.logTail || "Loading logs..."}</code></pre>
                </div>
              ) : null}
            </article>
          );
        }) : <EmptyState title={containers.length ? "No matching containers" : "No containers yet"} copy={containers.length ? "Clear the search field to show every container." : "Run or deploy a repository to see it here."} />}
      </section>
    </div>
  );
}

function RepositoriesView({ repositories, credentials, deployments, agents, activeJobs, now }: {
  repositories: Repository[];
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
  const busyRepositoryActions = useMemo(
    () => new Set(deployments.filter(isActiveJob).map((job) => `${job.repositoryId}:${job.action}`)),
    [deployments],
  );
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
          <form action={enqueueAllRepositories}><PendingIconButton title="Sync all"><Icon name="sync" /></PendingIconButton></form>
        </div>
      </div>

      {showAddRepository ? <AddRepositoryPanel credentials={credentials} /> : null}
      {showCredentials ? <CredentialsPanel credentials={credentials} /> : null}

      <section className="panel resource-panel">
        {filteredRepositories.length ? filteredRepositories.map((repository, index) => (
          <article className="resource-row repo-resource-row" key={repository.id}>
            {index ? <div className="resource-divider" /> : null}
            <div className="resource-identity"><GithubMark /><div className="resource-copy"><strong>{repository.alias}</strong><span>{repository.mode === "compose" ? "Docker Compose" : "Dockerfile"}</span></div></div>
            <div className="resource-metadata"><span title={repository.url}>{repository.url}</span><small>{repository.mode === "compose" ? repository.composeFile || defaultComposeFile : repository.dockerfile || "Dockerfile"} · Branch {repository.branch || "default"}</small></div>
            <div className="row-actions">
              <QueueButton repositoryId={repository.id} action="sync" title="Sync repository" busy={busyRepositoryActions.has(`${repository.id}:sync`)}><Icon name="sync" /></QueueButton>
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
                    <PendingIconButton title="View Compose" busy={busyRepositoryActions.has(`${repository.id}:read_compose`)} onClick={() => setViewingComposeRepositoryId(repository.id)}><Icon name="document" /></PendingIconButton>
                  </form>
                )
              ) : null}
              {repository.mode === "compose" ? <QueueButton repositoryId={repository.id} action="deploy" title="Deploy" primary busy={busyRepositoryActions.has(`${repository.id}:deploy`)}><Icon name="play" /></QueueButton> : <QueueButton repositoryId={repository.id} action="build" title="Build and run" primary busy={busyRepositoryActions.has(`${repository.id}:build`)}><Icon name="play" /></QueueButton>}
              <QueueButton repositoryId={repository.id} action="stop" title="Stop" busy={busyRepositoryActions.has(`${repository.id}:stop`)}><Icon name="stop" /></QueueButton>
              <form action={deleteRepository}><input type="hidden" name="repositoryId" value={repository.id} /><PendingIconButton title="Remove repository"><Icon name="trash" /></PendingIconButton></form>
            </div>
            <RepositorySettings repository={repository} credentials={credentials} open={editingRepositoryId === repository.id} />
            <ComposeViewer repository={repository} open={viewingComposeRepositoryId === repository.id} onClose={() => setViewingComposeRepositoryId(null)} />
          </article>
        )) : <EmptyState title={repositories.length ? "No matching repositories" : "No repositories yet"} copy={repositories.length ? "Clear the search field to show every repository." : "Register a repository to start deploying from Git."} />}
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
          <label className="environment-field">Environment variables <Icon name="help" /><textarea name="environmentJson" defaultValue={"PORT=8080\nDEBUG=true"} rows={4} spellCheck={false} /></label>
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
  if (!open) return null;
  return (
    <details className="inline-editor" open={open}>
      <summary><span>Edit settings</span><span>⌄</span></summary>
      <form action={saveRepository} className="form-grid">
        <input type="hidden" name="repositoryId" value={repository.id} />
        <label>Alias<input name="alias" defaultValue={repository.alias} required /></label>
        <label className="wide">Repository URL<input name="url" defaultValue={repository.url} required /></label>
        <label>Branch<input name="branch" defaultValue={repository.branch} list={`branches-${repository.id}`} /></label>
        <datalist id={`branches-${repository.id}`}>{repository.availableBranches?.map((branch) => <option key={branch} value={branch} />)}</datalist>
        <label>Credential<select name="credentialId" defaultValue={repository.credentialId}><option value="">Public repository</option>{credentials.map((item) => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
        <label>Mode<select name="mode" defaultValue={repository.mode}><option value="compose">Docker Compose</option><option value="dockerfile">Dockerfile</option></select></label>
        <label>Compose file<input name="composeFile" defaultValue={repository.composeFile} /></label>
        <label>Dockerfile<input name="dockerfile" defaultValue={repository.dockerfile} /></label>
        <label>Worker pool<input name="poolId" defaultValue={repository.poolId || "default"} /></label>
        <label>Domain<input name="domain" defaultValue={repository.domain} /></label>
        <label>Compose service<input name="service" defaultValue={repository.service || "web"} /></label>
        <label>Internal port<input name="internalPort" type="number" defaultValue={repository.internalPort || 3000} /></label>
        <label>Host:container ports<input name="ports" defaultValue={repository.ports || ""} /></label>
        <label className="full">Environment JSON<textarea name="environmentJson" defaultValue={JSON.stringify(repository.environment || {}, null, 2)} rows={4} /></label>
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

function WorkersPanel({ agents, now }: { agents: Agent[]; now: number }) {
  return (
    <section className="panel">
      <div className="section-title"><div><h2>Workers</h2></div></div>
      <div className="compact-list">{agents.map((agent) => {
        const online = now - agent.lastHeartbeat < 30_000;
        return <div className="compact-row" key={agent.id}><StatusBadge label={online ? "online" : "offline"} running={online} /><div><strong>{agent.hostname || agent.id}</strong><small>{agent.activeJobs || 0}/{agent.maxConcurrency || 1} jobs · {elapsed(agent.lastHeartbeat)}</small></div></div>;
      })}</div>
      {!agents.length ? <p className="empty-copy">No worker has checked in yet.</p> : null}
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
