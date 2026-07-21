"use client";

import { useState } from "react";

type DocumentationPanelProps = {
  defaultOpen?: boolean;
  compact?: boolean;
};

const docs = [
  {
    step: "01",
    title: "Create or claim a worker",
    summary: "A worker is the machine that runs Docker jobs for the workspace.",
    items: [
      "To create a new worker, run the Docker Hub worker image on the server that will execute containers.",
      "Make sure the worker has Docker access and the Firebase/workspace environment configured.",
      "Read the worker logs and copy the Worker claim token.",
      "If the worker is already running, copy its current claim token from the logs and claim it from the panel.",
      "In the dashboard, open Containers, find Workers, paste the token into Worker token, and press the add button.",
    ],
  },
  {
    step: "02",
    title: "Add a credential",
    summary: "Credentials let private repositories sync and deploy without exposing tokens in the UI.",
    items: [
      "Open Repositories, then open Credentials.",
      "Create a credential with an alias, username, and token.",
      "Use Private for owner-only credentials, Shared for selected emails, or Public for the whole workspace.",
      "Only share credentials with users who should be able to sync or deploy repositories that depend on them.",
    ],
  },
  {
    step: "03",
    title: "Register a repository",
    summary: "Repositories define the source code, build mode, environment, and target runtime settings.",
    items: [
      "Open Repositories and add the Git URL.",
      "Select a credential only when the repository is private.",
      "Choose Compose or Dockerfile mode and confirm the compose file, Dockerfile, service, ports, and environment variables.",
      "Set access for the repository: Private, Shared with users, or Public to workspace.",
    ],
  },
  {
    step: "04",
    title: "Deploy",
    summary: "Deployments are queued jobs that run on the selected worker.",
    items: [
      "Select an online worker from the repository row.",
      "Sync the repository when you need the latest code or branches.",
      "Use Deploy for Compose projects or Build and run for Dockerfile projects.",
      "Use the public URL action when you need a preview, callback endpoint, demo URL, or quick validation link.",
    ],
  },
  {
    step: "05",
    title: "Manage containers",
    summary: "The Containers view is where running services become operational.",
    items: [
      "Search containers by name, image, project, worker, status, or public URL.",
      "Start, stop, restart, delete, or inspect logs from managed containers.",
      "Use registered command presets to run repeatable commands inside running containers.",
      "Group by project or worker to understand where each service is running and which worker owns it.",
    ],
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
    <section className={`docs-panel ${compact ? "is-compact" : ""}`} aria-label="Docker Panel Lite documentation">
      <div className="docs-panel-header">
        <div>
          <p className="eyebrow">Documentation</p>
          <h2>How to operate Docker Panel Lite</h2>
          <p>Follow this order when setting up a workspace or onboarding a teammate.</p>
        </div>
        <button type="button" aria-label="Close documentation" title="Close documentation" onClick={() => setOpen(false)}>
          <span aria-hidden="true">x</span>
        </button>
      </div>
      <div className="docs-steps">
        {docs.map((item) => (
          <article className="docs-step" key={item.step}>
            <span>{item.step}</span>
            <div>
              <h3>{item.title}</h3>
              <p>{item.summary}</p>
              <ul>
                {item.items.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
