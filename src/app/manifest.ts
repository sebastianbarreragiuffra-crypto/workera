import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "GESTORA — Operación empresarial",
    short_name: "GESTORA",
    description: "Rendiciones, asistencia y gestión empresarial segura desde el navegador.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f3f5f8",
    theme_color: "#142a4c",
    orientation: "any",
    lang: "es-CL",
    categories: ["business", "productivity", "finance"],
    icons: [
      { src: "/icons/gestora-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/gestora-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/gestora-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
