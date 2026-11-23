import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { calculatePerformance, generateSeries, runMonteCarlo } from '../src/data.js';
import * as policy from '../src/strategy-analysis.js';
import { SUPPORTED_HISTORICAL_SYMBOLS, toPriceSeries } from '../src/market-data.js';
import * as research from '../src/research-engine.js';
import { createSimulationController, createSyntheticSimulation } from '../src/simulation-engine.js';
import { runWalkForwardValidation } from '../src/walk-forward.js';
import { analyzeEqualWeightPortfolio } from '../src/portfolio-analysis.js';

class ElementStub {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.attributes = {};
    this.listeners = {};
    this.classes = new Set();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.classList = {
      add: (value) => this.classes.add(value),
      remove: (value) => this.classes.delete(value),
      toggle: (value, force) => {
        const shouldAdd = force ?? !this.classes.has(value);
        if (shouldAdd) this.classes.add(value);
        else this.classes.delete(value);
      },
    };
  }

  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  querySelectorAll() { return []; }
  destroy() {}
}

async function bootApplication(storage) {
  const pageNames = ['overview', 'markets', 'strategies', 'backtesting', 'monte-carlo', 'research-lab', 'settings'];
  const nav = pageNames.map((page) => new ElementStub({ page }));
  const elements = new Map();
  const getElement = (selector) => {
    if (!elements.has(selector)) elements.set(selector, new ElementStub());
    return elements.get(selector);
  };
  const documentHandlers = {};
  const document = {
    documentElement: { dataset: {} },
    querySelector: getElement,
    querySelectorAll: (selector) => selector === '.nav-link[data-page]' ? nav : [],
    addEventListener: (type, listener) => { documentHandlers[type] = listener; },
    createElementNS: () => new ElementStub(),
  };
  const localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const window = { clearTimeout() {}, setTimeout() { return 1; }, clearInterval() {}, setInterval() { return 1; } };
  const chart = { update() {}, destroy() {} };
  const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8'))
    .replace(/^import\s+\{[\s\S]*?\}\s+from\s+['"][^'"]+['"];?\s*/gm, '')
    .replace(/^import\s+[^;]+;\s*$/gm, '');
  const context = vm.createContext({
    document,
    localStorage,
    window,
    console,
    calculatePerformance,
    generateSeries,
    runMonteCarlo,
    ...policy,
    ...research,
    SUPPORTED_HISTORICAL_SYMBOLS,
    toPriceSeries,
    runWalkForwardValidation,
    analyzeEqualWeightPortfolio,
    createPriceChart: () => chart,
    createLiveSimulationChart: () => chart,
    createReplayChart: () => chart,
    createSimulationController,
    createSyntheticSimulation,
    updateLiveSimulationChart() {},
    updatePriceChart() {},
    updateReplayChart() {},
    hydrateIcons() {},
  });
  vm.runInContext(source, context);
  return { context, document, documentHandlers, elements, getElement, nav };
}

function clickAction(app, action, dataset = {}) {
  const button = new ElementStub({ action, ...dataset });
  app.getElement('#secondary-view').listeners.click({
    target: { closest: (selector) => selector === '[data-action]' ? button : null },
  });
}

