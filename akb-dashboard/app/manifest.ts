import type { MetadataRoute } from "next";

// Installable PWA manifest (silver-platter cockpit — the operator runs the
// business from a phone; the dashboard installs like an app).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AKB Cockpit",
    short_name: "AKB",
    description: "AKB Solutions — the operator cockpit",
    start_url: "/",
    display: "standalone",
    background_color: "#0d1117",
    theme_color: "#0d1117",
    orientation: "portrait",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
