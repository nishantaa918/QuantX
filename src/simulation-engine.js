import { calculateStrategySignal, DEFAULT_STRATEGY } from './strategy-analysis.js';

const SIMULATION_EPOCH = Date.UTC(2025, 0, 1);
const MAX_HISTORY = 600;

function createRandom(seed) {
  let state = (Number.isFinite(seed) ? Math.trunc(seed) : 0) >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function calculatePortfolioEquity({ cash, holdings, price } = {}) {
  if (![cash, holdings, price].every(Number.isFinite) || cash < 0 || holdings < 0 || price <= 0) return null;
  return cash + holdings * price;
}

export function rebalancePortfolio({ cash, holdings, price, targetExposure } = {}) {
  const equity = calculatePortfolioEquity({ cash, holdings, price });
  if (!Number.isFinite(equity) || !Number.isFinite(targetExposure) || targetExposure < 0 || targetExposure > 1) return null;
  const nextHoldings = equity * targetExposure / price;
  const nextCash = equity - nextHoldings * price;
  return { cash: Math.max(0, nextCash), holdings: nextHoldings, equity };
}

export function createSyntheticSimulation({
  seed = 126,
  initialCapital = 100_000,
  initialPrice = 5128.4,
  strategy = DEFAULT_STRATEGY,
} = {}) {
  if (!Number.isInteger(seed) || seed < 0) throw new RangeError('Simulation seed must be a non-negative integer.');
  if (!Number.isFinite(initialCapital) || initialCapital <= 0) throw new RangeError('Initial capital must be greater than zero.');
  if (!Number.isFinite(initialPrice) || initialPrice <= 0) throw new RangeError('Initial price must be greater than zero.');

  let random;
  let strategyConfig = { ...strategy };
  let prices;
  let history;
  let cash;
  let holdings;
  let price;
  let tick;
  let signal;
  let shortAverage;
  let longAverage;

  function makeSnapshot() {
    const timestamp = new Date(SIMULATION_EPOCH + tick * 1000).toISOString();
    const equity = calculatePortfolioEquity({ cash, holdings, price });
    return { tick, timestamp, price, cash, holdings, equity, signal, shortAverage, longAverage };
  }

  function getState() {
    return { ...makeSnapshot(), history: history.map((point) => ({ ...point })) };
  }

  function reset() {
    random = createRandom(seed);
    prices = [initialPrice];
    cash = initialCapital;
    holdings = 0;
    price = initialPrice;
    tick = 0;
    signal = 'FLAT';
    shortAverage = null;
    longAverage = null;
    history = [makeSnapshot()];
    return getState();
  }

  function advance() {
    const simulatedReturn = 0.000002 + (random() - 0.5) * 0.0008;
    price = Math.max(0.01, price * (1 + simulatedReturn));
    tick += 1;
    prices.push(price);
    if (prices.length > MAX_HISTORY) prices.shift();
    const policy = calculateStrategySignal(prices, prices.length - 1, strategyConfig);
    signal = policy.signal;
    shortAverage = policy.shortAverage;
    longAverage = policy.longAverage;

    const currentEquity = calculatePortfolioEquity({ cash, holdings, price });
    const targetExposure = policy.ready ? policy.targetExposure : 0;
    const position = rebalancePortfolio({ cash, holdings, price, targetExposure });
    cash = position?.cash ?? currentEquity;
    holdings = position?.holdings ?? 0;

    const snapshot = makeSnapshot();
    history.push(snapshot);
    if (history.length > MAX_HISTORY) history.shift();
    return getState();
  }

  function setStrategy(nextStrategy) {
    strategyConfig = { ...nextStrategy };
    return getState();
  }

  reset();
  return { getState, advance, reset, setStrategy };
}

export function createSimulationController({
  engine,
  intervalMs = 1000,
  onUpdate = () => {},
  onState = () => {},
  schedule = (callback, delay) => window.setInterval(callback, delay),
  cancel = (timer) => window.clearInterval(timer),
} = {}) {
  if (!engine) throw new TypeError('A simulation engine is required.');
  let timer = null;
  let disposed = false;

  function getState() {
    return { running: timer !== null, disposed, snapshot: engine.getState() };
  }

  function publishState() {
    onState(getState());
  }

  function pause() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    publishState();
    return getState();
  }

  function start() {
    if (disposed) return false;
    if (timer !== null) return true;
    timer = schedule(() => {
      if (disposed || timer === null) return;
      onUpdate(engine.advance());
    }, intervalMs);
    publishState();
    return true;
  }

  function reset() {
    pause();
    const snapshot = engine.reset();
    onUpdate(snapshot);
    publishState();
    return snapshot;
  }

  function setStrategy(strategy) {
    const snapshot = engine.setStrategy(strategy);
    onUpdate(snapshot);
    return snapshot;
  }

  function dispose() {
    pause();
    disposed = true;
    publishState();
    return getState();
  }

  return { getState, start, resume: start, pause, reset, setStrategy, dispose };
}
