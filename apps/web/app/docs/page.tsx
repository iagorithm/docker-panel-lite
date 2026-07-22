const deploymentContents = [
  ["Identity", "Project alias and description used to recognize the application."],
  ["Git source", "Repository URL, branch and credential when the repository is private."],
  ["Build", "Docker Compose or Dockerfile mode, file paths, service and port configuration."],
  ["Environment", "The variables the application needs while it is running."],
  ["Worker", "The Docker host selected to build and run the application."],
  ["Runtime", "Containers, images, current status and exposed ports."],
  ["Access", "Visibility, permitted users, local addresses and optional public URLs."],
  ["History", "Deployment results and errors that help verify or troubleshoot a release."],
];

type OperationIcon = "sync" | "settings" | "play" | "more" | "document" | "bug" | "link" | "close" | "stop" | "terminal" | "logs" | "trash";

function OperationIconGraphic({ name }: { name: OperationIcon }) {
  const common = { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: 2.05 };
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {name === "sync" ? <path {...common} d="M17.6 6.2A7.25 7.25 0 0 0 5.35 9.05M17.6 6.2V3.45m0 2.75h-2.75M6.4 17.8a7.25 7.25 0 0 0 12.25-2.85M6.4 17.8v2.75m0-2.75h2.75" /> : null}
    {name === "settings" ? <path {...common} d="M12 8.35A3.65 3.65 0 1 0 12 15.65 3.65 3.65 0 0 0 12 8.35Zm7.05 3.65c0-.45-.04-.89-.12-1.31l2.02-1.58-2-3.46-2.52 1.01a7.5 7.5 0 0 0-2.27-1.31L13.78 2.7h-4l-.38 2.65a7.5 7.5 0 0 0-2.27 1.31L4.61 5.65l-2 3.46 2.02 1.58a7.08 7.08 0 0 0 0 2.62l-2.02 1.58 2 3.46 2.52-1.01A7.5 7.5 0 0 0 9.4 18.65l.38 2.65h4l.38-2.65a7.5 7.5 0 0 0 2.27-1.31l2.52 1.01 2-3.46-2.02-1.58c.08-.42.12-.86.12-1.31Z" /> : null}
    {name === "play" ? <path d="M8.75 6.45v11.1a1 1 0 0 0 1.55.84l8.15-5.55a1 1 0 0 0 0-1.68L10.3 5.61a1 1 0 0 0-1.55.84Z" fill="currentColor" /> : null}
    {name === "more" ? <path d="M6.25 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm5.75 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm5.75 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z" fill="currentColor" /> : null}
    {name === "document" ? <path {...common} d="M7 3.75h6.2l3.8 3.8V20a1.25 1.25 0 0 1-1.25 1.25H7A1.25 1.25 0 0 1 5.75 20V5A1.25 1.25 0 0 1 7 3.75Zm6 0v4h4M8.9 12.15h6.2M8.9 16.1h6.2" /> : null}
    {name === "bug" ? <path {...common} d="M9 5.25V3.5M15 5.25V3.5M5.25 9H3.5M20.5 9h-1.75M5.25 15H3.5m17 0h-1.75M8 6.25h8v9.5a4 4 0 0 1-8 0v-9.5ZM8 10h8M12 10v9.75" /> : null}
    {name === "link" ? <path {...common} d="M9.45 14.55 14.55 9.45M10.75 6.75l1.55-1.55a4 4 0 0 1 5.65 5.65L16.4 12.4M7.6 11.6l-1.55 1.55a4 4 0 0 0 5.65 5.65l1.55-1.55" /> : null}
    {name === "close" ? <path {...common} d="M6.75 6.75l10.5 10.5M17.25 6.75 6.75 17.25" /> : null}
    {name === "stop" ? <rect x="7.75" y="7.75" width="8.5" height="8.5" rx="1.45" fill="currentColor" /> : null}
    {name === "terminal" ? <path {...common} d="M4.5 6.25h15v11.5h-15zM8.2 10l2.15 2-2.15 2M12.35 14h4.2" /> : null}
    {name === "logs" ? <path {...common} d="M6.5 4.75h11A1.25 1.25 0 0 1 18.75 6v12A1.25 1.25 0 0 1 17.5 19.25h-11A1.25 1.25 0 0 1 5.25 18V6A1.25 1.25 0 0 1 6.5 4.75ZM8.5 8.15h7M8.5 11.05h7M8.5 13.95h5.6M8.5 16.85h3.8" /> : null}
    {name === "trash" ? <path {...common} d="M4.75 7h14.5M9.75 11v5.75M14.25 11v5.75M8 7l1.1-3h5.8L16 7M6.75 7l.9 13.25h8.7L17.25 7" /> : null}
  </svg>;
}

