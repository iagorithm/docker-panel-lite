export default function DocsPage() {
  return (
    <main className="docs-page">
      <nav className="docs-nav" aria-label="Documentation navigation">
        <a className="landing-brand" href="/login" aria-label="Docker Panel Lite">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>Docker Panel Lite</span>
        </a>
        <div>
          <a href="#architecture">Architecture</a>
          <a href="#worker-setup">Worker setup</a>
          <a href="#clone-deploy">Clone and deploy</a>
          <a className="landing-nav-cta" href="/login#login">Login</a>
        </div>
      </nav>

      <header className="docs-hero">
        <p className="eyebrow">Documentation hub</p>
        <h1>Build, connect, and operate Docker deployments from your own hosts.</h1>
        <p>
          This guide explains how Docker Panel Lite is built, how to bring a worker
          online, and how to move from a Git repository to a running service.
        </p>
      </header>

      <section className="docs-index" aria-label="Documentation index">
        <a href="#architecture">
          <span>01</span>
          <strong>Architecture</strong>
          <small>Control panel, Firebase, workers, queues, containers, and URLs.</small>
        </a>
        <a href="#worker-setup">
          <span>02</span>
          <strong>Set up a worker</strong>
          <small>Docker Hub image, persistent folders, claim token, and sharing.</small>
        </a>
        <a href="#clone-deploy">
          <span>03</span>
          <strong>Clone and deploy</strong>
          <small>Credentials, repositories, branches, build mode, and launch flow.</small>
        </a>
      </section>

      <section className="docs-chapter" id="architecture">
        <div className="docs-chapter-copy">
          <p className="eyebrow">01 Architecture</p>
          <h2>How Docker Panel Lite is made</h2>
          <p>
            Docker Panel Lite separates the control panel from execution. The web app
            owns authentication, sharing rules, repository settings, credentials,
            queue state, and realtime visibility. Workers run on your Docker hosts
            and execute the operational work.
          </p>
        </div>
        <div className="architecture-frame">
          <img src="/platform-architecture.svg" alt="Docker Panel Lite architecture diagram" />
        </div>
        <div className="docs-explain-grid">
          <article>
            <h3>Control panel</h3>
            <p>Next.js and Firebase coordinate user sessions, resource access, job state, worker heartbeats, container inventory, logs, and public URL metadata.</p>
          </article>
          <article>
            <h3>Execution layer</h3>
            <p>Workers subscribe to queue updates, lease jobs, clone code into persistent storage, run Docker commands, and report results back to Firebase.</p>
          </article>
          <article>
            <h3>Access model</h3>
            <p>Workers, repositories, and credentials can be Private, Shared with selected users, or Public to the workspace depending on the collaboration surface.</p>
          </article>
        </div>
      </section>

      <section className="docs-chapter" id="worker-setup">
        <div className="docs-chapter-copy">
          <p className="eyebrow">02 Worker setup</p>
          <h2>Set up or claim a Docker worker</h2>
          <p>
            A worker is the server that will clone repositories, build images, start
            containers, expose previews, stream logs, and report status back to the panel.
          </p>
        </div>
        <div className="docs-command-steps">
          <article>
            <span>1</span>
            <h3>Sign in to Docker Hub</h3>
            <p>The worker image is distributed from Docker Hub. Use a personal access token when prompted.</p>
            <pre><code>{"docker login -u cjarn\n# Paste your Docker Hub personal access token when prompted."}</code></pre>
          </article>
          <article>
            <span>2</span>
            <h3>Create persistent folders</h3>
            <p>The data folder keeps the same worker ID and claim token after restarts.</p>
            <pre><code>{"mkdir -p \"$HOME/docker-panel-worker/repos\" \\\n  \"$HOME/docker-panel-worker/data\""}</code></pre>
          </article>
          <article>
            <span>3</span>
            <h3>Launch the worker</h3>
            <p>Mount the Docker socket so the worker can manage containers on this host.</p>
            <pre><code>{"docker run -d --pull always \\\n  --name docker-panel-lite-worker \\\n  --restart unless-stopped \\\n  -v /var/run/docker.sock:/var/run/docker.sock \\\n  -v \"$HOME/docker-panel-worker/repos:/app/clones\" \\\n  -v \"$HOME/docker-panel-worker/data:/app/data\" \\\n  cjarn/docker-panel-lite-worker:py"}</code></pre>
          </article>
          <article>
            <span>4</span>
            <h3>Copy and claim the token</h3>
            <p>Copy the claim token from logs, then open Containers, go to Workers, paste the token, and choose Private, Shared, or Public access.</p>
            <pre><code>{"docker logs --tail 100 docker-panel-lite-worker\n# Worker claim token for worker-default-...: <generated-worker-token>"}</code></pre>
          </article>
        </div>
        <div className="docs-note">
          <strong>Safety note</strong>
          <p>The Docker socket gives the worker control over containers on the host. Run the worker only on trusted infrastructure and never share Docker Hub tokens, Firebase credentials, worker claim tokens, Git tokens, or encryption keys outside the platform.</p>
        </div>
      </section>

      <section className="docs-chapter" id="clone-deploy">
        <div className="docs-chapter-copy">
          <p className="eyebrow">03 Clone and deploy</p>
          <h2>Move from repository to live service</h2>
          <p>
            The deployment flow is designed to make each step visible: credential,
            repository, sync, build settings, target worker, queued job, container,
            logs, and public URL.
          </p>
        </div>
        <div className="docs-flow-list">
          <article>
            <span>Credential</span>
            <h3>Add access for private repositories</h3>
            <p>Create a credential alias with username and token. Keep it Private, share it with specific users, or make it workspace Public when appropriate.</p>
          </article>
          <article>
            <span>Repository</span>
            <h3>Register and sync source code</h3>
            <p>Add the Git URL, select a credential if the repository is private, then sync to load branches, Compose files, Dockerfiles, services, and runtime metadata.</p>
          </article>
          <article>
            <span>Build</span>
            <h3>Choose Compose or Dockerfile mode</h3>
            <p>For Compose, confirm file, service, environment, ports, and internal service port. For Dockerfile, confirm context, Dockerfile path, image/container settings, and ports.</p>
          </article>
          <article>
            <span>Worker</span>
            <h3>Select where the deployment runs</h3>
            <p>Pick an online worker with the right access level. The queue leases jobs and prevents concurrent deployments for the same repository.</p>
          </article>
          <article>
            <span>Launch</span>
            <h3>Deploy and operate</h3>
            <p>Start the deployment, watch realtime job activity, inspect logs, restart or stop containers, and open public URLs for demos, callbacks, previews, or validation.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
