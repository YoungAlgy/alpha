import type { Metadata, Viewport } from "next";
import {
  Fraunces,
  Newsreader,
  DM_Sans,
  Source_Serif_4,
  Inter,
  Pixelify_Sans,
} from "next/font/google";
import "./globals.css";
import { ThemeApplier } from "@/components/ThemeApplier";
import { PostHogProvider } from "@/components/PostHogProvider";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});
const newsreader = Newsreader({
  variable: "--font-newsreader",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
const dmSans = DM_Sans({
  variable: "--font-dm-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});
const pixelify = Pixelify_Sans({
  variable: "--font-pixelify",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://youngalgy.com"),
  title: "Alpha — your weekly alpha",
  description:
    "A personal weekly letter on what matters to you. Pick five topics. Sundays.",
  manifest: "/alpha/manifest.json",
  // iMessage / iOS prefer a real PNG over SVG for the bubble icon. Listing the
  // PNG first prevents fall-through to the apex domain's apple-touch-icon
  // (which on youngalgy.com is the portfolio's sugar skull).
  icons: {
    icon: [
      { url: "/alpha/icon-512.png", type: "image/png", sizes: "512x512" },
      { url: "/alpha/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/alpha/favicon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/alpha/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: "Alpha — your weekly alpha",
    description: "A personal weekly letter on what matters to you, every Sunday.",
    type: "website",
    siteName: "Alpha",
    url: "https://youngalgy.com/alpha",
    images: [
      {
        url: "/alpha/og-image.png",
        width: 1200,
        height: 630,
        alt: "Alpha — your weekly alpha",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Alpha — your weekly alpha",
    description: "A personal weekly letter on what matters to you, every Sunday.",
    images: ["/alpha/og-image.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#1F3D2E",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      data-theme="forest"
      className={[
        fraunces.variable,
        newsreader.variable,
        dmSans.variable,
        sourceSerif.variable,
        inter.variable,
        pixelify.variable,
        "h-full antialiased",
      ].join(" ")}
    >
      <body className="min-h-full flex flex-col">
        <ThemeApplier />
        <PostHogProvider />
        {children}
      </body>
    </html>
  );
}
