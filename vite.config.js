import { defineConfig } from 'vite';
import { createAlphaVantageMiddleware } from './server/alpha-vantage-proxy.js';
import { createHealthMiddleware } from './server/health-middleware.js';

export default defineConfig({
  plugins: [{
    name: 'quantx-alpha-vantage-server-proxy',
    configureServer(server) {
      server.middlewares.use(createHealthMiddleware());
      server.middlewares.use(createAlphaVantageMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createAlphaVantageMiddleware());
    },
  }],
});
