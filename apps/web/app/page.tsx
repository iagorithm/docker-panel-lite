import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/session";

export default async function Home() {
  redirect((await getSessionUser()) ? "/dashboard/deployments" : "/login");
}
