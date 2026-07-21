import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/dashboard");
  return (
    <main className="public-landing">
      <nav className="landing-nav" aria-label="Public navigation">
        <a className="landing-brand" href="#top" aria-label="Docker Panel Lite">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>Docker Panel Lite</span>
        </a>
        <div>
          <a href="#architecture">Architecture</a>
          <a href="/docs">Docs</a>
          <a href="#login">Login</a>
          <a className="landing-nav-cta" href="#login">Get started</a>
        </div>
      </nav>

      <section className="landing-hero" id="top">
        <div className="landing-hero-copy">
          <p className="eyebrow">Ship from your own infrastructure</p>
          <h1>Your private deployment cockpit for Docker teams.</h1>
          <p>
            Docker Panel Lite gives small teams the feeling of a polished platform
            without giving up their own servers. Connect a worker, choose a repo,
            launch the service, and keep operations visible from the first sync to
            the live URL.
          </p>
          <div className="landing-hero-actions">
            <a className="landing-primary-link" href="#login">Get started</a>
            <a className="landing-secondary-link" href="/docs">Read the docs</a>
          </div>
          <div className="landing-trust-row" aria-label="Platform capabilities">
            <span>Firebase Auth</span>
            <span>Realtime Database</span>
            <span>Docker Hub worker</span>
            <span>Ngrok tunnels</span>
          </div>
        </div>

        <div className="landing-hero-visual" aria-label="Docker Hub worker image preview">
          <img src="/docker-hub-worker.svg" alt="Docker Hub worker image preview" />
        </div>
      </section>

      <section className="landing-live-demo" aria-label="Live product tour">
        <div className="live-demo-copy">
          <p className="eyebrow">Live product tour</p>
          <h2>Watch the workspace come online in seconds.</h2>
          <p>
            A lightweight animated walkthrough shows the moment a worker is claimed,
            a repository launches, and the service becomes reachable.
          </p>
        </div>
        <div className="live-demo-stage" aria-hidden="true">
          <div className="live-demo-browser">
            <div className="live-demo-topbar"><span /><span /><span /><strong>deployment.run</strong></div>
            <div className="live-demo-grid">
              <aside>
                <b>Control</b>
                <span className="is-active">Workers</span>
                <span>Repositories</span>
                <span>Credentials</span>
              </aside>
              <main>
                <div className="live-demo-status">
                  <span className="live-pulse" />
                  <strong>worker-default-01 online</strong>
                  <small>2 available slots</small>
                </div>
                <div className="live-demo-flow">
                  <span>Claim worker</span>
                  <span>Sync repository</span>
                  <span>Build service</span>
                  <span>Open public URL</span>
                </div>
                <div className="live-demo-terminal">
                  <code>job queued</code>
                  <code>compose build complete</code>
                  <code>service live on preview.ngrok.app</code>
                </div>
              </main>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-signal-strip" aria-label="Operational signals">
        <article>
          <strong>Workers</strong>
          <span>Bring capacity online wherever Docker runs, then assign it to the right people.</span>
        </article>
        <article>
          <strong>Jobs</strong>
          <span>Deployments become visible work instead of hidden terminal sessions.</span>
        </article>
        <article>
          <strong>Secrets</strong>
          <span>Teams can collaborate without passing tokens around in chat.</span>
        </article>
      </section>

      <section className="landing-feature-grid" aria-label="Product highlights">
        <article>
          <span className="landing-icon" aria-hidden="true"><IconPanel /></span>
          <h2>Launch from Git</h2>
          <p>Move from repository URL to running service with a guided path for branches, build settings, environment values, and target workers.</p>
        </article>
        <article>
          <span className="landing-icon" aria-hidden="true"><IconWorker /></span>
          <h2>Use the machines you trust</h2>
          <p>Keep execution on VPS hosts, office machines, or lab boxes while the panel gives you status, capacity, runtime details, and cleanup controls.</p>
        </article>
        <article>
          <span className="landing-icon" aria-hidden="true"><IconKey /></span>
          <h2>Share without chaos</h2>
          <p>Give teammates exactly what they need to deploy: the repo, the credential, the worker, or the whole workspace surface.</p>
        </article>
      </section>

      <section className="landing-workflow" id="workflow" aria-label="Deployment workflow">
        <div className="landing-section-copy">
          <p className="eyebrow">From idea to live service</p>
          <h2>A cleaner way to run the deployment loop.</h2>
          <p>Each action becomes a trackable job with a worker, status, owner, and timestamp, so releases feel coordinated instead of improvised.</p>
        </div>
        <div className="workflow-rail">
          <article><span>01</span><strong>Prepare</strong><small>Connect code, credentials, runtime settings, and the worker that should own the deployment.</small></article>
          <article><span>02</span><strong>Launch</strong><small>Run Compose or Dockerfile flows with the same repeatable controls every time.</small></article>
          <article><span>03</span><strong>Operate</strong><small>Manage containers, commands, restarts, logs, and service state from one surface.</small></article>
          <article><span>04</span><strong>Share</strong><small>Open public URLs when you need previews, demos, callbacks, or quick validation.</small></article>
        </div>
      </section>

      <section className="landing-architecture" id="architecture" aria-label="Platform architecture">
        <div className="landing-section-copy">
          <p className="eyebrow">Platform architecture</p>
          <h2>A control plane that stays close to your infrastructure.</h2>
          <p>
            The dashboard coordinates auth, job state, access rules, repositories,
            credentials, workers, containers, and public URLs while execution stays on
            the Docker hosts you already control.
          </p>
        </div>
        <div className="architecture-frame">
          <img src="/platform-architecture.svg" alt="Docker Panel Lite architecture diagram" />
        </div>
      </section>

      <section className="landing-showcase" aria-label="Workflow screenshots">
        <div className="landing-section-copy">
          <p className="eyebrow">The cockpit view</p>
          <h2>Everything important stays close to the action.</h2>
          <p>The interface keeps workers, repositories, credentials, commands, container logs, and public URLs in one place so deployment feels calm and legible.</p>
        </div>
        <div className="landing-screens">
          <article className="landing-screen">
            <div className="screen-toolbar"><span /><span /><span /></div>
            <div className="screen-sidebar" />
            <div className="screen-main">
              <div className="screen-search" />
              <div className="screen-panel">
                <strong>Workers</strong>
                <div className="screen-token-row">
                  <span>Worker token</span>
                  <b>+</b>
                </div>
                <div className="screen-worker-row"><i />Mexica <small>Online - Private - 11s ago</small></div>
              </div>
            </div>
            <p>Claim a host once, then use it as trusted deployment capacity for the workspace.</p>
          </article>
          <article className="landing-screen">
            <div className="screen-toolbar"><span /><span /><span /></div>
            <div className="screen-main wide">
              <div className="screen-tabs"><b>General</b><b>Build</b><b>Access</b></div>
              <div className="screen-access-card">
                <span>Visibility</span>
                <strong>Shared with users</strong>
                <small>one@example.com, two@example.com</small>
              </div>
              <div className="screen-actions"><i /><i /><i /><i /></div>
            </div>
            <p>Share the deployment surface without handing over every secret or every machine.</p>
          </article>
          <article className="landing-screen landing-screen-wide">
            <div className="screen-toolbar"><span /><span /><span /></div>
            <div className="screen-terminal">
              <b>Deployment activity</b>
              <code>sync repository {"->"} worker-default-01</code>
              <code>build compose.yml {"->"} service web:3000</code>
              <code>public tunnel {"->"} https://preview.ngrok.app</code>
            </div>
            <p>Watch releases move from queued work to running services with the signals operators actually need.</p>
          </article>
        </div>
      </section>

      <section className="landing-docs" id="docs" aria-label="Public setup documentation">
        <div className="landing-section-copy">
          <p className="eyebrow">Documentation</p>
          <h2>A practical guide for the whole deployment path.</h2>
          <p>Open the documentation hub for the architecture, worker setup, and the repository-to-deployment workflow.</p>
        </div>
        <div className="landing-doc-list">
          <a href="/docs#architecture">
            <span>01</span>
            <h3>Architecture</h3>
            <p>Understand the control plane, Firebase state, Docker workers, queues, containers, and public URLs.</p>
          </a>
          <a href="/docs#worker-setup">
            <span>02</span>
            <h3>Set up a worker</h3>
            <p>Run the Docker Hub image, persist the worker identity, copy the claim token, and attach the host.</p>
          </a>
          <a href="/docs#clone-deploy">
            <span>03</span>
            <h3>Clone and deploy</h3>
            <p>Add credentials, register a repository, sync branches, select a worker, and launch the service.</p>
          </a>
        </div>
        <a className="landing-docs-cta" href="/docs">Open documentation</a>
      </section>

      <section className="landing-login-section" id="login" aria-label="Sign in">
        <div className="landing-login-copy">
          <p className="eyebrow">Start now</p>
          <h2>Start shipping from the machines you already own.</h2>
          <p>Sign in with email or Google, claim your first worker, and turn a repository into a running service from the dashboard.</p>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}

function IconPanel() {
  return (
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M5.25 4.75h13.5A1.25 1.25 0 0 1 20 6v12a1.25 1.25 0 0 1-1.25 1.25H5.25A1.25 1.25 0 0 1 4 18V6a1.25 1.25 0 0 1 1.25-1.25Zm2 4h9.5M7.25 12h9.5M7.25 15.25h5.5" />
    </svg>
  );
}

function IconWorker() {
  return (
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M6.5 4.75h11A1.25 1.25 0 0 1 18.75 6v7A1.25 1.25 0 0 1 17.5 14.25h-11A1.25 1.25 0 0 1 5.25 13V6A1.25 1.25 0 0 1 6.5 4.75ZM8 18.75h8M12 14.25v4.5M8.25 8.25h.01M11 8.25h4.75M8.25 11h.01M11 11h4.75" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg viewBox="0 0 24 24" focusable="false">
      <path d="M7.75 14.25a4.25 4.25 0 1 1 3.7-6.34 4.25 4.25 0 0 1-3.7 6.34Zm4.05-4.25h8.2m-2.7 0v2.2m-2.55-2.2v1.55M6.55 10h.01" />
    </svg>
  );
}
