import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";

import { parseTheme, THEME_COOKIE } from "@/lib/theme";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Curacel Expense Dashboard",
  description: "Read-only dashboard for the Curacel expense bot.",
};

/**
 * Runs in <head> before any CSS is parsed, so the .dark class lands on
 * <html> before the first paint. Without this, users on system=dark
 * without a cookie would see a brief flash of light styles.
 *
 * Skips when a cookie is already set — the server has already rendered
 * the correct className on <html> in that case, so we don't need to do
 * anything client-side.
 */
const THEME_INIT_SCRIPT = `(function(){try{if(document.cookie.match(/${THEME_COOKIE}=/))return;if(window.matchMedia('(prefers-color-scheme: dark)').matches){document.documentElement.classList.add('dark');}}catch(e){}})();`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  // We only ever add `.dark` — light is the default :root, no class
  // needed. theme === "system" leaves it unset; the inline script then
  // reads prefers-color-scheme and applies if needed.
  const htmlClass = theme === "dark" ? "dark" : "";

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${htmlClass} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
