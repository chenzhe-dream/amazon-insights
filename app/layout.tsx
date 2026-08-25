import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { webArtifactId } from "./lib/web-artifact-id";
import "./globals.css";
import "./warm-theme.css";
import "./comparison-layout.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const h = await headers();
  const host = h.get("x-forwarded-host") || h.get("host") || "localhost:3000";
  const protocol = h.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "Amazon 产品机会洞察";
  const description = "面向亚马逊运营团队的产品机会洞察：竞品对比、VOC、流量、关键词与立项决策。";
  return {
    title,
    description,
    openGraph: { title, description, images: [{ url: `${origin}/og.png`, width: 1536, height: 1024 }] },
    twitter: { card: "summary_large_image", title, description, images: [`${origin}/og.png`] },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const artifactId = webArtifactId(process.env);
  return <html lang="zh-CN" data-web-artifact-id={artifactId}><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
