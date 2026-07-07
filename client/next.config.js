/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=()"
          }
        ]
      }
    ];
  },
  async rewrites() {
    return [
      {
        source: "/favicon.ico",
        destination: "/favicon.svg"
      },
      {
        source: "/sync-api/:path*",
        destination: "https://syncstream-backend-vosk.onrender.com/:path*"
      }
    ];
  }
};

module.exports = nextConfig;
