import { notFound } from "next/navigation";
import { DashboardViewPage, type DashboardView } from "../dashboard-view";

const sectionViews: Record<string, DashboardView> = {
  deployments: "containers",
  projects: "repositories",
  workers: "workers",
  logs: "logs",
  settings: "settings",
};

export default async function DashboardSectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const initialView = sectionViews[section];
  if (!initialView) notFound();
  return <DashboardViewPage initialView={initialView} />;
}
