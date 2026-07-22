import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    { url: "https://worqer.app", lastModified, changeFrequency: "weekly", priority: 1 },
    { url: "https://worqer.app/docs", lastModified, changeFrequency: "weekly", priority: 0.8 },
    { url: "https://worqer.app/docs/deploy", lastModified, changeFrequency: "monthly", priority: 0.7 },
  ];
}
