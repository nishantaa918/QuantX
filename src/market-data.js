const SOURCE = 'alpha_vantage';
const FREQUENCY = '1d';

function parsePositiveNumber(value, field, date) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid ${field} value for ${date}.`);
  return number;
}

function parseVolume(value, date) {
  const volume = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(volume) || volume < 0) throw new Error(`Invalid volume value for ${date}.`);
  return volume;
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeAlphaVantageRows(rows, { symbol = 'AAPL', limit = 100 } = {}) {
  if (!Array.isArray(rows) || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid daily observation data.');
  const byDate = new Map();
  for (const row of rows) {
    if (!row || !validateDate(row.date)) throw new Error(`Invalid daily observation date: ${row?.date ?? 'missing'}.`);
    if (byDate.has(row.date)) continue;
    const open = parsePositiveNumber(row.open, 'open', row.date);
    const high = parsePositiveNumber(row.high, 'high', row.date);
    const low = parsePositiveNumber(row.low, 'low', row.date);
    const close = parsePositiveNumber(row.close, 'close', row.date);
    const volume = parseVolume(row.volume, row.date);
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error(`Inconsistent OHLC prices for ${row.date}.`);
    }
    byDate.set(row.date, { symbol, date: row.date, open, high, low, close, volume, source: SOURCE, frequency: FREQUENCY, adjustment: 'raw' });
  }
  const observations = [...byDate.values()].sort((first, second) => first.date.localeCompare(second.date)).slice(-limit);
  if (!observations.length) throw new Error('The provider returned no daily observations.');
  return observations;
}

export function normalizeAlphaVantageDaily(payload, { symbol = 'AAPL', limit = 100 } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The provider returned an invalid response.');
  const providerMessage = payload['Error Message'] ?? payload.Note ?? payload.Information;
  if (providerMessage) throw new Error(String(providerMessage));
  const metadata = payload['Meta Data'] ?? {};
  const providerSymbol = metadata['2. Symbol'];
  if (providerSymbol && providerSymbol.toUpperCase() !== symbol.toUpperCase()) throw new Error(`Provider returned ${providerSymbol} instead of ${symbol}.`);
  const dailySeries = payload['Time Series (Daily)'];
  if (!dailySeries || typeof dailySeries !== 'object' || Array.isArray(dailySeries)) throw new Error('The provider response contains no daily time series.');
  const rows = Object.entries(dailySeries).map(([date, daily]) => ({
    date,
    open: daily?.['1. open'],
    high: daily?.['2. high'],
    low: daily?.['3. low'],
    close: daily?.['4. close'],
    volume: daily?.['5. volume'],
  }));
  return {
    symbol: symbol.toUpperCase(),
    observations: normalizeAlphaVantageRows(rows, { symbol: symbol.toUpperCase(), limit }),
    source: SOURCE,
    frequency: FREQUENCY,
    adjustment: 'raw',
    exchange: null,
    currency: null,
    providerLastRefreshed: metadata['3. Last Refreshed'] ?? null,
    timeZone: metadata['5. Time Zone'] ?? null,
  };
}
