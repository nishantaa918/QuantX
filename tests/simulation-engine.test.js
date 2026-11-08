import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLiveSimulationChartConfig, LIVE_SIMULATION_HISTORY_WINDOWS, updateLiveSimulationChart } from '../src/chart.js';
import {
  calculatePortfolioEquity,
  createSimulationController,
  createSyntheticSimulation,
  rebalancePortfolio,
} from '../src/simulation-engine.js';

const compactStrategy = { type: 'moving-average', shortWindow: 2, longWindow: 5, lookback: 5, volatilitySensitivity: 1.5 };

test('portfolio equity is cash plus marked-to-market virtual holdings', () => {
  assert.equal(calculatePortfolioEquity({ cash: 1_000, holdings: 5, price: 100 }), 1_500);
  const invested = rebalancePortfolio({ cash: 1_000, holdings: 0, price: 100, targetExposure: 0.5 });
  assert.equal(invested.cash, 500);
  assert.equal(invested.holdings, 5);
  assert.equal(invested.equity, 1_000);
  const liquidated = rebalancePortfolio({ cash: invested.cash, holdings: invested.holdings, price: 110, targetExposure: 0 });
  assert.equal(liquidated.cash, 1_050);
  assert.equal(liquidated.holdings, 0);
  assert.equal(liquidated.equity, 1_050);
  assert.equal(calculatePortfolioEquity({ cash: -1, holdings: 0, price: 100 }), null);
});

test('seeded engine ticks synchronize price, holdings, equity, timestamp, and reset', () => {
  const first = createSyntheticSimulation({ seed: 33, strategy: compactStrategy });
  const second = createSyntheticSimulation({ seed: 33, strategy: compactStrategy });
  const firstSnapshots = Array.from({ length: 60 }, () => first.advance());
  const secondSnapshots = Array.from({ length: 60 }, () => second.advance());

  assert.deepEqual(firstSnapshots, secondSnapshots);
  assert.ok(firstSnapshots.some((snapshot) => snapshot.holdings > 0));
  for (const snapshot of firstSnapshots) {
    assert.equal(snapshot.equity, snapshot.cash + snapshot.holdings * snapshot.price);
    assert.equal(snapshot.tick, (Date.parse(snapshot.timestamp) - Date.UTC(2025, 0, 1)) / 1000);
  }
  assert.equal(first.getState().history.at(-1).tick, 60);
  const reset = first.reset();
  assert.equal(reset.tick, 0);
  assert.equal(reset.price, 5128.4);
  assert.equal(reset.cash, 100_000);
  assert.equal(reset.holdings, 0);
  assert.deepEqual(first.advance(), firstSnapshots[0]);
});

test('simulation clock uses one 1000ms timer and pause, resume, reset, dispose prevent stale updates', () => {
  const engine = createSyntheticSimulation({ seed: 9, strategy: compactStrategy });
  const scheduled = [];
  const canceled = [];
  const updates = [];
  const controller = createSimulationController({
    engine,
    onUpdate: (snapshot) => updates.push(snapshot),
    schedule: (callback, delay) => { const timer = { callback, delay }; scheduled.push(timer); return timer; },
    cancel: (timer) => canceled.push(timer),
  });

  assert.equal(controller.start(), true);
  assert.equal(controller.start(), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 1000);
  scheduled[0].callback();
  assert.equal(updates.at(-1).tick, 1);
  controller.pause();
  scheduled[0].callback();
  assert.equal(updates.length, 1);
  assert.deepEqual(canceled, [scheduled[0]]);

  controller.resume();
  assert.equal(scheduled.length, 2);
  scheduled[1].callback();
  assert.equal(updates.at(-1).tick, 2);
  const reset = controller.reset();
  assert.equal(reset.tick, 0);
  assert.equal(controller.getState().running, false);
  assert.equal(updates.at(-1).tick, 0);

  controller.start();
  const activeTimer = scheduled[2];
  controller.dispose();
  activeTimer.callback();
  assert.equal(updates.at(-1).tick, 0);
  assert.equal(controller.getState().disposed, true);
  assert.equal(controller.start(), false);
});

