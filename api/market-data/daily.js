import { createAlphaVantageMiddleware } from '../../server/alpha-vantage-proxy.js';

export function createMarketDataApiHandler(options = {}) {
  const middleware = createAlphaVantageMiddleware(options);
  return async function marketDataApiHandler(request, response) {
    return middleware(request, response, () => {
      response.statusCode = 404;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ status: 'not_found', message: 'Route not found.' }));
    });
  };
}

export default createMarketDataApiHandler();
