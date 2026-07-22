import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "devploy.com",
  description: "Deploy and operate Docker applications from your own infrastructure",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