test('live market-price and equity chart points share tick labels and reset together', () => {
  const updates = [];
  const chart = {
    data: { labels: [0], datasets: [{ data: [5128.4] }, { data: [100_000] }] },
    update(mode) { updates.push(mode); },
  };
  const history = [
    { tick: 0, price: 5128.4, equity: 100_000 },
    { tick: 1, price: 5129, equity: 100_010 },
    { tick: 2, price: 5130, equity: 100_020 },
  ];
  updateLiveSimulationChart(chart, history, 30);

  assert.deepEqual(chart.data.labels, [0, 1, 2]);
  assert.deepEqual(chart.data.datasets[0].data, [5128.4, 5129, 5130]);
  assert.deepEqual(chart.data.datasets[1].data, [100_000, 100_010, 100_020]);
  updateLiveSimulationChart(chart, [history[1], history[2]], 30);
  assert.deepEqual(chart.data.labels, [1, 2]);
  updateLiveSimulationChart(chart, [history[0]], 30);
  assert.deepEqual(chart.data.labels, [0]);
  assert.deepEqual(chart.data.datasets[0].data, [5128.4]);
  assert.deepEqual(chart.data.datasets[1].data, [100_000]);
  assert.deepEqual(updates, ['none', 'none', 'none']);
});

test('live chart uses independent labeled axes, timestamp tooltips, and supported history windows', () => {
  const history = [
    { tick: 0, price: 100, equity: 10_000 },
    { tick: 1, price: 101, equity: 10_050 },
  ];
  const config = buildLiveSimulationChartConfig(history);

  assert.deepEqual(LIVE_SIMULATION_HISTORY_WINDOWS, [30, 60, 120, 300]);
  assert.equal(config.options.responsive, true);
  assert.equal(config.options.animation, false);
  assert.equal(config.data.datasets[0].yAxisID, 'price');
  assert.equal(config.data.datasets[1].yAxisID, 'equity');
  assert.equal(config.options.scales.price.position, 'left');
  assert.equal(config.options.scales.equity.position, 'right');
  assert.equal(config.options.scales.price.title.display, true);
  assert.equal(config.options.scales.equity.title.display, true);
  assert.equal(config.options.plugins.tooltip.callbacks.title([{ label: 1 }]), 'T+1s');
  assert.match(config.options.plugins.tooltip.callbacks.label({ dataset: { yAxisID: 'equity' }, parsed: { y: 10_050 } }), /\$10,050/);
  assert.match(config.options.plugins.tooltip.callbacks.label({ dataset: { yAxisID: 'price' }, parsed: { y: 101 } }), /101\.00 pts/);
});

test('engine and chart history remain bounded to their separate limits', () => {
  const engine = createSyntheticSimulation({ seed: 11, strategy: compactStrategy });
  for (let index = 0; index < 650; index += 1) engine.advance();
  const engineHistory = engine.getState().history;
  assert.equal(engineHistory.length, 600);

  const chart = { data: { labels: [], datasets: [{ data: [] }, { data: [] }] }, update() {} };
  for (const windowSize of [30, 60, 120, 300]) {
    updateLiveSimulationChart(chart, engineHistory, windowSize);
    const visibleHistory = engineHistory.slice(-windowSize);
    assert.equal(chart.data.labels.length, windowSize);
    assert.deepEqual(chart.data.labels, visibleHistory.map((point) => point.tick));
    assert.deepEqual(chart.data.datasets[0].data, visibleHistory.map((point) => point.price));
    assert.deepEqual(chart.data.datasets[1].data, visibleHistory.map((point) => point.equity));
  }
  assert.equal(engine.getState().history.length, 600);
});
