"use client";

import { onValue, ref } from "firebase/database";
import { signOut } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { cancelDeployment, deleteCredential, deleteRepository, enqueueAllRepositories, enqueueContainerAction, enqueueDeployment, saveCredential, saveCredentialsJson, saveRepository } from "@/app/actions";
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

function useCollection<T>(path: string, initial: T[]) {
  const [items, setItems] = useState(initial);
  useEffect(() => onValue(ref(realtimeDatabase, path), (snapshot) => {
    setItems(Object.values(snapshot.val() ?? {}) as T[]);
  }), [path]);
  return items;
}

function elapsed(timestamp?: number) {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function QueueButton({ repositoryId, action, children }: {
  repositoryId: string;
  action: "sync" | "deploy" | "stop" | "build" | "discover_branches" | "read_compose";
  children: React.ReactNode;
}) {
  return <form action={enqueueDeployment}><input type="hidden" name="repositoryId" value={repositoryId} /><input type="hidden" name="action" value={action} /><button className="icon-button" title={action}>{children}</button></form>;
}

export function RealtimeDashboard(props: Props) {
  const router = useRouter();
  const base = `workspaces/${props.workspaceId}`;
  const repositories = useCollection<Repository>(`${base}/repositories`, props.initialRepositories);
  const deployments = useCollection<Deployment>(`${base}/deployments`, props.initialDeployments);
  const agents = useCollection<Agent>(`${base}/agents`, props.initialAgents);
  const credentials = useCollection<CredentialSummary>(`${base}/credentials`, props.initialCredentials);
  const containers = useCollection<ManagedContainer>(`${base}/containers`, props.initialContainers);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);

  const onlineAgents = useMemo(() => agents.filter((agent) => agent.status !== "offline" && now - agent.lastHeartbeat < 30_000), [agents, now]);
  const active = deployments.filter((item) => ["queued", "leased", "running"].includes(item.status));

  async function logout() {
    await Promise.allSettled([signOut(firebaseAuth), fetch("/api/session", { method: "DELETE" })]);
    router.replace("/login");
    router.refresh();
  }

  return <main className="shell">
    <header className="topbar">
      <div><p className="eyebrow">Realtime control plane</p><h1>Deployments</h1></div>
      <div className="topbar-actions"><span className="live-dot" />{onlineAgents.length} workers online <span className="user-chip">{props.user.email || props.user.role}</span><button className="secondary small" onClick={logout}>Sign out</button></div>
    </header>

    <section className="metrics">
      <article><strong>{repositories.length}</strong><span>Repositories</span></article>
      <article><strong>{active.length}</strong><span>Active jobs</span></article>
      <article><strong>{onlineAgents.reduce((total, agent) => total + agent.maxConcurrency, 0)}</strong><span>Worker capacity</span></article>
    </section>

    <section className="workspace-grid">
      <div className="stack">
        <details className="panel compact-editor">
          <summary><span><b>Add repository</b><small>Git, deployment, and domain settings</small></span><span>＋</span></summary>
          <form action={saveRepository} className="form-grid">
            <label>Alias<input name="alias" required placeholder="api-production" /></label>
            <label className="wide">Repository URL<input name="url" required placeholder="https://github.com/org/repository.git" /></label>
            <label>Branch<input name="branch" defaultValue="main" list="branch-options" /></label>
            <label>Credential<select name="credentialId" defaultValue=""><option value="">Public repository</option>{credentials.map((item) => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
            <label>Mode<select name="mode"><option value="compose">Docker Compose</option><option value="dockerfile">Dockerfile</option></select></label>
            <label>Compose file<input name="composeFile" defaultValue="docker-compose.yml" /></label>
            <label>Dockerfile<input name="dockerfile" defaultValue="Dockerfile" /></label>
            <label>Worker pool<input name="poolId" defaultValue="default" /></label>
            <label>Domain<input name="domain" placeholder="api.example.com" /></label>
            <label>Compose service<input name="service" defaultValue="web" /></label>
            <label>Internal port<input name="internalPort" type="number" defaultValue="3000" /></label>
            <label>Host:container ports<input name="ports" placeholder="8080:80, 8443:443" /></label>
            <label className="full">Environment JSON<textarea name="environmentJson" defaultValue="{}" rows={4} spellCheck={false} /></label>
            <div className="full form-actions"><button className="primary small">Save repository</button></div>
          </form>
        </details>

        <section className="panel"><div className="section-title"><div><h2>Repositories</h2><p>Realtime state and deployment controls</p></div><form action={enqueueAllRepositories}><button className="secondary small">Sync all</button></form></div>
          <div className="repository-list">{repositories.length ? repositories.map((repository) => <article className="repo-row" key={repository.id}>
            <div className="repo-mark">GH</div><div className="repo-main"><strong>{repository.alias}</strong><a href={repository.url} target="_blank" rel="noreferrer">{repository.url}</a><small>{repository.branch || "default branch"} · {repository.mode} · {repository.poolId || "default"}{repository.domain ? ` · ${repository.domain}` : ""}</small></div>
            <div className="row-actions"><QueueButton repositoryId={repository.id} action="discover_branches">⑂</QueueButton><QueueButton repositoryId={repository.id} action="sync">↻</QueueButton>{repository.mode === "compose" ? <><QueueButton repositoryId={repository.id} action="read_compose">▤</QueueButton><QueueButton repositoryId={repository.id} action="deploy">▶</QueueButton></> : <QueueButton repositoryId={repository.id} action="build">◇</QueueButton>}<QueueButton repositoryId={repository.id} action="stop">■</QueueButton></div>
            <details className="repo-settings"><summary><span><b>Edit repository settings</b><small>Branch, credential, environment, and deployment files</small></span><span>⌄</span></summary><form action={saveRepository} className="form-grid"><input type="hidden" name="repositoryId" value={repository.id} /><label>Alias<input name="alias" defaultValue={repository.alias} required /></label><label className="wide">Repository URL<input name="url" defaultValue={repository.url} required /></label><label>Branch<input name="branch" defaultValue={repository.branch} list={`branches-${repository.id}`} /></label><datalist id={`branches-${repository.id}`}>{repository.availableBranches?.map((branch) => <option key={branch} value={branch} />)}</datalist><label>Credential<select name="credentialId" defaultValue={repository.credentialId}><option value="">Public repository</option>{credentials.map((item) => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label><label>Mode<select name="mode" defaultValue={repository.mode}><option value="compose">Docker Compose</option><option value="dockerfile">Dockerfile</option></select></label><label>Compose file<input name="composeFile" defaultValue={repository.composeFile} /></label><label>Dockerfile<input name="dockerfile" defaultValue={repository.dockerfile} /></label><label>Worker pool<input name="poolId" defaultValue={repository.poolId || "default"} /></label><label>Domain<input name="domain" defaultValue={repository.domain} /></label><label>Compose service<input name="service" defaultValue={repository.service || "web"} /></label><label>Internal port<input name="internalPort" type="number" defaultValue={repository.internalPort || 3000} /></label><label>Host:container ports<input name="ports" defaultValue={repository.ports || ""} /></label><label className="full">Environment JSON<textarea name="environmentJson" defaultValue={JSON.stringify(repository.environment || {}, null, 2)} rows={4} /></label><div className="full form-actions"><button className="primary small">Save settings</button><button className="secondary small" formAction={deleteRepository}>Remove registration</button></div></form>{repository.composeContent ? <pre className="code-viewer"><code>{repository.composeContent}</code></pre> : null}</details>
          </article>) : <p className="empty">Add the first repository to start deploying.</p>}</div>
        </section>

        <section className="panel"><div className="section-title"><div><h2>Containers</h2><p>Inventory reported by the worker</p></div></div><div className="job-list">{containers.map((container) => <article className="container-row" key={container.id}><span className={`status ${container.status === "running" ? "running" : ""}`}>{container.status}</span><div><strong>{container.name}</strong><small>{container.image}{container.project ? ` · ${container.project}` : ""}</small><small>{(container.ports || []).join(", ")}</small></div><div className="row-actions">{(["container_logs", "container_restart", "container_delete"] as const).map((action) => <form action={enqueueContainerAction} key={action}><input type="hidden" name="containerId" value={container.id} /><input type="hidden" name="action" value={action} /><button className="icon-button" title={action}>{action === "container_logs" ? "⌘" : action === "container_restart" ? "↻" : "×"}</button></form>)}</div>{container.logTail ? <pre className="code-viewer full-row"><code>{container.logTail}</code></pre> : null}</article>)}</div></section>

        <section className="panel"><div className="section-title"><div><h2>Deployment activity</h2><p>Updates stream directly from Firebase</p></div></div>
          <div className="job-list">{[...deployments].sort((a, b) => b.createdAt - a.createdAt).slice(0, 30).map((job) => <article className="job-row" key={job.id}>
            <span className={`status ${job.status}`}>{job.status}</span><div><strong>{job.repositoryId} · {job.action}</strong><small>{job.message || `Queued ${elapsed(job.createdAt)}`}</small></div><progress value={job.progress || 0} max="100" />
            {["queued", "leased", "running"].includes(job.status) ? <form action={cancelDeployment}><input type="hidden" name="jobId" value={job.id} /><button className="icon-button" title="Cancel">×</button></form> : null}
          </article>)}</div>
        </section>
      </div>

      <aside className="stack">
        <details className="panel compact-editor"><summary><span><b>GitHub credentials</b><small>Encrypted before storage</small></span><span>＋</span></summary><form action={saveCredential} className="form-grid one-column"><label>Alias<input name="alias" required /></label><label>Username<input name="username" /></label><label>Personal access token<input name="token" type="password" required /></label><a className="help-link" href="https://github.com/settings/tokens/new" target="_blank" rel="noreferrer">Generate a GitHub token ↗</a><div className="form-actions"><button className="primary small">Save credential</button></div></form><details className="json-import"><summary><span><b>Import JSON</b><small>{'{"alias":{"username":"…","token":"…"}}'}</small></span><span>⌄</span></summary><form action={saveCredentialsJson} className="form-grid one-column"><label>Credential JSON<textarea name="credentialsJson" rows={5} defaultValue={'{\n  "github": {\n    "username": "",\n    "token": ""\n  }\n}'} /></label><div className="form-actions"><button className="secondary small">Import credentials</button></div></form></details><div className="credential-list">{credentials.map((credential) => <div className="agent-row" key={credential.id}><div><strong>{credential.alias}</strong><small>{credential.username || "GitHub"} · {credential.tokenMask}</small></div><form action={deleteCredential}><input type="hidden" name="credentialId" value={credential.id} /><button className="icon-button">×</button></form></div>)}</div></details>
        <section className="panel"><div className="section-title"><div><h2>Workers</h2><p>Heartbeat and capacity</p></div></div>{agents.map((agent) => { const online = now - agent.lastHeartbeat < 30_000; return <article className="agent-row" key={agent.id}><span className={online ? "live-dot" : "offline-dot"} /><div><strong>{agent.hostname || agent.id}</strong><small>{agent.activeJobs || 0}/{agent.maxConcurrency || 1} jobs · {elapsed(agent.lastHeartbeat)}</small></div></article>; })}{!agents.length ? <p className="empty">No worker has checked in yet.</p> : null}</section>
      </aside>
    </section>
  </main>;
}