test('backtest and Monte Carlo experiments reload reproducibly and can be deleted', async () => {
  const storage = new Map();
  const app = await bootApplication(storage);
  app.nav[3].listeners.click();
  assert.match(app.getElement('#secondary-view').innerHTML, /Walk-forward testing/);
  assert.match(app.getElement('#secondary-view').innerHTML, /Historical symbol/);
  assert.match(app.getElement('#secondary-view').innerHTML, /MSFT/);
  app.getElement('#walk-forward-train').value = '60';
  app.getElement('#walk-forward-test').value = '20';
  app.getElement('#walk-forward-step').value = '20';
  app.getElement('#walk-forward-objective').value = 'sharpeRatio';
  app.getElement('#backtest-period').value = '1Y';
  app.getElement('#backtest-seed').value = '0';
  app.getElement('#commission-bps').value = '1';
  app.getElement('#slippage-bps').value = '5';
  clickAction(app, 'run-backtest');

  let storedRuns = JSON.parse(storage.get('quantx.midnight.experiments'));
  const savedBacktest = storedRuns.find((run) => run.kind === 'backtest');
  assert.ok(savedBacktest);
  assert.equal(savedBacktest.seed, 0);
  assert.deepEqual(savedBacktest.executionCosts, { commissionBps: 1, slippageBps: 5 });
  clickAction(app, 'run-walk-forward');
  assert.match(app.getElement('#walk-forward-results').innerHTML, /OUT-OF-SAMPLE RETURN/);
  assert.ok(['PASS', 'WARNING', 'FAIL'].includes(vm.runInContext('experiments[0].status', app.context)));

  app.nav[4].listeners.click();
  app.getElement('#scenario-count').value = '100';
  app.getElement('#scenario-horizon').value = '1';
  clickAction(app, 'run-monte-carlo');
  const monteCarloMarkup = app.getElement('#monte-carlo-results').innerHTML;
  assert.match(monteCarloMarkup, /TERMINAL-RETURN DISTRIBUTION/);
  assert.match(monteCarloMarkup, /MAXIMUM DRAWDOWN DISTRIBUTION/);
  assert.match(monteCarloMarkup, /Higher drawdown percentages represent worse losses/);
  storedRuns = JSON.parse(storage.get('quantx.midnight.experiments'));
  const savedMonteCarlo = storedRuns.find((run) => run.kind === 'monte-carlo');
  assert.ok(savedMonteCarlo);

  const reloaded = await bootApplication(storage);
  const loadedBacktest = vm.runInContext(`experiments.find((run) => run.id === ${JSON.stringify(savedBacktest.id)})`, reloaded.context);
  const expectedBacktest = policy.calculateStrategyBacktest(generateSeries('1Y', 0), savedBacktest.strategyConfig, 100_000, savedBacktest.executionCosts);
  assert.deepEqual(JSON.parse(JSON.stringify(loadedBacktest.backtest.metrics)), JSON.parse(JSON.stringify(expectedBacktest.metrics)));
  const loadedMonteCarlo = vm.runInContext(`experiments.find((run) => run.id === ${JSON.stringify(savedMonteCarlo.id)})`, reloaded.context);
  const expectedMonteCarlo = runMonteCarlo(savedMonteCarlo.monteCarlo.scenarioCount, savedMonteCarlo.monteCarlo.years, savedMonteCarlo.monteCarlo.seed);
  assert.deepEqual(JSON.parse(JSON.stringify(loadedMonteCarlo.monteCarlo)), JSON.parse(JSON.stringify(expectedMonteCarlo)));

  reloaded.nav[5].listeners.click();
  const researchMarkup = reloaded.getElement('#secondary-view').innerHTML;
  assert.match(researchMarkup, /data-delete-experiment=/);
  assert.match(researchMarkup, /MARKET REGIME DETECTOR/);
  assert.match(researchMarkup, /STRATEGY AUTOPSY/);
  assert.match(researchMarkup, /Momentum hypothesis test/);
  assert.match(researchMarkup, /hypothesis-block-length/);
  reloaded.getElement('#regime-window').value = '20';
  reloaded.getElement('#hypothesis-lookback').value = '5';
  reloaded.getElement('#hypothesis-permutations').value = '199';
  reloaded.getElement('#hypothesis-block-length').value = '5';
  clickAction(reloaded, 'run-research-analysis');
  assert.match(reloaded.getElement('#research-intelligence').outerHTML ?? '', /research-intelligence/);
  const deleteId = savedMonteCarlo.id;
  reloaded.documentHandlers.click({
    target: { closest: (selector) => selector === '[data-delete-experiment]' ? new ElementStub({ deleteExperiment: deleteId }) : null },
  });
  storedRuns = JSON.parse(storage.get('quantx.midnight.experiments'));
  assert.equal(storedRuns.some((run) => run.id === deleteId), false);
  assert.equal(vm.runInContext(`experiments.some((run) => run.id === ${JSON.stringify(deleteId)})`, reloaded.context), false);

  reloaded.documentHandlers.click({
    target: { closest: (selector) => selector === '[data-delete-experiment]' ? new ElementStub({ deleteExperiment: savedBacktest.id }) : null },
  });
  assert.equal(vm.runInContext('latestBacktestSeries', reloaded.context), null);
  assert.equal(vm.runInContext('currentGuardrails.status', reloaded.context), 'PENDING');
});


test('adjusted historical backtests use adjusted closes and preserve their basis after reload', async () => {
  const storage = new Map();
  const app = await bootApplication(storage);
  app.nav[3].listeners.click();
  app.getElement('#backtest-data-source').value = 'historical';
  app.getElement('#backtest-symbol').value = 'AAPL';
  app.getElement('#backtest-adjustment').value = 'adjusted';
  app.getElement('#commission-bps').value = '1';
  app.getElement('#slippage-bps').value = '5';

  const observations = Array.from({ length: 40 }, (_, index) => {
    const date = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
    const close = 100 + index;
    return {
      symbol: 'AAPL', date, open: close, high: close + 1, low: close - 1,
      close, adjustedClose: 90 + index * 0.9, volume: 1_000_000,
      dividendAmount: index === 20 ? 0.25 : 0,
      splitCoefficient: 1,
      source: 'alpha_vantage', frequency: '1d', adjustment: 'raw',
    };
  });
  let requestedUrl = '';
  app.context.fetch = async (url) => {
    requestedUrl = url;
    return {
      ok: true,
      json: async () => ({
        status: 'historical',
        data: { symbol: 'AAPL', requestedAdjustment: 'adjusted', observations },
        lastUpdated: '2025-02-10T00:00:00.000Z',
      }),
    };
  };

  await app.context.runBacktest();
  assert.match(requestedUrl, /adjustment=adjusted/);
  const savedRuns = JSON.parse(storage.get('quantx.midnight.experiments'));
  const saved = savedRuns.find((run) => run.kind === 'backtest');
  assert.ok(saved);
  assert.equal(saved.series.priceBasis, 'adjusted');
  assert.equal(saved.series.observations[0].rawClose, 100);
  assert.equal(saved.series.observations[0].close, 90);
  assert.equal(saved.series.observations[0].adjustment, 'adjusted');

  const reloaded = await bootApplication(storage);
  const loaded = vm.runInContext('experiments.find((run) => run.kind === "backtest")', reloaded.context);
  assert.equal(loaded.series.priceBasis, 'adjusted');
  assert.equal(loaded.series.values[0], 90);
  assert.equal(loaded.series.observations[0].rawClose, 100);
});
