import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Deploy Docker Compose and Dockerfile applications",
  description: "Step-by-step guide to deploy a Git repository with Docker Compose or a Dockerfile to your own server using a worqer.app remote worker.",
  alternates: { canonical: "/docs/deploy" },
};

const steps = [
  ["1", "Prepare a worker", "Start and claim a worker on the Docker host. Confirm that it appears online."],
  ["2", "Add Git access", "For a private repository, create a credential available to the project owner."],
  ["3", "Register the project", "Enter alias, repository URL and branch, then Register or Clone on a worker."],
  ["4", "Configure Build", "Select Compose or Dockerfile and enter only the fields relevant to that mode."],
  ["5", "Set environment", "Add runtime variables and select the default worker for this project."],
  ["6", "Configure public access", "Optionally save an ngrok token, enable Public URL and select a domain."],
  ["7", "Deploy", "Click Deploy and follow the deployment event until the worker reports completion."],
  ["8", "Verify", "Inspect containers and logs, test the endpoint and close unused public URLs."],
];

export default function CompleteDeploymentPage() {
  return <main className="docs-article">
    <header className="docs-article-header"><p className="docs-breadcrumb">Documentation / Guides / Deployment</p><h1>Complete deployment guide</h1><p>Go from a Git repository to a running, observable Docker service with an optional public URL.</p></header>
    <figure className="docs-figure"><img src="/deployment-workflow.svg" alt="Git to Docker deployment workflow" /><figcaption>The worker performs Git, Docker and ngrok operations and returns results to the panel.</figcaption></figure>
    <div className="docs-callout"><strong>Requirements</strong><p>A Docker host, an online claimed worker, a Git repository with a Compose file or Dockerfile, and provider credentials for private repositories.</p></div>
    <section><h2>Deployment workflow</h2><div className="docs-procedure">{steps.map(([n, title, copy]) => <article key={n}><span>{n}</span><div><h3>{title}</h3><p>{copy}</p></div></article>)}</div></section>
    <section id="compose"><h2>Docker Compose checklist</h2><ul className="docs-checklist"><li>The Compose path is relative to the repository root.</li><li>Services have valid image or build configuration.</li><li>Required networks and volumes can be created on the host.</li><li>The selected service and internal port identify the application.</li><li>Public services are reachable from the worker.</li></ul><pre><code>{`docker compose -p <project> -f <compose-file> up -d --build`}</code></pre></section>
    <section id="dockerfile"><h2>Dockerfile checklist</h2><ul className="docs-checklist"><li>The Dockerfile remains inside the repository.</li><li>The build context contains all COPY sources.</li><li>The application listens on 0.0.0.0.</li><li>Ports use host:container form, for example 8080:80.</li><li>The managed container name has no collision.</li></ul></section>
    <section id="status"><h2>What happens after Deploy</h2><ol><li>The selected worker synchronizes the configured Git source.</li><li>It builds the Compose services or Dockerfile image.</li><li>It starts or recreates the application containers.</li><li>The deployment reports completion or shows an actionable error.</li><li>If public access is enabled, the configured service receives a public URL.</li></ol></section>
    <section id="verify"><h2>Post-deployment verification</h2><ol><li>Confirm expected containers appear in Deployments.</li><li>Check status and published ports.</li><li>Open logs and verify application startup.</li><li>Test the local or public endpoint.</li><li>Confirm ngrok targets the intended service.</li><li>Close public URLs when no longer required.</li></ol></section>
    <section id="recover"><h2>Stop, retry and recover</h2><p>Use Stop project to stop the stack or managed container. Correct Git or Build settings, synchronize and deploy again. Use Restart only when source and configuration have not changed.</p><div className="docs-callout is-warning"><strong>Preserve diagnostics</strong><p>Read deployment events and container logs before deleting failed containers or cleaning worker state.</p></div></section>
    <a className="docs-next-link" href="/docs"><span>Platform reference</span><strong>Return to overview →</strong></a>
  </main>;
}
