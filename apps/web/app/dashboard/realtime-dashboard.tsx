"use client";

import { signOut } from "firebase/auth";
import { onValue, ref } from "firebase/database";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  cancelDeployment,
  deleteCredential,
  deleteRepository,
  enqueueAllRepositories,
  enqueueContainerAction,
  enqueueDeployment,
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
type ContainerAction = "container_restart" | "container_delete" | "container_logs";

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

function StatusBadge({ label, running }: { label: string; running: boolean }) {
  return <span className={`ui-status-badge ${running ? "is-running" : "is-stopped"}`}><span className="ui-status-badge__dot" aria-hidden="true" />{label}</span>;
}

function IconButton({ title, children, onClick, primary = false }: { title: string; children: React.ReactNode; onClick?: () => void; primary?: boolean }) {
  return <button className={`icon-button ${primary ? "primary-icon" : ""}`} title={title} aria-label={title} onClick={onClick}>{children}</button>;
}

function QueueButton({ repositoryId, action, children, title, primary = false }: {
  repositoryId: string;
  action: RepositoryAction;
  children: React.ReactNode;
  title: string;
  primary?: boolean;
}) {
  return (
    <form action={enqueueDeployment}>
      <input type="hidden" name="repositoryId" value={repositoryId} />
      <input type="hidden" name="action" value={action} />
      <IconButton title={title} primary={primary}>{children}</IconButton>
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
          <button className={view === "containers" ? "is-active" : ""} onClick={() => setView("containers")}><span />Containers</button>
          <button className={view === "repositories" ? "is-active" : ""} onClick={() => setView("repositories")}><span />Repositories</button>
        </nav>

        <div className="sidebar-footer">
          <div className="session-user"><span aria-hidden="true" /><div><small>Signed in</small><strong>{props.user.email || props.user.role}</strong></div></div>
          <IconButton title="Sign out" onClick={logout}>⎋</IconButton>
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
  const sortedContainers = [...containers].sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || a.name.localeCompare(b.name));
  const filteredContainers = sortedContainers.filter((container) =>
    matchesQuery([container.name, container.image, container.project, container.status, ...(container.ports || [])], query),
  );
  return (
    <>
      <header className="workspace-header">
        <div><p className="eyebrow">Workspace</p><h1>Containers</h1></div>
      </header>

      <section className="metrics">
        <article><strong>{containers.length}</strong><span>Containers</span></article>
        <article><strong>{containers.filter((item) => item.status === "running").length}</strong><span>Running</span></article>
        <article><strong>{activeJobs}</strong><span>Active jobs</span></article>
      </section>

      <div className="content-grid">
        <section className="panel resource-panel">
          <div className="resource-toolbar">
            <label className="search-field"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search containers" /></label>
          </div>
          {filteredContainers.length ? filteredContainers.map((container, index) => (
            <article className="resource-row" key={container.id}>
              {index ? <div className="resource-divider" /> : null}
              <div className="resource-identity"><ResourceGlyph /><div className="resource-copy"><strong>{container.name}</strong><span>{container.image}{container.project ? ` · ${container.project}` : ""}</span></div></div>
              <div className="resource-metadata"><StatusBadge label={container.status} running={container.status === "running"} /><small>{(container.ports || []).join(", ") || "No published ports"}</small></div>
              <div className="row-actions">{(["container_logs", "container_restart", "container_delete"] as ContainerAction[]).map((action) => (
                <form action={enqueueContainerAction} key={action}>
                  <input type="hidden" name="containerId" value={container.id} />
                  <input type="hidden" name="action" value={action} />
                  <IconButton title={action}>{action === "container_logs" ? "⌘" : action === "container_restart" ? "↻" : "×"}</IconButton>
                </form>
              ))}</div>
              {container.logTail ? <pre className="code-viewer full-row"><code>{container.logTail}</code></pre> : null}
            </article>
          )) : <EmptyState title={containers.length ? "No matching containers" : "No containers yet"} copy={containers.length ? "Clear the search field to show every container." : "Run or deploy a repository to see it here."} />}
        </section>

        <aside className="side-stack">
          <WorkersPanel agents={agents} now={now} />
          <DeploymentsPanel deployments={deployments} />
        </aside>
      </div>
    </>
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
  const [showAddRepository, setShowAddRepository] = useState(false);
  const [showCredentials, setShowCredentials] = useState(false);
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
    <div className="table-workspace">
      <div className="top-toolbar">
        <label className="search-field"><span>Search</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search repositories..." /></label>
        <div className="toolbar-actions">
          <IconButton title={showAddRepository ? "Close repository form" : "Add repository"} onClick={() => setShowAddRepository((current) => !current)}>+</IconButton>
          <IconButton title={showCredentials ? "Close credentials" : "Add credential"} onClick={() => setShowCredentials((current) => !current)}>⌘</IconButton>
          <form action={enqueueAllRepositories}><IconButton title="Sync all">↻</IconButton></form>
        </div>
      </div>

      {showAddRepository ? <AddRepositoryPanel credentials={credentials} onClose={() => setShowAddRepository(false)} /> : null}
      {showCredentials ? <CredentialsPanel credentials={credentials} /> : null}

      <section className="panel resource-panel">
        {filteredRepositories.length ? filteredRepositories.map((repository, index) => (
          <article className="resource-row repo-resource-row" key={repository.id}>
            {index ? <div className="resource-divider" /> : null}
            <div className="resource-identity"><GithubMark /><div className="resource-copy"><strong>{repository.alias}</strong><span>{repository.mode === "compose" ? "Docker Compose" : "Dockerfile"}</span></div></div>
            <div className="resource-metadata"><span title={repository.url}>{repository.url}</span><small>{repository.composeFile || repository.dockerfile} · Branch {repository.branch || "default"}</small></div>
            <div className="row-actions">
              <QueueButton repositoryId={repository.id} action="sync" title="Sync repository">↻</QueueButton>
              <IconButton
                title={editingRepositoryId === repository.id ? "Close settings" : "Edit repository"}
                onClick={() => setEditingRepositoryId((current) => current === repository.id ? null : repository.id)}
              >
                ⎇
              </IconButton>
              {repository.mode === "compose" ? <QueueButton repositoryId={repository.id} action="read_compose" title="View Compose">▤</QueueButton> : null}
              {repository.mode === "compose" ? <QueueButton repositoryId={repository.id} action="deploy" title="Deploy" primary>▶</QueueButton> : <QueueButton repositoryId={repository.id} action="build" title="Build and run" primary>▶</QueueButton>}
              <QueueButton repositoryId={repository.id} action="stop" title="Stop">□</QueueButton>
              <form action={deleteRepository}><input type="hidden" name="repositoryId" value={repository.id} /><IconButton title="Remove repository">⌫</IconButton></form>
            </div>
            <RepositorySettings repository={repository} credentials={credentials} open={editingRepositoryId === repository.id} />
          </article>
        )) : <EmptyState title={repositories.length ? "No matching repositories" : "No repositories yet"} copy={repositories.length ? "Clear the search field to show every repository." : "Register a repository to start deploying from Git."} />}
      </section>
    </div>
  );
}

