import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
    title: "Ihsan Labs — Intelligent Waqf & Charity",
    description:
        "The OpenAI for philanthropy. Give with intention, guided by evidence. Every dirham guided to maximum impact.",
    applicationName: "Ihsan Labs",
    manifest: "/manifest.json",
    icons: {
        icon: "/icon-192.png",
        apple: "/icon-192.png",
    },
    openGraph: {
        title: "Ihsan Labs",
        description: "Intelligent charitable giving powered by IATI evidence.",
        type: "website",
    },
};

export const viewport: Viewport = {
    themeColor: "#0d1117",
    width: "device-width",
    initialScale: 1,
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" className="dark">
            <body className={inter.className}>{children}</body>
        </html>
    );
}
