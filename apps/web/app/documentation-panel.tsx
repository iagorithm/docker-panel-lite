"use client";

import { useState } from "react";

type DocumentationPanelProps = {
  defaultOpen?: boolean;
  compact?: boolean;
};

const workerSetupDocs = [
  {
    title: "1. Sign in to Docker Hub",
    body: "The worker image is distributed from Docker Hub. Sign in on the server before pulling or running the private image.",
    command: "docker login -u cjarn\n# When prompted, paste your Docker Hub personal access token.",
  },
  {
    title: "2. Create persistent folders",
    body: "Keep worker data mounted. The data folder preserves the worker identity and claim token across restarts.",
    command: "mkdir -p \"$HOME/docker-panel-worker/repos\" \\\n  \"$HOME/docker-panel-worker/data\"",
  },
  {
    title: "3. Choose the worker runtime",
    body: "Use the :py tag for the stable Python worker or :go for the lightweight compiled Go worker. Both support the same project workflow; each installation needs its own data folder.",
    command: "WORKER_TAG=py  # Change to go to use the Go worker\nWORKER_IMAGE=\"cjarn/docker-panel-lite-worker:$WORKER_TAG\"",
  },
  {
    title: "4. Launch the worker",
    body: "Run the selected worker image on the machine that should build images, start containers, read logs, and execute deployment jobs.",
    command:
      "WORKER_TAG=py # Change to go to use the Go worker\ndocker run -d --pull always \\\n  --name docker-panel-lite-worker \\\n  --restart unless-stopped \\\n  -v /var/run/docker.sock:/var/run/docker.sock \\\n  -v \"$HOME/docker-panel-worker/repos:/app/clones\" \\\n  -v \"$HOME/docker-panel-worker/data:/app/data\" \\\n  \"cjarn/docker-panel-lite-worker:$WORKER_TAG\"",
  },
  {
    title: "5. Copy the claim token",
    body: "The token is printed in local worker logs. It is used once from the dashboard to attach the machine to your workspace.",
    command:
      "docker logs --tail 100 docker-panel-lite-worker\n# Look for: Worker claim token for worker-default-...: <generated-worker-token>",
  },
  {
    title: "6. Claim it from worqer.app",
    body: "Open the dashboard, go to Containers, open Workers, paste the token into Worker token, press the add button, then choose Private, Shared, or Public access.",
  },
];

const appGuideDocs = [
  {
    step: "01",
    title: "Create or claim a worker",
    summary: "Workers are the execution layer. They listen to Firebase queues, lease jobs safely, clone repositories, run Docker, and report realtime status back to the panel.",
    items: [
      "New worker: run the Docker Hub image on the server that will own builds and containers.",
      "Already running worker: read the current claim token from the logs and claim it from Containers > Workers.",
      "Keep /app/data mounted so the worker keeps the same identity and claim token after a restart.",
      "Private workers are owner-only, Shared workers are available to selected users, and Public workers are visible to the workspace.",
      "The worker's own container is protected from destructive container actions in the dashboard.",
    ],
  },
  {
    step: "02",
    title: "Add a credential",
    summary: "Credentials unlock private repositories without exposing tokens in project cards, logs, or teammate screens.",
    items: [
      "Open Repositories, then Credentials, and create an alias with the provider username and token.",
      "Use Private for personal access, Shared for selected teammate emails, or Public for workspace-wide use.",
      "Admins manage credentials; operators can use shared credentials to sync and deploy approved repositories.",
      "Do not share Docker Hub PATs, Firebase service credentials, worker tokens, GitHub tokens, or encryption keys outside the platform.",
    ],
  },
  {
    step: "03",
    title: "Register a repository",
    summary: "A repository stores the source URL, branch, build mode, runtime settings, environment, and access policy used by deployments.",
    items: [
      "Add the Git URL and select a credential only when the repository is private.",
      "Choose Docker Compose or Dockerfile mode and confirm compose file, service, Dockerfile, context, ports, and environment variables.",
      "Use repository sharing to expose the project without exposing unrelated credentials or workers.",
      "Sync before deploying when you need fresh branches, compose files, or Dockerfile metadata.",
    ],
  },
  {
    step: "04",
    title: "Deploy",
    summary: "Deployments are queued jobs assigned to an online worker. Firebase state keeps the dashboard live while the worker executes Git and Docker operations.",
    items: [
      "Select an online worker, sync the repository, then deploy the selected branch and mode.",
      "The queue uses leases and repository locks so one repository is not deployed concurrently by multiple workers.",
      "Compose projects can start selected services; Dockerfile projects can build and run a managed container.",
      "Use public URL actions for demos, callbacks, preview links, or quick validation.",
    ],
  },
  {
    step: "05",
    title: "Public URLs and tunnels",
    summary: "The platform can expose services through quick public URLs for previews, demos, callbacks, and validation.",
    items: [
      "Use tunnels when you need a reachable URL without configuring a reverse proxy.",
      "The app stores the public URL metadata and the worker connects the tunnel to the selected running service.",
      "Close public URLs when previews, callbacks, or demos no longer need external access.",
    ],
  },
  {
    step: "06",
    title: "Manage containers",
    summary: "Containers is the operations room: running services, worker inventory, logs, actions, and health signals in one view.",
    items: [
      "Search by name, image, project, worker, status, port, or public URL.",
      "Start, stop, restart, delete, inspect logs, and run registered command presets against managed containers.",
      "Group by project or worker to understand where services live and which machine owns the runtime.",
      "Use worker heartbeat, runtime, Docker availability, and queue state to validate capacity before deploying.",
    ],
  },
];

