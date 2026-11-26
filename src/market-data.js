export const SUPPORTED_HISTORICAL_SYMBOLS = Object.freeze(['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'SPY', 'QQQ', 'DIA', 'IWM']);

const SOURCE = 'alpha_vantage';
const FREQUENCY = '1d';

function normalizeSymbol(symbol) {
  if (typeof symbol !== 'string' || !symbol.trim()) {
    throw new Error('A valid ticker symbol is required.');
  }
  return symbol.trim().toUpperCase();
}

function parseDecimalNumber(value, field, date) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${field} value for ${date}.`);
    return value;
  }
  if (typeof value !== 'string') throw new Error(`Invalid ${field} value for ${date}.`);
  const normalized = value.trim();
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    throw new Error(`Invalid ${field} value for ${date}.`);
  }
  const number = Number(normalized);
  if (!Number.isFinite(number)) throw new Error(`Invalid ${field} value for ${date}.`);
  return number;
}

function parsePositiveNumber(value, field, date) {
  const number = parseDecimalNumber(value, field, date);
  if (number <= 0) throw new Error(`Invalid ${field} value for ${date}.`);
  return number;
}

function parseNonNegativeNumber(value, field, date, fallback = 0) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return fallback;
  const number = parseDecimalNumber(value, field, date);
  if (number < 0) throw new Error(`Invalid ${field} value for ${date}.`);
  return number;
}

function parseVolume(value, date) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`Missing volume value for ${date}.`);
  }
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new Error(`Invalid volume value for ${date}.`);
  }
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) {
    throw new Error(`Invalid volume value for ${date}.`);
  }
  const number = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid volume value for ${date}.`);
  return number;
}

function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeAlphaVantageRows(rows, { symbol = 'AAPL', limit = 100 } = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!Array.isArray(rows) || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid daily observation data.');
  const byDate = new Map();
  for (const row of rows) {
    if (!row || !validateDate(row.date)) throw new Error(`Invalid daily observation date: ${row?.date ?? 'missing'}.`);
    if (row.symbol !== undefined
      && (typeof row.symbol !== 'string' || !row.symbol.trim()
        || row.symbol.trim().toUpperCase() !== normalizedSymbol)) {
      throw new Error(`Daily observation symbol does not match requested ticker ${normalizedSymbol}.`);
    }
    const open = parsePositiveNumber(row.open, 'open', row.date);
    const high = parsePositiveNumber(row.high, 'high', row.date);
    const low = parsePositiveNumber(row.low, 'low', row.date);
    const close = parsePositiveNumber(row.close, 'close', row.date);
    const volume = parseVolume(row.volume, row.date);
    const adjustedClose = row.adjustedClose === undefined || row.adjustedClose === null || row.adjustedClose === ''
      ? null
      : parsePositiveNumber(row.adjustedClose, 'adjusted close', row.date);
    const dividendAmount = parseNonNegativeNumber(row.dividendAmount, 'dividend amount', row.date);
    const splitCoefficient = row.splitCoefficient === undefined || row.splitCoefficient === null || row.splitCoefficient === ''
      ? null
      : parsePositiveNumber(row.splitCoefficient, 'split coefficient', row.date);
    if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
      throw new Error(`Inconsistent OHLC prices for ${row.date}.`);
    }
    const normalizedRow = {
      symbol: normalizedSymbol, date: row.date, open, high, low, close, volume,
      adjustedClose, dividendAmount, splitCoefficient,
      source: SOURCE, frequency: FREQUENCY, adjustment: 'raw',
    };
    const existing = byDate.get(row.date);
    if (existing) {
      const sameFinancialValues = ['open', 'high', 'low', 'close', 'volume', 'adjustedClose', 'dividendAmount', 'splitCoefficient']
        .every((field) => existing[field] === normalizedRow[field]);
      if (!sameFinancialValues) throw new Error(`Conflicting duplicate daily observations for ${row.date}.`);
      continue;
    }
    byDate.set(row.date, normalizedRow);
  }
  const observations = [...byDate.values()].sort((first, second) => first.date.localeCompare(second.date)).slice(-limit);
  if (!observations.length) throw new Error('The provider returned no daily observations.');
  return observations;
}