function AddRepositoryPanel({ credentials, onClose }: { credentials: CredentialSummary[]; onClose: () => void }) {
  return (
    <section className="panel editor-panel">
      <div className="editor-panel-header">
        <h2>Register repository</h2>
        <IconButton title="Close repository form" onClick={onClose}>×</IconButton>
      </div>
      <form action={saveRepository} className="form-grid">
        <label>Alias<input name="alias" required placeholder="api-production" /></label>
        <label className="wide">Repository URL<input name="url" required placeholder="https://github.com/org/repository.git" /></label>
        <label>Branch<input name="branch" defaultValue="main" /></label>
        <label>Credential<select name="credentialId" defaultValue=""><option value="">Public repository</option>{credentials.map((item) => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
        <label>Mode<select name="mode"><option value="compose">Docker Compose</option><option value="dockerfile">Dockerfile</option></select></label>
        <label>Compose file<input name="composeFile" defaultValue="docker-compose.yml" /></label>
        <label>Dockerfile<input name="dockerfile" defaultValue="Dockerfile" /></label>
        <label>Worker pool<input name="poolId" defaultValue="default" /></label>
        <label>Domain<input name="domain" placeholder="api.example.com" /></label>
        <label>Compose service<input name="service" defaultValue="web" /></label>
        <label>Internal port<input name="internalPort" type="number" defaultValue="3000" /></label>
        <label>Host:container ports<input name="ports" placeholder="8080:80" /></label>
        <label className="full">Environment JSON<textarea name="environmentJson" defaultValue="{}" rows={4} spellCheck={false} /></label>
        <div className="full form-actions"><button className="primary">Clone and register</button></div>
      </form>
    </section>
  );
}

function RepositorySettings({ repository, credentials, open }: { repository: Repository; credentials: CredentialSummary[]; open: boolean }) {
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
        <div className="full form-actions"><button className="primary">Save settings</button><button className="secondary" formAction={deleteRepository}>Remove registration</button></div>
      </form>
      {repository.composeContent ? <pre className="code-viewer"><code>{repository.composeContent}</code></pre> : null}
    </details>
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
            +
          </IconButton>
          <IconButton title={showImportForm ? "Close JSON import" : "Import JSON"} onClick={() => setShowImportForm((current) => !current)}>
            ▤
          </IconButton>
        </div>
      </div>
      {showCredentialForm ? (
        <form action={saveCredential} className="form-grid one-column compact-form">
          <label>Alias<input name="alias" required /></label>
          <label>Username<input name="username" /></label>
          <label>Personal access token<input name="token" type="password" required /></label>
          <a className="help-link" href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer">Generate a GitHub token</a>
          <div className="form-actions"><button className="primary">Save credential</button></div>
        </form>
      ) : null}
      {showImportForm ? (
        <form action={saveCredentialsJson} className="form-grid one-column">
          <label>Credential JSON<textarea name="credentialsJson" rows={5} defaultValue={'{\n  "github": {\n    "username": "",\n    "token": ""\n  }\n}'} /></label>
          <div className="form-actions"><button className="secondary">Import credentials</button></div>
        </form>
      ) : null}
      <div className="compact-list">{credentials.map((credential) => (
        <div className="compact-row" key={credential.id}><div><strong>{credential.alias}</strong><small>{credential.username || "GitHub"} · {credential.tokenMask}</small></div><form action={deleteCredential}><input type="hidden" name="credentialId" value={credential.id} /><IconButton title="Delete credential">×</IconButton></form></div>
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
          {["queued", "leased", "running"].includes(job.status) ? <form action={cancelDeployment}><input type="hidden" name="jobId" value={job.id} /><IconButton title="Cancel">×</IconButton></form> : null}
        </article>
      ))}</div>
      {!deployments.length ? <p className="empty-copy">No deployment activity yet.</p> : null}
    </section>
  );
}
