// Define the root HTML layout shared by every page in the application.
import type { Metadata, Viewport } from "next"; // Use Next.js metadata typing to keep page metadata valid.
import type { ReactNode } from "react"; // Type the child content rendered inside the layout.
import "./globals.css"; // Load the app-wide visual styles once at the root.
export const metadata: Metadata = {
  title: "Shishupal | AI Interview Voicebot",
  description: "An interactive AI voicebot representing Shishupal's professional profile.",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Shishupal Voicebot",
  },
}; // Set a clear browser title and accessible search description.

export const viewport: Viewport = {
  themeColor: "#5559d8",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }) { // Define the required root layout component.
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon-192.svg" sizes="192x192" type="image/svg+xml" />
        <link rel="icon" href="/icon-512.svg" sizes="512x512" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/icon-192.svg" />
      </head>
      <body>{children}</body>
    </html>
  ); // Provide the HTML document structure and render the selected page.
}
