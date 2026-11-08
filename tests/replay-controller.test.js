import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSeries } from '../src/data.js';
import { DEFAULT_STRATEGY, calculateStrategyBacktest, getReplayReadiness } from '../src/strategy-analysis.js';
import { createReplayController } from '../src/replay-controller.js';

function risingSeries(length) {
  return { period: '1Y', labels: Array.from({ length }, (_, index) => `S${index + 1}`), values: Array.from({ length }, (_, index) => 100 + index) };
}

test('replay readiness reports the exact required moving-average and volatility lookback', () => {
  const shortHistory = getReplayReadiness(generateSeries('1W', 1), DEFAULT_STRATEGY);
  const enoughMaHistory = getReplayReadiness(risingSeries(20), DEFAULT_STRATEGY);
  const volatilityPolicy = { ...DEFAULT_STRATEGY, type: 'volatility-filter', longWindow: 10, lookback: 30 };
  const shortVolatilityHistory = getReplayReadiness(risingSeries(20), volatilityPolicy);
  const enoughVolatilityHistory = getReplayReadiness(risingSeries(30), volatilityPolicy);

  assert.equal(shortHistory.available, false);
  assert.match(shortHistory.reason, /needs 20 observations.*has 7/);
  assert.equal(enoughMaHistory.available, true);
  assert.equal(shortVolatilityHistory.requiredObservations, 30);
  assert.equal(shortVolatilityHistory.available, false);
  assert.equal(enoughVolatilityHistory.available, true);
});

test('volatility-filter signals wait until its complete lookback exists', () => {
  const parameters = { ...DEFAULT_STRATEGY, type: 'volatility-filter', shortWindow: 2, longWindow: 5, lookback: 12 };
  const backtest = calculateStrategyBacktest(risingSeries(20), parameters);

  assert.ok(backtest.signals.slice(0, 11).every((signal) => signal === 'FLAT'));
  assert.ok(backtest.shortAverage[10] !== null);
  assert.ok(backtest.signals.slice(11).every((signal) => signal === 'LONG'));
});

test('replay supports play, pause, resume, seek, restart, and single-timer disposal', () => {
  const scheduled = [];
  const canceled = [];
  const steps = [];
  const controller = createReplayController({
    length: 5,
    firstPlayableIndex: 1,
    onStep: (index) => steps.push(index),
    schedule: (callback) => { const timer = { callback }; scheduled.push(timer); return timer; },
    cancel: (timer) => canceled.push(timer),
  });

  assert.deepEqual(controller.getState(), { index: 1, playing: false, available: true, firstPlayableIndex: 1 });
  assert.equal(controller.play(), true);
  assert.equal(controller.play(), true);
  assert.equal(scheduled.length, 1);
  scheduled[0].callback();
  assert.equal(controller.getState().index, 2);
  controller.pause();
  assert.deepEqual(canceled, [scheduled[0]]);
  assert.equal(controller.play(), true);
  assert.equal(scheduled.length, 2);
  scheduled[1].callback();
  assert.equal(controller.getState().index, 3);
  assert.equal(controller.seek(4), true);
  assert.equal(controller.getState().playing, false);
  assert.equal(controller.getState().index, 4);
  assert.equal(controller.previous(), true);
  assert.equal(controller.getState().index, 3);
  assert.equal(controller.next(), true);
  assert.equal(controller.getState().index, 4);
  assert.equal(controller.restart(), true);
  assert.equal(controller.getState().index, 1);
  controller.play();
  assert.equal(controller.dispose().available, false);
  assert.equal(controller.getState().playing, false);
  assert.deepEqual(steps, [1, 2, 3, 4, 3, 4, 1]);
});

test('playback automatically stops at the last available session', () => {
  let tick;
  let cancelCount = 0;
  const controller = createReplayController({
    length: 3,
    onStep() {},
    schedule: (callback) => { tick = callback; return 1; },
    cancel: () => { cancelCount += 1; },
  });

  controller.play();
  tick();
  assert.equal(controller.getState().index, 1);
  assert.equal(controller.getState().playing, true);
  tick();
  assert.equal(controller.getState().index, 2);
  assert.equal(controller.getState().playing, false);
  assert.equal(cancelCount, 1);
});

test('replay cannot start, seek, or advance without required history', () => {
  const controller = createReplayController({ length: 7, available: false, firstPlayableIndex: 19 });
  assert.equal(controller.getState().available, false);
  assert.equal(controller.play(), false);
  assert.equal(controller.seek(3), false);
  assert.equal(controller.getState().index, 0);
});
