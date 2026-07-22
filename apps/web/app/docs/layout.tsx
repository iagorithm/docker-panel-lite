import type { ReactNode } from "react";

const platformLinks = [
  ["Overview", "/docs"], ["Architecture", "/docs#architecture"], ["Workers", "/docs#workers"],
  ["Credentials", "/docs#credentials"], ["Projects", "/docs#projects"], ["Build modes", "/docs#build"],
  ["Environment", "/docs#environment"], ["Domains & ngrok", "/docs#domains"],
  ["Deployments", "/docs#deployments"], ["Logs & commands", "/docs#operations"],
  ["Access & security", "/docs#security"],
];

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <div className="docs-site">
    <aside className="docs-sidebar">
      <a className="docs-sidebar-brand" href="/docs"><span className="brand-mark" aria-hidden="true"><span /></span><span><strong>Docker Panel Lite</strong><small>Documentation</small></span></a>
      <nav aria-label="Documentation index"><p>Platform</p>{platformLinks.map(([label, href]) => <a href={href} key={href}>{label}</a>)}<p>Guides</p><a href="/docs/deploy">Complete deployment</a><a href="/docs#troubleshooting">Troubleshooting</a></nav>
      <div className="docs-sidebar-footer"><a href="/login">Open application</a></div>
    </aside>
    <div className="docs-site-main"><header className="docs-mobile-header"><a href="/docs">Documentation</a><a href="/login">Open app</a></header>{children}</div>
  </div>;
}
