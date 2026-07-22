import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://worqer.app"),
  title: {
    default: "worqer.app — Self-hosted Docker deployment platform",
    template: "%s | worqer.app",
  },
  description: "Deploy Docker Compose and Dockerfile applications to your own servers. Manage remote Docker workers, containers, logs, commands and public URLs from one dashboard.",
  keywords: [
    "self-hosted deployment platform",
    "Docker deployment platform",
    "Docker Compose deployment",
    "Dockerfile deployment",
    "remote Docker management",
    "container management dashboard",
    "VPS deployment panel",
    "deploy to your own server",
    "self-hosted PaaS",
    "Docker worker",
  ],
  applicationName: "worqer.app",
  authors: [{ name: "worqer.app", url: "https://worqer.app" }],
  creator: "worqer.app",
  publisher: "worqer.app",
  openGraph: {
    type: "website",
    siteName: "worqer.app",
    title: "worqer.app — Deploy Docker apps to your own servers",
    description: "A self-hosted Docker deployment platform for Compose stacks, Dockerfiles, remote workers, logs and public URLs.",
    url: "https://worqer.app",
  },
  twitter: {
    card: "summary",
    title: "worqer.app — Self-hosted Docker deployments",
    description: "Deploy and operate Docker apps on infrastructure you control.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