const maintenanceDocs = [
  "docker ps --filter name=docker-panel-lite-worker",
  "docker logs -f docker-panel-lite-worker",
  "docker restart docker-panel-lite-worker",
  "docker rm -f docker-panel-lite-worker",
];

const docs = [
  {
    title: "Worker quick setup",
    summary: "The PDF worker guide converted into a practical setup path for the public docs.",
    entries: workerSetupDocs,
  },
  {
    title: "Complete app guide",
    summary: "The full platform guide: credentials, repositories, deployments, public URLs, scaling, and operations.",
    entries: appGuideDocs,
  },
];

export function DocumentationPanel({ defaultOpen = true, compact = false }: DocumentationPanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <button className="docs-open-button" type="button" onClick={() => setOpen(true)}>
        Open documentation
      </button>
    );
  }

  return (
    <section className={`docs-panel ${compact ? "is-compact" : ""}`} aria-label="worqer.app documentation">
      <div className="docs-panel-header">
        <div>
          <p className="eyebrow">Documentation</p>
          <h2>Setup docs for workers, repositories, and deployments</h2>
          <p>Start with the worker claim flow, then connect credentials, repositories, deployment targets, public URLs, and container operations.</p>
        </div>
        <button type="button" aria-label="Close documentation" title="Close documentation" onClick={() => setOpen(false)}>
          <span aria-hidden="true">x</span>
        </button>
      </div>
      <div className="docs-content">
        {docs.map((section) => (
          <section className="docs-section" key={section.title}>
            <div className="docs-section-heading">
              <h3>{section.title}</h3>
              <p>{section.summary}</p>
            </div>
            {section.title === "Worker quick setup" ? (
              <div className="docs-worker-grid">
                {workerSetupDocs.map((item) => (
                  <article className="docs-worker-card" key={item.title}>
                    <h4>{item.title}</h4>
                    <p>{item.body}</p>
                    {item.command ? <pre><code>{item.command}</code></pre> : null}
                  </article>
                ))}
              </div>
            ) : (
              <div className="docs-steps">
                {appGuideDocs.map((item) => (
                  <article className="docs-step" key={item.step}>
                    <span>{item.step}</span>
                    <div>
                      <h4>{item.title}</h4>
                      <p>{item.summary}</p>
                      <ul>
                        {item.items.map((line) => <li key={line}>{line}</li>)}
                      </ul>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        ))}
        <section className="docs-maintenance" aria-label="Worker maintenance commands">
          <div>
            <h3>Worker maintenance commands</h3>
            <p>Use these from the server when you need to verify, follow, restart, or remove the worker container. Removing the persistent data folder is permanent and deletes identity, repositories, and the claim token.</p>
          </div>
          <div className="docs-command-list">
            {maintenanceDocs.map((command) => <code key={command}>{command}</code>)}
          </div>
        </section>
      </div>
    </section>
  );
}
