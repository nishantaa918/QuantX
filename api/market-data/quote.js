import { createMarketDataApiHandler } from './daily.js';

export function createMarketQuoteApiHandler(options = {}) {
  return createMarketDataApiHandler(options);
}

export default createMarketQuoteApiHandler();
