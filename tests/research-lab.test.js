import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { calculatePerformance, generateSeries, runMonteCarlo } from '../src/data.js';
import * as policy from '../src/strategy-analysis.js';
import { createSimulationController, createSyntheticSimulation } from '../src/simulation-engine.js';

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
  app.getElement('#backtest-period').value = '1Y';
  app.getElement('#backtest-seed').value = '0';
  clickAction(app, 'run-backtest');

  let storedRuns = JSON.parse(storage.get('quantx.midnight.experiments'));
  const savedBacktest = storedRuns.find((run) => run.kind === 'backtest');
  assert.ok(savedBacktest);
  assert.equal(savedBacktest.seed, 0);
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
  const expectedBacktest = policy.calculateStrategyBacktest(generateSeries('1Y', 0), savedBacktest.strategyConfig);
  assert.deepEqual(JSON.parse(JSON.stringify(loadedBacktest.backtest.metrics)), JSON.parse(JSON.stringify(expectedBacktest.metrics)));
  const loadedMonteCarlo = vm.runInContext(`experiments.find((run) => run.id === ${JSON.stringify(savedMonteCarlo.id)})`, reloaded.context);
  const expectedMonteCarlo = runMonteCarlo(savedMonteCarlo.monteCarlo.scenarioCount, savedMonteCarlo.monteCarlo.years, savedMonteCarlo.monteCarlo.seed);
  assert.deepEqual(JSON.parse(JSON.stringify(loadedMonteCarlo.monteCarlo)), JSON.parse(JSON.stringify(expectedMonteCarlo)));

  reloaded.nav[5].listeners.click();
  assert.match(reloaded.getElement('#secondary-view').innerHTML, /data-delete-experiment=/);
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
