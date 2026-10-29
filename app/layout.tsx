// Define the root HTML layout shared by every page in the application.
import type { Metadata } from "next"; // Use Next.js metadata typing to keep page metadata valid.
import type { ReactNode } from "react"; // Type the child content rendered inside the layout.
import "./globals.css"; // Load the app-wide visual styles once at the root.
export const metadata: Metadata = { title: "Sandip | AI Interview Voicebot", description: "An interactive AI voicebot representing Sandip's professional profile." }; // Set a clear browser title and accessible search description.
export default function RootLayout({ children }: { children: ReactNode }) { // Define the required root layout component.
  return <html lang="en"><body>{children}</body></html>; // Provide the HTML document structure and render the selected page.
}
