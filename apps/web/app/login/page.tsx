import { redirect } from "next/navigation";

import { getSessionUser } from "@/lib/session";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  if (await getSessionUser()) redirect("/dashboard");
  return <main className="auth-page"><LoginForm /></main>;
}