const projectOperations: [OperationIcon, string, string, string][] = [
  ["sync", "Refresh", "Primary", "Pulls the latest source and refreshes project information from the selected worker."],
  ["settings", "Settings", "Primary", "Opens Git, Build, Environment, Domain and Access configuration."],
  ["play", "Deploy", "Primary", "Builds and starts the project using its selected Compose or Dockerfile mode."],
  ["more", "More", "Primary", "Opens the compact menu that contains the less frequent project operations."],
  ["document", "View Compose / Dockerfile", "More", "Reads and displays the build file detected on the selected worker."],
  ["bug", "Deployment events", "More", "Shows progress, results and errors from project operations."],
  ["link", "Open / refresh public URLs", "More", "Creates or regenerates the configured ngrok URLs."],
  ["close", "Close public URLs", "More", "Stops the public tunnels created for the project."],
  ["stop", "Stop project", "More", "Stops the Compose stack or Dockerfile-managed service without deleting the project."],
];

const deploymentOperations: [OperationIcon, string, string, string][] = [
  ["link", "Public URL", "Primary", "Creates or regenerates public access for a running service."],
  ["sync", "Restart", "Primary", "Restarts the running container without rebuilding the project source."],
  ["more", "More", "Primary", "Opens the compact menu with state-dependent container operations."],
  ["play", "Start", "More", "Starts a stopped container."],
  ["terminal", "Run command", "More", "Runs the selected saved command inside an eligible running container."],
  ["logs", "View logs", "More", "Opens the runtime output for the selected container."],
  ["stop", "Stop", "More", "Stops a running container while preserving it."],
  ["trash", "Delete", "More", "Removes the managed container; use it only when the runtime is no longer needed."],
];

function OperationReference({ operations }: { operations: [OperationIcon, string, string, string][] }) {
  return <div className="docs-operation-grid">{operations.map(([icon, label, placement, copy]) => <article key={label}><span className="docs-operation-icon"><OperationIconGraphic name={icon} /></span><div><h4>{label}<small>{placement}</small></h4><p>{copy}</p></div></article>)}</div>;
}

