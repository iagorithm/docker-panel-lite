const capabilities = [
  ["Workers", "Claim Python or Go workers, monitor heartbeats, assign pools and execute jobs on remote Docker hosts."],
  ["Projects", "Register or clone Git repositories, select branches and store project-specific runtime configuration."],
  ["Build", "Deploy a Docker Compose stack or build and run one Dockerfile-managed container."],
  ["Operations", "Inspect deployments, restart containers, run saved commands, review logs and refresh inventory."],
  ["Public access", "Create ngrok URLs per project or Compose service and close tunnels on the worker that opened them."],
  ["Collaboration", "Keep resources private, share them with selected users or publish them to the workspace."],
];

export default function DocsOverviewPage() {
  return <main className="docs-article">
    <header className="docs-article-header"><p className="docs-breadcrumb">Documentation / Overview</p><h1>Docker Panel Lite documentation</h1><p>Reference for connecting Docker hosts, registering source repositories, deploying Compose stacks or Dockerfiles, and operating containers.</p></header>
    <div className="docs-on-this-page"><strong>On this page</strong><a href="#architecture">Architecture</a><a href="#workers">Workers</a><a href="#projects">Projects</a><a href="#deployments">Deployments</a><a href="#security">Security</a></div>

    <section><h2>Platform overview</h2><p>Docker Panel Lite separates orchestration from execution. The public web application manages identities, settings and job state. Workers connect from Docker hosts and perform operations that touch Git, Docker or ngrok.</p><div className="docs-capability-grid">{capabilities.map(([title, copy]) => <article key={title}><h3>{title}</h3><p>{copy}</p></article>)}</div></section>

    <section id="architecture"><h2>Architecture</h2><p>The panel writes jobs to Firebase. An eligible worker leases a job, performs it and publishes status, output and resource updates in realtime.</p><figure className="docs-figure"><img src="/platform-architecture.svg" alt="Docker Panel Lite architecture" /><figcaption>Control-plane data remains separate from Docker execution on worker hosts.</figcaption></figure><div className="docs-three-column"><div><h3>Control plane</h3><p>Next.js and Firebase manage users, policies, encrypted secret references, queues and UI state.</p></div><div><h3>Worker plane</h3><p>Workers clone repositories, build images, invoke Compose, manage containers and run ngrok.</p></div><div><h3>Job lifecycle</h3><p>Jobs move through queued, leased, running, completed or failed states.</p></div></div></section>

    <section id="workers"><h2>Workers</h2><p>A worker is a trusted process on a Docker host. Persistent mounts preserve its identity, repositories and state.</p><figure className="docs-figure is-narrow"><img src="/docker-hub-worker.svg" alt="Docker worker image capabilities" /><figcaption>The worker contains Git, Docker, queue and public-tunnel tooling.</figcaption></figure><h3>Minimal launch</h3><pre><code>{`mkdir -p "$HOME/docker-panel-worker/repos" "$HOME/docker-panel-worker/data"

docker run -d --pull always \\
  --name docker-panel-lite-worker \\
  --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "$HOME/docker-panel-worker/repos:/app/clones" \\
  -v "$HOME/docker-panel-worker/data:/app/data" \\
  cjarn/docker-panel-lite-worker:py`}</code></pre><p>Read the claim token with <code>docker logs --tail 100 docker-panel-lite-worker</code>, then claim it in Workers.</p></section>

    <section id="credentials"><h2>Credentials</h2><p>Credentials provide access to private Git repositories. Tokens are encrypted before storage and resolved only by authorized workers.</p><ul><li>Use an alias instead of embedding a token in a Git URL.</li><li>Select Private, Shared or Public visibility deliberately.</li><li>Rotate credentials when provider tokens expire or are revoked.</li></ul></section>

    <section id="projects"><h2>Projects</h2><p>A project connects Git source, build mode, environment and a default worker. Project Settings is divided into focused tabs.</p><table><thead><tr><th>Tab</th><th>Purpose</th></tr></thead><tbody><tr><td>Git</td><td>Alias, description, repository URL, branch and credential.</td></tr><tr><td>Build</td><td>Compose or Dockerfile mode, file paths, services and ports.</td></tr><tr><td>Environment</td><td>KEY=VALUE or JSON variables and default worker.</td></tr><tr><td>Domain</td><td>ngrok token, public URL toggle and domains.</td></tr><tr><td>Access</td><td>Private, selected users or workspace-public visibility.</td></tr></tbody></table></section>

    <section id="build"><h2>Build modes</h2><div className="docs-two-column"><article><h3>Docker Compose</h3><p>Runs the configured Compose file. Compose owns services, networks, volumes and ports.</p><code>docker compose -p PROJECT -f FILE up -d --build</code></article><article><h3>Dockerfile</h3><p>Builds the selected Dockerfile and manages one project container with explicit port mappings.</p><code>docker build -f Dockerfile -t IMAGE .</code></article></div></section>

    <section id="environment"><h2>Environment and worker selection</h2><p>Edit variables as dotenv text or JSON and select the worker that should receive sync, deploy and runtime jobs.</p><div className="docs-callout"><strong>Dedicated secrets</strong><p>Git credentials and ngrok authtokens use encrypted secret storage; they are not ordinary environment variables.</p></div></section>

    <section id="domains"><h2>Domains and ngrok</h2><p>The worker starts ngrok. A project token overrides the worker token, and Compose may expose multiple services.</p><ul><li>Enable Public ngrok URL to create tunnels.</li><li>Use Ngrok domain only for a hostname available to that account and plan.</li><li>Close Public URL routes the stop job to the worker that created the tunnel.</li><li>Inspect local sessions with <code>./scripts/ngrok-sessions.sh --all</code>.</li></ul></section>

    <section id="deployments"><h2>Deployments</h2><p>The Deployments view shows worker-reported Docker inventory. Public URL and Restart are primary controls; More contains Start, commands, logs, Stop and Delete.</p><a className="docs-next-link" href="/docs/deploy"><span>Step-by-step guide</span><strong>Complete deployment →</strong></a></section>

    <section id="operations"><h2>Logs and commands</h2><p>Deployment events explain job progress. Container logs show runtime output. Command presets execute repeatable commands inside eligible running containers.</p><div className="docs-callout is-warning"><strong>Commands use container permissions</strong><p>Restrict command execution to trusted operators and review presets before saving them.</p></div></section>

    <section id="security"><h2>Access and security</h2><ul><li>The Docker socket grants host-level container control; workers belong only on trusted infrastructure.</li><li>Keep Firebase credentials and encryption keys outside repositories.</li><li>Grant the narrowest visibility appropriate for each resource.</li><li>Review Dockerfiles and Compose files before executing untrusted code.</li></ul></section>

    <section id="troubleshooting"><h2>Troubleshooting</h2><table><thead><tr><th>Symptom</th><th>Check</th></tr></thead><tbody><tr><td>Worker offline</td><td>Container logs, persistent identity and Firebase configuration.</td></tr><tr><td>Clone fails</td><td>Repository URL, branch and credential visibility.</td></tr><tr><td>Compose does not load</td><td>Relative path, worker availability and deployment error.</td></tr><tr><td>ERR_NGROK_108</td><td>Concurrent agents; close unused URLs and inspect ngrok Agents.</td></tr><tr><td>URL cannot reach app</td><td>Container, internal port, Docker network and ERR_NGROK_8012.</td></tr></tbody></table></section>
  </main>;
}
