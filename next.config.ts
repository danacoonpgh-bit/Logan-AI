import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The setup guide route reads these docs from disk at runtime. Nothing
  // imports them, so trace them in explicitly or readFileSync 404s on Vercel.
  outputFileTracingIncludes: {
    "/api/agency/setup/guide": ["./CLAUDE.md", "./SETUP.md", "./.env.example"],
  },
  async headers() {
    return [
      {
        // Web-chat embed target, loaded cross-origin from any buyer's site.
        // frame-ancestors * allows that; without it some hosts inject
        // X-Frame-Options DENY/SAMEORIGIN and block third-party iframes.
        source: "/embed/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *;",
          },
          // Override the legacy header in case anything upstream adds it.
          { key: "X-Frame-Options", value: "ALLOWALL" },
        ],
      },
      {
        // Invite tokens ride in URLs, so keep them out of Referer and caches.
        source: "/field/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/j/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        source: "/api/field-portal/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // Widget loader: cacheable and served to any origin so the <script>
        // tag works on any buyer's site.
        source: "/widget.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, s-maxage=300" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