export default function DocsOverviewPage() {
  return <main className="docs-article">
    <header className="docs-article-header"><p className="docs-breadcrumb">Documentation / Overview</p><h1>Docker Panel Lite documentation</h1><p>Learn how to connect a Docker host and take an application from a Git repository to a running deployment.</p></header>
    <div className="docs-on-this-page"><strong>On this page</strong><a href="#architecture">Architecture</a><a href="#problems">Problems it solves</a><a href="#workers">Workers</a><a href="#deployments">Deployments</a><a href="#public-urls">Public URLs</a></div>

    <section><h2>Two concepts to get started</h2><div className="docs-two-column"><article><h3>Worker</h3><p>A worker connects a Docker host to the application and performs the operations you request.</p><a href="#workers">Learn about workers →</a></article><article><h3>Deployment</h3><p>A deployment is the complete configuration and running result of one project on a selected worker.</p><a href="#deployments">Learn about deployments →</a></article></div></section>

    <section id="architecture"><h2>Architecture</h2><p>Docker Panel Lite separates the place where a developer configures an application from the Docker host where it runs. The panel provides one interface for projects, workers and deployments; each worker connects an authorized Docker host and executes the requested deployment there.</p><figure className="docs-figure"><img src="/platform-architecture.svg" alt="Docker Panel Lite architecture connecting developers and Git projects to Docker workers and live services" /><figcaption>Public architecture of Docker Panel Lite: configuration enters through the panel, execution happens on worker hosts, and the result is a running deployment.</figcaption></figure><div className="docs-architecture-flow" aria-label="Architecture explanation"><article><span>1</span><h3>Inputs</h3><p>Developers add a Git repository, choose a branch and define Build, Environment and access settings.</p></article><i aria-hidden="true">→</i><article><span>2</span><h3>Control panel</h3><p>The panel organizes projects, selects the destination worker and exposes deployment operations in one interface.</p></article><i aria-hidden="true">→</i><article><span>3</span><h3>Worker hosts</h3><p>The selected worker builds and runs the application with Docker on its connected machine.</p></article><i aria-hidden="true">→</i><article><span>4</span><h3>Results</h3><p>Containers, status, logs, ports and optional public URLs appear as the deployment result.</p></article></div><div className="docs-callout"><strong>Why the separation matters</strong><p>The panel can manage multiple Docker hosts without moving their runtime into the web application. The worker stays close to Docker, and every project explicitly selects where it should run.</p></div></section>

    <section id="problems"><h2>Problems it solves</h2><div className="docs-problem-list"><article><h3>Different Docker hosts</h3><p>Connect multiple machines as named workers and choose where each project should run without changing the project workflow.</p></article><article><h3>Repeated manual deployments</h3><p>Keep the repository, branch, build mode, variables and worker together so a deployment can be repeated consistently.</p></article><article><h3>Compose and Dockerfile differences</h3><p>Use a clear build selector and display only the settings relevant to the chosen mode.</p></article><article><h3>Scattered runtime operations</h3><p>Deploy, restart, inspect logs, execute configured commands, stop and remove applications from one deployments view.</p></article><article><h3>Temporary public access</h3><p>Expose the intended service through ngrok, see its URL beside the deployment and close the tunnel when it is no longer needed.</p></article><article><h3>Unclear deployment failures</h3><p>Show deployment results and actionable worker or ngrok errors near the affected application.</p></article></div></section>

    <section id="workers"><h2>Workers</h2><p>A worker represents a Docker host where your applications can be cloned, built and run. Add at least one worker before creating a deployment.</p><figure className="docs-figure is-narrow"><img src="/docker-hub-worker.svg" alt="Docker Panel Lite worker running on a Docker host" /><figcaption>One worker can operate the deployments assigned to its Docker host.</figcaption></figure></section>

    <section id="worker-install"><h3>Connect a worker</h3><p>You can create a worker on a new Docker host or use one that is already running. In both cases, the worker must appear online and be available to your user before assigning it to a project.</p><div className="docs-two-column"><article><h4>Create a worker</h4><p>Run the worker image on the Docker host, preserve its data directory and claim it using the token printed in its logs.</p><a href="#create-worker">Create a worker →</a></article><article><h4>Use an existing worker</h4><p>Claim an unassigned worker with its token, or select an available worker that is already connected to the workspace.</p><a href="#existing-worker">Use an existing worker →</a></article></div></section>

    <section id="create-worker"><h3>Create a worker</h3><ol><li>On the Docker host, create persistent folders for repositories and worker identity.</li><li>Run the worker image with access to the Docker socket.</li><li>Read the generated worker token from its logs.</li><li>Open <strong>Workers</strong>, paste the token in <strong>Worker token</strong> and select Claim.</li><li>Confirm that the new worker appears online before deploying.</li></ol><pre><code>{`mkdir -p "$HOME/docker-panel-worker/repos" "$HOME/docker-panel-worker/data"

docker run -d --pull always \\
  --name docker-panel-lite-worker \\
  --restart unless-stopped \\
  -v /var/run/docker.sock:/var/run/docker.sock \\
  -v "$HOME/docker-panel-worker/repos:/app/clones" \\
  -v "$HOME/docker-panel-worker/data:/app/data" \\
  cjarn/docker-panel-lite-worker:py

docker logs --tail 100 docker-panel-lite-worker`}</code></pre><div className="docs-callout"><strong>Keep the data folder</strong><p>The mounted <code>/app/data</code> folder preserves the worker identity and token across restarts or image updates.</p></div></section>

    <section id="existing-worker"><h3>Use an existing worker</h3><p>Choose the case that matches the current state of the worker:</p><table><thead><tr><th>Worker state</th><th>What to do</th></tr></thead><tbody><tr><td>Running but not claimed</td><td>Read its token with <code>docker logs --tail 100 docker-panel-lite-worker</code>, enter it in Workers and select Claim.</td></tr><tr><td>Already visible to your user</td><td>No token is required. Open Project Settings → Environment and select it as the default worker.</td></tr><tr><td>Owned by another user</td><td>Ask the owner to share the worker with your user or make it available to the workspace.</td></tr><tr><td>Offline</td><td>Start the worker on its Docker host and wait until it reports an online state.</td></tr></tbody></table><div className="docs-callout is-warning"><strong>Test worker token</strong><p>This token is provided only for the test worker and must not be reused for production infrastructure.</p><pre><code>nYunaGwdMrEUAl7j02A8KeunUsJzFk2P</code></pre></div><div className="docs-callout"><strong>Assign it to a project</strong><p>Open Project Settings → Environment and select the worker. Deploy, sync and runtime operations for that project will use the selected Docker host.</p></div></section>

    <section id="worker-troubleshooting"><h3>Worker troubleshooting</h3><table><thead><tr><th>Symptom</th><th>What to check</th></tr></thead><tbody><tr><td>Worker appears offline</td><td>Confirm its container is running, review its logs and verify network access.</td></tr><tr><td>Worker does not appear</td><td>Confirm the claim token and refresh the Workers page.</td></tr><tr><td>Docker operation fails</td><td>Verify Docker is available on the host and the worker has the required access.</td></tr><tr><td>Project runs on the wrong host</td><td>Review the selected worker in the project Environment tab.</td></tr></tbody></table></section>

    <section id="deployments"><h2>Deployments</h2><p><strong>A deployment is everything required to turn a project into a running application.</strong> It combines the source, build instructions, environment, destination worker, running containers and access options in one place.</p><figure className="docs-figure"><img src="/deployment-workflow.svg" alt="Deployment from Git source to containers and an optional public URL" /><figcaption>The selected worker builds and runs the project, then reports the visible result in Deployments.</figcaption></figure><h3>What a deployment contains</h3><div className="docs-reference-grid">{deploymentContents.map(([title, copy]) => <article key={title}><h4>{title}</h4><p>{copy}</p></article>)}</div><a className="docs-next-link" href="/docs/deploy"><span>From repository to running application</span><strong>Follow the complete deployment guide →</strong></a></section>

    <section id="git-source"><h3>Git source</h3><p>Register an existing local project or clone a repository. Configure its URL, branch and an authorized credential when needed. After a successful Register or Clone action, the project panel closes and the project appears in the list.</p></section>

    <section id="build"><h3>Build and environment</h3><p>The <strong>Build</strong> tab defines how the application is created. The <strong>Environment</strong> tab contains runtime variables and the worker selector.</p><div className="docs-two-column"><article><h4>Docker Compose</h4><p>Use this for applications described by a Compose file. Select the file and configure the service and port used to reach the application.</p></article><article><h4>Dockerfile</h4><p>Use this to build and run one service. Select the Dockerfile, build context and port mappings for that container.</p></article></div><div className="docs-callout"><strong>Only the selected mode applies</strong><p>Project Settings shows the fields related to Docker Compose or Dockerfile so it is clear what will run.</p></div></section>

    <section id="public-urls"><h3>Public URLs and ngrok</h3><p>A deployment can remain private or expose a temporary public URL through ngrok. In the project Domain tab, enter the ngrok token first and then enable <strong>Public</strong>. You can generate a token from the discreet link next to the token field.</p><ul><li>A token belongs to its ngrok account; using a token from another account uses that account.</li><li>Account limits and available domains depend on the ngrok plan.</li><li>For Compose projects, select the service and internal port that should receive traffic.</li><li><strong>Close Public URL</strong> stops the tunnel even when the application container is not running.</li><li>Close URLs that are no longer needed before opening more sessions.</li></ul><div className="docs-callout is-warning"><strong>ngrok errors</strong><p>If ngrok rejects a session, review the message shown by the deployment. It may indicate account, billing, agent-limit, domain or upstream-port problems.</p></div></section>

    <section id="operations"><h3>Available operations and icons</h3><p>The icons below are the same ones used in the application. <strong>Primary</strong> actions remain visible on each row; actions marked <strong>More</strong> appear inside the three-dot menu. Some operations only appear when the worker and container are in an eligible state.</p><h4 className="docs-operation-heading">Projects</h4><p>Project operations act on the Git source and the complete application configuration.</p><OperationReference operations={projectOperations} /><h4 className="docs-operation-heading">Deployments</h4><p>Deployment operations act on an individual Docker container and its runtime.</p><OperationReference operations={deploymentOperations} /><div className="docs-callout"><strong>Deploy is different from Restart</strong><p>Use Deploy after changing source, Build or Environment. Use Restart when the current deployed version only needs to restart at runtime.</p></div></section>

    <section id="deployment-troubleshooting"><h3>Deployment troubleshooting</h3><table><thead><tr><th>Symptom</th><th>What to check</th></tr></thead><tbody><tr><td>Repository cannot be cloned</td><td>URL, branch and selected Git credential.</td></tr><tr><td>Compose or Dockerfile cannot be read</td><td>File path relative to the repository and worker availability.</td></tr><tr><td>Build fails</td><td>Deployment result, build file and required environment variables.</td></tr><tr><td>Application is not reachable</td><td>Container status, listening address and configured internal port.</td></tr><tr><td>Public URL fails</td><td>The exact ngrok error, account limits, domain availability and target service.</td></tr></tbody></table></section>
  </main>;
}
