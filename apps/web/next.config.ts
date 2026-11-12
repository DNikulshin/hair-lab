import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Контракты поставляются собранными (tsup), поэтому transpilePackages не нужен.
  poweredByHeader: false,
  // Docker-образ: самодостаточная сборка без node_modules в runtime.
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
};

export default nextConfig;
