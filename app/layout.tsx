import type { Metadata, Viewport } from "next";
import {
  Fraunces,
  Newsreader,
  DM_Sans,
  Source_Serif_4,
  Inter,
  Pixelify_Sans,
  Playfair_Display,
  Bebas_Neue,
} from "next/font/google";
import "./globals.css";
import { ThemeApplier } from "@/components/ThemeApplier";
import { PostHogProvider } from "@/components/PostHogProvider";

// Fonts: the default Forest theme uses source-serif + newsreader + inter, so
// those preload. Fraunces / DM Sans / Pixelify are only used by NON-default
// themes — preload:false keeps them off the landing's critical path (they
// still load on demand when a theme applies them; font-display:swap covers the
// brief swap). Trims the cold-visitor font payload roughly in half.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
  preload: false,
  weight: ["400", "500", "600", "700"], // dropped "800" — used 0× across the app
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
  preload: false,
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
  preload: false,
  weight: ["400", "500", "600", "700"],
});
// Money Mitch theme only — Playfair for headings, Bebas for the eyebrow labels.
// preload:false keeps both off every other theme's critical path (same treatment
// as Fraunces/DM Sans/Pixelify); they load on demand when "mitch" applies.
const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
  preload: false,
  weight: ["400", "500", "600", "700"],
});
const bebas = Bebas_Neue({
  variable: "--font-bebas",
  subsets: ["latin"],
  display: "swap",
  preload: false,
  weight: ["400"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://youngalgy.com"),
  // Consistent lowercase-brand titles across every page. Child pages set just
  // their page name (e.g. "Privacy") and the template appends "· alpha." —
  // no more drift between "— Alpha", "— alpha.", and "Alpha —". A page can
  // opt out with title.absolute (the landing does).
  title: {
    default: "alpha. your alpha",
    template: "%s · alpha.",
  },
  description:
    "A personal letter on what matters to you. Pick five topics. Three times a week.",
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
    title: "alpha. your alpha",
    description: "A personal letter on what matters to you, three times a week.",
    type: "website",
    siteName: "alpha.",
    url: "https://youngalgy.com/alpha",
    images: [
      {
        url: "/alpha/og-image.png",
        width: 1200,
        height: 630,
        alt: "alpha. your alpha",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "alpha. your alpha",
    description: "A personal letter on what matters to you, three times a week.",
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
        playfair.variable,
        bebas.variable,
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
