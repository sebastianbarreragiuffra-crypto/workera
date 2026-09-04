import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { PwaLifecycle } from "@/components/pwa/PwaLifecycle";
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
  title: "GESTORA — Plataforma multiempresa",
  description: "Administración segura de clientes, personas, roles y módulos empresariales.",
  applicationName: "GESTORA",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "GESTORA",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/gestora-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/gestora-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#142a4c",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <PwaLifecycle />
      </body>
    </html>
  );
}
