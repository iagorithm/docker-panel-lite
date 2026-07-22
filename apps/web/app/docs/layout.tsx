import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Docker deployment documentation",
  description: "Learn how to connect remote Docker workers and deploy Compose stacks or Dockerfile applications to your own servers with worqer.app.",
  alternates: { canonical: "/docs" },
};

const groups = [
  {
    label: "Overview",
    links: [["Documentation", "/docs"], ["Architecture", "/docs#architecture"], ["Problems it solves", "/docs#problems"], ["Deploy an application", "/docs/deploy"]],
  },
  {
    label: "Workers",
    links: [["What is a worker?", "/docs#workers"], ["Create a worker", "/docs#create-worker"], ["Use an existing worker", "/docs#existing-worker"], ["Worker troubleshooting", "/docs#worker-troubleshooting"]],
  },
  {
    label: "Deployments",
    links: [["What is a deployment?", "/docs#deployments"], ["Git source", "/docs#git-source"], ["Build and environment", "/docs#build"], ["Public URLs and ngrok", "/docs#public-urls"], ["Operations", "/docs#operations"], ["Deployment troubleshooting", "/docs#deployment-troubleshooting"]],
  },
];

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <div className="docs-site">
    <aside className="docs-sidebar">
      <a className="docs-sidebar-brand" href="/docs"><span className="brand-mark" aria-hidden="true"><span /></span><span><strong>worqer.app</strong><small>Documentation</small></span></a>
      <nav aria-label="Documentation index">{groups.map((group, index) => <details key={group.label} open={index === 0}><summary><span>{group.label}</span><i aria-hidden="true" /></summary><div>{group.links.map(([label, href]) => <a href={href} key={href}>{label}</a>)}</div></details>)}</nav>
      <div className="docs-sidebar-footer"><a href="/login">Open application</a></div>
    </aside>
    <div className="docs-site-main"><header className="docs-mobile-header"><a href="/docs">Documentation</a><a href="/login">Open app</a></header>{children}</div>
  </div>;
}
