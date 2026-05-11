import { fileURLToPath } from 'node:url';

const dashboardRoot = fileURLToPath(new URL('.', import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  typedRoutes: true,
  serverExternalPackages: ['harness-os'],
  outputFileTracingRoot: dashboardRoot,
};

export default nextConfig;
