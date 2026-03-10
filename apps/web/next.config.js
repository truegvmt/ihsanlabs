/** @type {import('next').NextConfig} */
const nextConfig = {
    // Enable PWA in production
    // next-pwa is configured below — wraps this config
    experimental: {
        // App Router is stable in Next.js 15, no flag needed
    },
    // Vercel-optimised image domains
    images: {
        remotePatterns: [
            { protocol: "https", hostname: "*.supabase.co" },
            { protocol: "https", hostname: "d-portal.org" },
        ],
    },
};

// Wrap with next-pwa for offline donor form caching
// Only active in production (pnpm build) — dev mode is unaffected
let config = nextConfig;
try {
    const withPWA = require("next-pwa")({
        dest: "public",
        disable: process.env.NODE_ENV === "development",
        register: true,
        skipWaiting: true,
        runtimeCaching: [
            {
                urlPattern: /^\/$/, // cache home (donor form) page
                handler: "NetworkFirst",
                options: {
                    cacheName: "donor-form",
                    expiration: { maxAgeSeconds: 86400 },
                },
            },
        ],
    });
    config = withPWA(nextConfig);
} catch {
    // next-pwa not installed — dev mode, skip silently
}

module.exports = config;