export function normalizeAlphaVantageDaily(payload, { symbol = 'AAPL', limit = 100 } = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('The provider returned an invalid response.');
  const providerMessage = payload['Error Message'] ?? payload.Note ?? payload.Information;
  if (providerMessage) throw new Error(String(providerMessage));
  const metadata = payload['Meta Data'];
  const providerSymbol = metadata?.['2. Symbol'];
  if (typeof providerSymbol !== 'string' || !providerSymbol.trim()
    || providerSymbol.trim().toUpperCase() !== normalizedSymbol) {
    throw new Error(`Provider returned missing or unexpected symbol metadata instead of ${normalizedSymbol}.`);
  }
  const adjustedSeries = payload['Time Series (Daily Adjusted)'];
  const dailySeries = adjustedSeries ?? payload['Time Series (Daily)'];
  if (!dailySeries || typeof dailySeries !== 'object' || Array.isArray(dailySeries)) throw new Error('The provider response contains no daily time series.');
  const hasAdjustedFields = Object.values(dailySeries).some((daily) => daily
    && typeof daily === 'object'
    && ['5. adjusted close', '7. dividend amount', '8. split coefficient']
      .some((field) => Object.hasOwn(daily, field)));
  const isAdjustedSeries = Boolean(adjustedSeries) || hasAdjustedFields;
  const rows = Object.entries(dailySeries).map(([date, daily]) => {
    if (!daily || typeof daily !== 'object' || Array.isArray(daily)) throw new Error(`Invalid daily observation fields for ${date}.`);
    if (isAdjustedSeries && ['5. adjusted close', '6. volume', '7. dividend amount', '8. split coefficient']
      .some((field) => daily[field] === undefined || daily[field] === null || String(daily[field]).trim() === '')) {
      throw new Error(`Incomplete adjusted price or corporate-action fields for ${date}.`);
    }
    return {
      date,
      open: daily['1. open'],
      high: daily['2. high'],
      low: daily['3. low'],
      close: daily['4. close'],
      adjustedClose: daily['5. adjusted close'],
      volume: daily['6. volume'] ?? daily['5. volume'],
      dividendAmount: daily['7. dividend amount'],
      splitCoefficient: daily['8. split coefficient'],
    };
  });
  const observations = normalizeAlphaVantageRows(rows, { symbol: normalizedSymbol, limit });
  const hasAdjustedClose = observations.every((observation) => Number.isFinite(observation.adjustedClose));
  return {
    symbol: normalizedSymbol,
    observations,
    source: SOURCE,
    frequency: FREQUENCY,
    adjustment: hasAdjustedClose ? 'raw_with_adjusted_close' : 'raw',
    exchange: null,
    currency: null,
    providerLastRefreshed: metadata['3. Last Refreshed'] ?? null,
    timeZone: metadata['5. Time Zone'] ?? null,
  };
}

export function toPriceSeries(observations, { symbol = 'AAPL', priceBasis = 'raw' } = {}) {
  if (!Array.isArray(observations) || observations.length < 2) {
    throw new Error('Historical backtesting requires at least two daily observations.');
  }
  if (!['raw', 'adjusted'].includes(priceBasis)) throw new Error('Price basis must be raw or adjusted.');
  const normalizedSymbol = normalizeSymbol(symbol);
  let previousDate = '';
  const cleanObservations = observations.map((observation) => {
    if (!observation || !validateDate(observation.date) || observation.date <= previousDate) {
      throw new Error('Historical observations must have unique, ascending calendar dates.');
    }
    if (observation.symbol !== undefined
      && (typeof observation.symbol !== 'string' || !observation.symbol.trim()
        || observation.symbol.trim().toUpperCase() !== normalizedSymbol)) {
      throw new Error('Historical observations must all match the requested ticker symbol.');
    }
    previousDate = observation.date;
    const close = parsePositiveNumber(
      priceBasis === 'adjusted' ? observation.adjustedClose : observation.close,
      priceBasis === 'adjusted' ? 'adjusted close' : 'close',
      observation.date,
    );
    return { ...observation, symbol: normalizedSymbol, rawClose: observation.rawClose ?? observation.close, close, adjustment: priceBasis };
  });
  return {
    period: 'HISTORICAL',
    symbol: normalizedSymbol,
    source: SOURCE,
    frequency: FREQUENCY,
    adjustment: priceBasis,
    priceBasis,
    labels: cleanObservations.map((observation) => observation.date),
    values: cleanObservations.map((observation) => observation.close),
    observations: cleanObservations,
  };
}
