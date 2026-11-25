import { createHealthApiHandler } from '../api/health.js';

const healthHandler = createHealthApiHandler();

export function createHealthMiddleware() {
  return function healthMiddleware(request, response, next) {
    let pathname;
    try {
      pathname = new URL(request.url || '/', 'http://localhost').pathname;
    } catch {
      return next();
    }
    if (pathname !== '/api/health') return next();
    return healthHandler(request, response);
  };
}
