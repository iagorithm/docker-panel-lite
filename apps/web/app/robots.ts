import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/docs"],
      disallow: ["/api/", "/dashboard/", "/login"],
    },
    sitemap: "https://worqer.app/sitemap.xml",
    host: "https://worqer.app",
  };
}
