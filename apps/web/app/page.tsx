import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";
import { PublicLanding } from "./login/page";

export const metadata: Metadata = {
  title: "Self-hosted Docker deployment platform",
  description: "Deploy Docker Compose and Dockerfile applications from Git to your own servers. Operate remote workers, containers, logs, commands and public URLs with worqer.app.",
  alternates: { canonical: "/" },
};

export default async function Home() {
  if (await getSessionUser()) redirect("/dashboard/deployments");
  return <PublicLanding />;
}
