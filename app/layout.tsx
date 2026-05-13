import type { Metadata } from "next";
import {
  Fraunces,
  Newsreader,
  DM_Sans,
  Source_Serif_4,
  Inter,
  Pixelify_Sans,
} from "next/font/google";
import "./globals.css";

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
  title: "Alpha — your weekly alpha",
  description:
    "A personal weekly letter on what matters to you. Pick five topics. Sundays.",
  manifest: "/alpha/manifest.json",
  icons: {
    icon: [{ url: "/alpha/favicon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/alpha/favicon.svg" }],
  },
  themeColor: "#1F3D2E",
  openGraph: {
    title: "Alpha — your weekly alpha",
    description: "A personal weekly letter on what matters to you.",
    type: "website",
    siteName: "Alpha",
  },
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
