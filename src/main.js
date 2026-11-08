import './style.css';
import { createHistoricalPriceChart, createLiveSimulationChart, createPriceChart, createReplayChart, LIVE_SIMULATION_HISTORY_WINDOWS, updateLiveSimulationChart, updatePriceChart, updateReplayChart } from './chart.js';
import { calculatePerformance, generateSeries, runMonteCarlo } from './data.js';
import { hydrateIcons } from './icons.js';
import {
  buildCoverage,
  calculateStrategyBacktest,
  classifyMarketScenario,
  DEFAULT_GUARDRAILS,
  DEFAULT_STRATEGY,
  evaluatePolicyDiagnostics,
  evaluateRiskGuardrails,
  evaluatePolicyState,
  getReplayReadiness,
  runParameterSweep,
  validateStrategyParameters,
} from './strategy-analysis.js';
import { createReplayController } from './replay-controller.js';
import { createSimulationController, createSyntheticSimulation } from './simulation-engine.js';

const STORAGE_KEY = 'quantx.midnight.experiments';
const STRATEGY_STORAGE_KEY = 'quantx.midnight.strategy';
const GUARDRAIL_STORAGE_KEY = 'quantx.midnight.guardrails';
const pageDetails = {
  overview: ['Overview', 'RESEARCH WORKSPACE'],
  markets: ['Markets', 'SIMULATED UNIVERSE'],
  strategies: ['Strategies', 'MODEL CATALOG'],
  backtesting: ['Backtesting', 'HISTORICAL SIMULATION'],
  'monte-carlo': ['Monte Carlo', 'SCENARIO ANALYSIS'],
  'research-lab': ['Research Lab', 'LOCAL EXPERIMENTS'],
  settings: ['Settings', 'WORKSPACE PREFERENCES'],
};
const marketPeriodLengths = { '1W': 7, '1M': 30, '3M': 90, '1Y': 252 };

let currentPage = 'overview';
let currentPeriod = '1M';
let simulationSeed = 126;
let strategyConfig = loadStoredObject(STRATEGY_STORAGE_KEY, DEFAULT_STRATEGY);
let guardrailThresholds = loadStoredObject(GUARDRAIL_STORAGE_KEY, DEFAULT_GUARDRAILS);
let currentSeries = generateSeries(currentPeriod, simulationSeed);
let liveSimulationEngine = createSyntheticSimulation({ seed: simulationSeed, strategy: strategyConfig });
let liveSimulationChart;
let liveSimulationController;
let liveSimulationHistoryWindow = 60;
let historicalMarketData = null;
let historicalMarketChart;
let historicalLoadState = 'idle';
let historicalLoadError = '';
let experiments = loadExperiments();
let latestBacktestSeries = experiments.find((experiment) => experiment.kind === 'backtest' && experiment.backtest.valid)?.series ?? null;
let policyState = evaluatePolicyState({ series: currentSeries, parameters: strategyConfig, thresholds: guardrailThresholds, backtestSeries: latestBacktestSeries });
let currentBacktest = policyState.currentBacktest;
let latestBacktest = policyState.latestBacktest;
let currentGuardrails = policyState.guardrails;
let currentDiagnostics = policyState.diagnostics;
let performanceChart;
let replayChart;
let replayIndex = 0;
let replayController;
let replayReadiness;
let toastTimeout;
let selectedExperimentId = null;

const overviewView = document.querySelector('#overview-view');
const secondaryView = document.querySelector('#secondary-view');
const sidebar = document.querySelector('#sidebar');
const sidebarToggle = document.querySelector('#sidebar-toggle');
const sidebarScrim = document.querySelector('#sidebar-scrim');
const toast = document.querySelector('#toast');

performanceChart = createPriceChart(document.querySelector('#price-chart'), currentSeries);
liveSimulationChart = createLiveSimulationChart(document.querySelector('#live-simulation-chart'), liveSimulationEngine.getState().history);
liveSimulationController = createSimulationController({
  engine: liveSimulationEngine,
  intervalMs: 1000,
  onUpdate: updateLiveSimulationUI,
  onState: updateLiveSimulationControls,
});
updateLiveSimulationUI(liveSimulationEngine.getState());
updateDashboard(currentSeries);
renderExperiments();
hydrateIcons();
window.addEventListener?.('pagehide', (event) => {
  if (event.persisted) return;
  liveSimulationController.dispose();
  liveSimulationChart.destroy();
  performanceChart.destroy();
  replayController?.dispose();
  replayChart?.destroy();
});
function loadStoredObject(key, defaults) {
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...defaults, ...stored } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

function loadExperiments() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(stored) ? stored.map(hydrateExperiment).filter(Boolean).slice(0, 12) : [];
  } catch {
    return [];
  }
}

function hydrateExperiment(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const seed = Number.isInteger(stored.seed) ? stored.seed : 126;
  const period = marketPeriodLengths[stored.period] ? stored.period : '1M';
  const strategy = stored.strategyConfig && typeof stored.strategyConfig === 'object'
    ? { ...DEFAULT_STRATEGY, ...stored.strategyConfig }
    : stored.strategy && typeof stored.strategy === 'object'
      ? { ...DEFAULT_STRATEGY, ...stored.strategy }
      : { ...strategyConfig };
  const series = generateSeries(period, seed);
  const backtest = calculateStrategyBacktest(series, strategy);
  const thresholds = stored.guardrailThresholds && typeof stored.guardrailThresholds === 'object'
    ? { ...DEFAULT_GUARDRAILS, ...stored.guardrailThresholds }
    : { ...guardrailThresholds };
  const guardrails = evaluateRiskGuardrails(backtest, thresholds);
  const diagnostics = evaluatePolicyDiagnostics(series, strategy, backtest, guardrails);
  const monteCarlo = stored.monteCarlo?.valid
    ? runMonteCarlo(stored.monteCarlo.scenarioCount, stored.monteCarlo.years, stored.monteCarlo.seed)
    : null;
  return {
    id: String(stored.id ?? `exp-${seed}-${stored.timestamp ?? Date.now()}`),
    name: String(stored.name ?? 'Recovered local experiment'),
    kind: ['backtest', 'monte-carlo', 'simulation'].includes(stored.kind) ? stored.kind : 'simulation',
    seed,
    period,
    timestamp: Number.isFinite(stored.timestamp) ? stored.timestamp : Date.now(),
    strategyName: String(stored.strategyName ?? (typeof stored.strategy === 'string' ? stored.strategy : getStrategyName(strategy.type))),
    strategyConfig: strategy,
    guardrailThresholds: thresholds,
    series,
    backtest,
    guardrails,
    diagnostics,
    monteCarlo: monteCarlo?.valid ? monteCarlo : null,
    status: deriveExperimentStatus(diagnostics, guardrails),
  };
}

function deriveExperimentStatus(diagnostics, guardrails) {
  if (diagnostics.status === 'FAIL' || guardrails.status === 'FAIL') return 'FAIL';
  if (diagnostics.status === 'WARNING' || guardrails.status === 'WARNING') return 'WARNING';
  return 'PASS';
}

function persistExperiments() {
  try {
    const saved = experiments.slice(0, 12).map((experiment) => ({
      id: experiment.id,
      name: experiment.name,
      kind: experiment.kind,
      seed: experiment.seed,
      period: experiment.period,
      timestamp: experiment.timestamp,
      strategyName: experiment.strategyName,
      strategyConfig: experiment.strategyConfig,
      guardrailThresholds: experiment.guardrailThresholds,
      monteCarlo: experiment.monteCarlo,
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    showToast('Browser storage is unavailable. This run will not persist.');
  }
}

function saveStrategyPreferences() {
  try { localStorage.setItem(STRATEGY_STORAGE_KEY, JSON.stringify(strategyConfig)); } catch { showToast('Strategy settings could not be saved in this browser.'); }
}

function saveGuardrailPreferences() {
  try { localStorage.setItem(GUARDRAIL_STORAGE_KEY, JSON.stringify(guardrailThresholds)); } catch { showToast('Risk thresholds could not be saved in this browser.'); }
}

function createExperimentRecord({ name, kind, series, strategy = strategyConfig, seed = simulationSeed, monteCarlo = null }) {
  const backtest = calculateStrategyBacktest(series, strategy);
  const guardrails = evaluateRiskGuardrails(backtest, guardrailThresholds);
  const diagnostics = evaluatePolicyDiagnostics(series, strategy, backtest, guardrails);
  return {
    id: `exp-${Date.now()}-${seed}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    kind,
    seed,
    period: series.period,
    timestamp: Date.now(),
    strategyName: getStrategyName(strategy.type),
    strategyConfig: { ...strategy },
    guardrailThresholds: { ...guardrailThresholds },
    series,
    backtest,
    guardrails,
    diagnostics,
    monteCarlo,
    status: deriveExperimentStatus(diagnostics, guardrails),
  };
}

function addExperiment(experiment) {
  experiments = [experiment, ...experiments].slice(0, 12);
  persistExperiments();
  renderExperiments();
}

function deleteExperiment(experimentId) {
  const deleted = experiments.find((experiment) => experiment.id === experimentId);
  if (!deleted) return;
  experiments = experiments.filter((experiment) => experiment.id !== experimentId);
  if (selectedExperimentId === experimentId) selectedExperimentId = experiments[0]?.id ?? null;
  if (deleted.kind === 'backtest' && latestBacktestSeries === deleted.series) {
    latestBacktestSeries = experiments.find((experiment) => experiment.kind === 'backtest' && experiment.backtest.valid)?.series ?? null;
    refreshPolicyState();
    updateDashboard(currentSeries);
    updateBacktestPanels();
  }
  persistExperiments();
  renderExperiments();
  refreshCoveragePanels();
  if (currentPage === 'research-lab') renderWorkspacePage('research-lab');
  showToast(`Deleted ${deleted.name}.`);
}

function getStrategyName(type) {
  return ({
    'moving-average': 'Moving-average crossover',
    'mean-reversion': 'Moving-average mean reversion',
    'volatility-filter': 'Volatility-filtered trend',
  })[type] ?? 'Unsupported strategy';
}

function updateDashboard(series) {
  const marketStats = calculatePerformance(series.values);
  const hasPolicyTrades = currentBacktest.valid && currentBacktest.exposures.some((exposure) => exposure > 0);
  const stats = hasPolicyTrades ? currentBacktest.metrics : null;
  document.querySelector('#asset-price').textContent = series.values.at(-1).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  setSignedValue('#daily-return', marketStats.dailyReturn, 2);
  document.querySelector('#annual-volatility').textContent = `${marketStats.annualizedVolatility.toFixed(1)}%`;
  setSignedValue('#total-return', stats?.totalReturn, 2);
  document.querySelector('#sharpe-ratio').textContent = stats ? stats.sharpeRatio.toFixed(2) : '\u2014';
  document.querySelector('#max-drawdown').textContent = stats ? `${stats.maxDrawdown.toFixed(2)}%` : '\u2014';
  document.querySelector('#win-rate').textContent = stats ? `${stats.winRate.toFixed(1)}%` : '\u2014';
  document.querySelector('#chart-range-label').textContent = `${marketPeriodLengths[currentPeriod]} SESSIONS`;
  updateOverviewSummaries();
}

function updateLiveSimulationUI(snapshot) {
  document.querySelector('#live-simulation-time').textContent = `T+${snapshot.tick}s`;
  document.querySelector('#live-simulation-price').textContent = snapshot.price.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  document.querySelector('#live-simulation-cash').textContent = `$${snapshot.cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.querySelector('#live-simulation-holdings').textContent = snapshot.holdings.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  document.querySelector('#live-simulation-equity').textContent = `$${snapshot.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const signal = document.querySelector('#live-simulation-signal');
  signal.textContent = snapshot.signal;
  signal.classList.toggle('is-positive', snapshot.signal === 'LONG');
  updateLiveSimulationChart(liveSimulationChart, snapshot.history, liveSimulationHistoryWindow);
  updateLiveSimulationControls(liveSimulationController?.getState() ?? { running: false, snapshot });
}

function updateLiveSimulationControls(state) {
  const start = document.querySelector('#live-simulation-start');
  const pause = document.querySelector('#live-simulation-pause');
  const reset = document.querySelector('#live-simulation-reset');
  const status = document.querySelector('#live-simulation-status');
  const running = Boolean(state.running);
  const tick = state.snapshot?.tick ?? 0;
  start.textContent = running ? 'Running' : tick > 0 ? 'Resume' : 'Start';
  start.disabled = running;
  pause.disabled = !running;
  reset.disabled = !running && tick === 0;
  status.textContent = running ? 'RUNNING' : 'PAUSED';
  status.classList.toggle('is-running', running);
}

function refreshPolicyState() {
  policyState = evaluatePolicyState({ series: currentSeries, parameters: strategyConfig, thresholds: guardrailThresholds, backtestSeries: latestBacktestSeries });
  currentBacktest = policyState.currentBacktest;
  latestBacktest = policyState.latestBacktest;
  currentGuardrails = policyState.guardrails;
  currentDiagnostics = policyState.diagnostics;
}

function updateOverviewSummaries() {
  updateStatusBadge('#overview-diagnostic-status', currentDiagnostics.status);
  updateStatusBadge('#overview-risk-status', currentGuardrails.status);
  document.querySelector('#overview-diagnostic-summary').innerHTML = currentDiagnostics.checks.slice(0, 3).map((check) => `
    <div class="summary-check"><span class="status-tag status-${check.status.toLowerCase()}">${check.status}</span><span>${escapeHTML(check.name)}</span></div>`).join('');
  document.querySelector('#overview-risk-summary').innerHTML = currentGuardrails.available
    ? currentGuardrails.checks.filter((check) => check.key).slice(0, 3).map((check) => `
      <div class="summary-check"><span class="status-tag status-${check.status.toLowerCase()}">${check.status}</span><span>${escapeHTML(check.name)}</span></div>`).join('')
    : `<div class="summary-empty">${escapeHTML(currentGuardrails.message)}</div>`;
}

function updateStatusBadge(selector, status) {
  const element = document.querySelector(selector);
  element.textContent = status;
  element.className = `diagnostic-status status-${status.toLowerCase()}`;
}

function setSignedValue(selector, value, digits) {
  const element = document.querySelector(selector);
  if (!Number.isFinite(value)) {
    element.textContent = '\u2014';
    return;
  }
  element.textContent = `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
  element.classList.toggle('is-negative', value < 0);
}

function renderExperiments() {
  const body = document.querySelector('#experiment-rows');
  if (!experiments.length) {
    body.innerHTML = '<tr><td class="empty-table" colspan="5">No saved experiments yet. Run a simulation or backtest to begin the local research log.</td></tr>';
    return;
  }
  body.innerHTML = experiments.slice(0, 4).map((experiment) => `
    <tr>
      <td><span class="experiment-name"><span class="experiment-glyph" data-icon="ChartNoAxesCombined"></span>${escapeHTML(experiment.name)}</span></td>
      <td class="muted-cell">${escapeHTML(experiment.strategyName)}</td>
      <td class="muted-cell">${formatRelativeTime(experiment.timestamp)}</td>
      <td><span class="status-pill status-${experiment.status.toLowerCase()}"><span></span>${escapeHTML(experiment.status)}</span></td>
      <td class="action-cell"><button class="row-action" type="button" data-open-experiment="${escapeHTML(experiment.id)}">Reopen</button></td>
    </tr>`).join('');
  hydrateIcons(body);
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function formatRelativeTime(timestamp) {
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return 'Just now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  return `${Math.floor(elapsedHours / 24)}d ago`;
}

function navigateTo(page) {
  if (!pageDetails[page]) return;
  if (page !== 'markets') {
    stopReplay();
    replayController?.dispose();
    replayController = null;
    replayChart?.destroy();
    replayChart = null;
    replayReadiness = null;
    historicalMarketChart?.destroy();
    historicalMarketChart = null;
  }
  currentPage = page;
  const [title, section] = pageDetails[page];
  document.querySelector('#topbar-title').textContent = title;
  document.querySelector('#breadcrumb').innerHTML = `QUANTX <span>/</span> ${section}`;
  overviewView.hidden = page !== 'overview';
  secondaryView.hidden = page === 'overview';
  document.querySelectorAll('.nav-link[data-page]').forEach((link) => {
    const active = link.dataset.page === page;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (page !== 'overview') renderWorkspacePage(page);
  closeSidebar();
}

function renderWorkspacePage(page) {
  if (page === 'markets') {
    stopReplay();
    replayController?.dispose();
    replayController = null;
    replayChart?.destroy();
    replayChart = null;
    historicalMarketChart?.destroy();
    historicalMarketChart = null;
  }
  const pageRenderers = {
    markets: renderMarketsPage,
    strategies: renderStrategiesPage,
    backtesting: renderBacktestingPage,
    'monte-carlo': renderMonteCarloPage,
    'research-lab': renderResearchPage,
    settings: renderSettingsPage,
  };
  secondaryView.innerHTML = pageRenderers[page]();
  hydrateIcons(secondaryView);
  if (page === 'markets') {
    initializeReplay();
    if (historicalMarketData) mountHistoricalMarketData();
    else renderHistoricalMarketState();
  }
}

function renderPageIntro(kicker, title, description, action = '') {
  return `<div class="workspace-intro"><div><p class="section-kicker">${kicker}</p><h2>${title}</h2><p class="welcome-copy">${description}</p></div>${action}</div>`;
}

function strategyDescription(type) {
  return ({
    'moving-average': { entry: 'Enter long when the short moving average crosses above the long moving average.', exit: 'Move to flat when the short moving average is at or below the long moving average.' },
    'mean-reversion': { entry: 'Enter long when price closes below the long moving average.', exit: 'Move to flat when price closes at or above the long moving average.' },
    'volatility-filter': { entry: 'Enter long when the short moving average is above the long average and annualized lookback volatility is below its sensitivity limit.', exit: 'Move to flat when trend or volatility conditions no longer qualify.' },
  })[type] ?? { entry: 'Unsupported strategy configuration.', exit: 'No signal is generated until the strategy is valid.' };
}

function periodOptions(selected) {
  return Object.entries(marketPeriodLengths).map(([period, length]) => `<option value="${period}" ${period === selected ? 'selected' : ''}>${period} / ${length} sessions</option>`).join('');
}

function thresholdField(id, key, label, value, minimum, maximum) {
  return `<label class="field-label" for="${id}">${label} (%)<input id="${id}" data-guardrail-key="${key}" type="number" min="${minimum}" max="${maximum}" step="0.1" value="${escapeHTML(value)}" /></label>`;
}

function renderDiagnosticsPanel(diagnostics, title, backtest = currentBacktest) {
  const hasTrades = backtest?.valid && backtest.exposures.some((exposure) => exposure > 0);
  const metrics = hasTrades
    ? `<div class="experiment-metric-grid diagnostics-metric-grid">${experimentMetric('Total return', backtest.metrics.totalReturn, '%')}${experimentMetric('Sharpe ratio', backtest.metrics.sharpeRatio, '')}${experimentMetric('Max drawdown', backtest.metrics.maxDrawdown, '%')}${experimentMetric('Volatility', backtest.metrics.annualizedVolatility, '%')}</div>`
    : `<p class="empty-state">${backtest?.valid ? 'No positions were generated; performance percentages are unavailable for this sample.' : 'Run a valid backtest to calculate performance diagnostics.'}</p>`;
  const source = backtest === latestBacktest && latestBacktest ? 'LATEST BACKTEST' : 'CURRENT SIMULATED SAMPLE';
  return `<section class="panel diagnostics-panel"><div class="panel-heading"><div><p class="section-kicker">POLICY DIAGNOSTICS / ${source}</p><h2>${escapeHTML(title)}</h2></div><span class="diagnostic-status status-${diagnostics.status.toLowerCase()}">${diagnostics.status}</span></div>${metrics}<div class="diagnostic-check-list">${diagnostics.checks.map((check) => `<div class="diagnostic-row"><span class="status-tag status-${check.status.toLowerCase()}">${check.status}</span><div><strong>${escapeHTML(check.name)}</strong><p>${escapeHTML(check.explanation)}</p></div></div>`).join('')}</div></section>`;
}

function renderGuardrailChecks(guardrails) {
  if (!guardrails.available) {
    const configFailures = guardrails.checks.filter((check) => check.status === 'FAIL').map((check) => `<div class="diagnostic-row"><span class="status-tag status-fail">FAIL</span><div><strong>${escapeHTML(check.name)}</strong><p>${escapeHTML(check.explanation)}</p></div></div>`).join('');
    return `<p class="empty-state">${escapeHTML(guardrails.message)}</p>${configFailures ? `<div class="diagnostic-check-list">${configFailures}</div>` : ''}`;
  }
  return `<div class="guardrail-check-list">${guardrails.checks.filter((check) => check.key).map((check) => `<div class="guardrail-row"><span class="status-tag status-${check.status.toLowerCase()}">${check.status}</span><span>${escapeHTML(check.name)}</span><strong>${escapeHTML(check.actual)} <small>/ ${escapeHTML(check.limit)}</small></strong><p>${escapeHTML(check.explanation)}</p></div>`).join('')}</div>`;
}

function renderGuardrailPanel(guardrails, title) {
  return `<section class="panel diagnostics-panel"><div class="panel-heading"><div><p class="section-kicker">SIMULATED RISK</p><h2>${escapeHTML(title)}</h2></div><span class="diagnostic-status status-${guardrails.status.toLowerCase()}">${guardrails.status}</span></div>${renderGuardrailChecks(guardrails)}</section>`;
}

function renderBacktestResults(backtest) {
  if (!backtest) return '<p class="empty-state">Run a backtest to calculate strategy performance.</p>';
  if (!backtest.valid || !backtest.metrics) return `<p class="empty-state">${escapeHTML(backtest.errors.join(' ')) || 'Run a valid backtest to calculate strategy performance.'}</p>`;
  if (!backtest.exposures.some((exposure) => exposure > 0)) return '<p class="empty-state">No positions were generated; performance percentages are unavailable for this run.</p>';
  const metrics = backtest.metrics;
  return `<div class="result-summary"><div><span>TOTAL RETURN</span><strong class="${metrics.totalReturn >= 0 ? 'is-positive' : 'is-negative'}">${metrics.totalReturn >= 0 ? '+' : ''}${metrics.totalReturn.toFixed(2)}%</strong></div><div><span>SHARPE RATIO</span><strong>${metrics.sharpeRatio.toFixed(2)}</strong></div><div><span>MAX DRAWDOWN</span><strong>${metrics.maxDrawdown.toFixed(2)}%</strong></div><div><span>WIN RATE</span><strong>${metrics.winRate.toFixed(1)}%</strong></div></div><p class="result-caption">${backtest.signals.filter((signal) => signal === 'LONG').length} active sessions / ${backtest.signals.length} observations. Positions take effect one session after a signal.</p>`;
}

function experimentMetric(label, value, suffix) {
  const formatted = Number.isFinite(value) ? `${value > 0 && suffix === '%' ? '+' : ''}${value.toFixed(2)}${suffix}` : 'Unavailable';
  return `<div><span>${escapeHTML(label)}</span><strong>${formatted}</strong></div>`;
}

function renderMonteCarloSummary(results, scenarioCount, years) {
  const drawdown = results.maximumDrawdown;
  return `<section class="monte-carlo-distribution"><p class="section-kicker">TERMINAL-RETURN DISTRIBUTION / ${scenarioCount.toLocaleString()} PATHS / ${years} YEARS</p><div class="result-summary"><div><span>MEDIAN RETURN</span><strong class="${results.median >= 0 ? 'is-positive' : 'is-negative'}">${results.median >= 0 ? '+' : ''}${results.median.toFixed(1)}%</strong></div><div><span>5TH PERCENTILE</span><strong>${results.lower.toFixed(1)}%</strong></div><div><span>95TH PERCENTILE</span><strong>${results.upper.toFixed(1)}%</strong></div><div><span>POSITIVE PATHS</span><strong>${results.positiveRate.toFixed(1)}%</strong></div></div></section><section class="monte-carlo-distribution drawdown-distribution"><p class="section-kicker">MAXIMUM DRAWDOWN DISTRIBUTION / PER-PATH PEAK-TO-TROUGH</p><div class="result-summary drawdown-result-summary"><div><span>MEDIAN MAX DRAWDOWN</span><strong>${drawdown.median.toFixed(2)}%</strong></div><div><span>5TH PERCENTILE</span><strong>${drawdown.fifthPercentile.toFixed(2)}%</strong></div><div><span>95TH PERCENTILE</span><strong>${drawdown.ninetyFifthPercentile.toFixed(2)}%</strong></div><div><span>WORST OBSERVED</span><strong>${drawdown.worst.toFixed(2)}%</strong></div><div><span>BEST OBSERVED</span><strong>${drawdown.best.toFixed(2)}%</strong></div></div><p class="result-caption">Drawdown is calculated from each path’s running equity peak. Higher drawdown percentages represent worse losses.</p></section>`;
}

function renderPolicyHeatmap(initialMetric) {
  const metricOptions = [
    ['sharpeRatio', 'Sharpe ratio'],
    ['totalReturn', 'Total return'],
    ['maxDrawdown', 'Maximum drawdown'],
    ['annualizedVolatility', 'Volatility'],
  ];
  const rows = [3, 5, 8, 10];
  const columns = [15, 20, 30, 50];
  const results = runParameterSweep(currentSeries, strategyConfig, rows, columns);
  const metric = metricOptions.some(([key]) => key === initialMetric) ? initialMetric : 'sharpeRatio';
  const values = results.map((result) => result.metrics[metric]).filter(Number.isFinite);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 0;
  const lowerIsBetter = metric === 'annualizedVolatility';
  const cells = results.map((result) => {
    const value = result.metrics[metric];
    const range = maximum - minimum;
    const normalized = range === 0 ? 0.5 : (value - minimum) / range;
    const quality = lowerIsBetter ? 1 - normalized : normalized;
    const metricName = metricOptions.find(([key]) => key === metric)?.[1] ?? metric;
    const tooltip = `Short MA ${result.parameters.shortWindow}, long MA ${result.parameters.longWindow}; ${metricName}: ${value.toFixed(2)}${metric === 'totalReturn' || metric === 'maxDrawdown' || metric === 'annualizedVolatility' ? '%' : ''}; return ${result.metrics.totalReturn.toFixed(2)}%; drawdown ${result.metrics.maxDrawdown.toFixed(2)}%; volatility ${result.metrics.annualizedVolatility.toFixed(2)}%.`;
    return { ...result, value, quality, tooltip };
  });
  const gridRows = rows.map((shortWindow) => `<tr><th scope="row">${shortWindow}</th>${columns.map((longWindow) => {
    const cell = cells.find((result) => result.parameters.shortWindow === shortWindow && result.parameters.longWindow === longWindow);
    return cell ? `<td><button class="heat-cell" type="button" data-action="apply-heatmap" data-short-window="${shortWindow}" data-long-window="${longWindow}" title="${escapeHTML(cell.tooltip)}" aria-label="${escapeHTML(cell.tooltip)}" style="--heat:${(0.12 + cell.quality * 0.4).toFixed(2)}">${cell.value.toFixed(2)}${metric === 'sharpeRatio' ? '' : '%'}</button></td>` : '<td><span class="heat-cell heat-cell-unavailable" aria-label="Invalid parameter combination">--</span></td>';
  }).join('')}</tr>`).join('');
  return `<section class="panel page-panel heatmap-panel"><div class="panel-heading"><div><p class="section-kicker">CALCULATED PARAMETER SWEEP / ${results.length} COMBINATIONS</p><h2>Policy heatmap</h2></div><label class="field-label heatmap-metric-label" for="heatmap-metric">Color by<select id="heatmap-metric">${metricOptions.map(([key, label]) => `<option value="${key}" ${metric === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
    <p class="panel-subtitle">Each cell is a backtest on the current simulated series. Select a cell to apply its moving-average pair.</p>
    ${results.length ? `<div class="heatmap-scroll"><table class="heatmap-table"><thead><tr><th scope="col">SHORT / LONG</th>${columns.map((value) => `<th scope="col">${value}</th>`).join('')}</tr></thead><tbody>${gridRows}</tbody></table></div><p class="heatmap-axis-label">LONG MOVING AVERAGE / SESSIONS</p><p class="table-note">Rows are short-window sessions. Hover or focus a cell for calculated return, drawdown, and volatility.</p>` : '<p class="empty-state">No valid parameter combinations for the current configuration. Review strategy parameters.</p>'}
    </section>`;
}

function renderCoverageMonitor(groupNames = null, title = 'Coverage monitor') {
  const coverage = buildCoverage(experiments);
  const groups = groupNames ? coverage.groups.filter((group) => groupNames.includes(group.name)) : coverage.groups;
  const visibleItems = groups.flatMap((group) => group.items);
  const testedCount = visibleItems.filter((item) => item.tested).length;
  const gaps = visibleItems.filter((item) => !item.tested);
  const groupMarkup = groups.map((group) => `<div class="coverage-group"><div class="coverage-group-heading"><h3>${escapeHTML(group.name)}</h3><span>${group.items.filter((item) => item.tested).length} / ${group.items.length} tested</span></div><div class="coverage-items">${group.items.map((item) => `<div class="coverage-item"><span class="status-tag ${item.tested ? 'status-pass' : 'status-gap'}">${item.tested ? 'TESTED' : 'GAP'}</span><span>${escapeHTML(item.name)}</span><small>${item.count ? `${item.count} run${item.count === 1 ? '' : 's'}` : 'No saved run'}</small></div>`).join('')}</div></div>`).join('');
  const coverageGroups = groupNames ? groupNames.join('|') : 'all';
  return `<section class="panel page-panel coverage-panel" data-coverage-groups="${coverageGroups}" data-coverage-title="${escapeHTML(title)}"><div class="panel-heading"><div><p class="section-kicker">OBSERVED LOCAL RUNS</p><h2>${escapeHTML(title)}</h2></div><span class="coverage-count">${testedCount} / ${visibleItems.length} categories tested</span></div><div class="coverage-groups">${groupMarkup}</div><div class="coverage-gap-note"><strong>${gaps.length ? `${gaps.length} coverage gaps` : 'No gaps in these categories'}</strong><span>${gaps.length ? `Untested: ${gaps.map((item) => escapeHTML(item.name)).join(', ')}.` : 'Every displayed category has at least one saved run.'}</span></div>${testedCount === 0 ? '<p class="table-note">Coverage remains untested until a local backtest or Monte Carlo run is saved. No coverage percentages are estimated.</p>' : '<p class="table-note">Coverage counts use saved local experiments and completed synthetic runs only. No percentages are extrapolated.</p>'}</section>`;
}

function renderMarketsPage() {
  return `${renderPageIntro('MARKET RESEARCH', 'Historical data & replay', 'Real historical observations and synthetic replay are presented separately.')}
    ${renderHistoricalMarketPanel()}
    <section class="panel replay-panel" aria-labelledby="replay-title">
      <div class="panel-heading"><div><p class="section-kicker">${escapeHTML(currentPeriod)} / SYNTHETIC MARKET DATA</p><h2 id="replay-title">Session replay</h2></div><span class="sim-tag">SIMULATED</span></div>
      <div class="replay-metrics"><div><span>SESSION</span><strong id="replay-session">--</strong></div><div><span>ASSET PRICE</span><strong id="replay-price">--</strong></div><div><span>MA (${strategyConfig.shortWindow}) / MA (${strategyConfig.longWindow})</span><strong id="replay-averages">--</strong></div><div><span>STRATEGY SIGNAL</span><strong id="replay-signal">--</strong></div><div><span>PORTFOLIO VALUE</span><strong id="replay-portfolio">--</strong></div></div>
      <div class="replay-chart-frame"><canvas id="replay-chart" role="img" aria-label="Portfolio value as the simulated market replay advances"></canvas></div>
      <p class="empty-state replay-unavailable" id="replay-unavailable" hidden></p>
      <div class="replay-controls"><button class="icon-button replay-control" type="button" data-action="replay-prev" aria-label="Previous session" title="Previous session"><span data-icon="StepBack"></span></button><button class="primary-button replay-play" id="replay-play" type="button" data-action="replay-play"><span data-icon="Play"></span> Play</button><button class="icon-button replay-control" type="button" data-action="replay-next" aria-label="Next session" title="Next session"><span data-icon="StepForward"></span></button><button class="secondary-button replay-reset" type="button" data-action="replay-reset">Restart</button><label class="replay-slider-label" for="replay-slider">TIMELINE</label><input id="replay-slider" type="range" min="0" max="${Math.max(0, currentSeries.values.length - 1)}" value="0" aria-label="Replay session" /><span id="replay-step-count" class="replay-step-count">1 / ${currentSeries.values.length}</span></div>
      <p class="table-note">Replay uses the same deterministic price series and next-session strategy positions as the backtest. Portfolio values are simulated.</p>
    </section>
    ${renderCoverageMonitor(['Market scenarios', 'Volatility regimes'], 'Scenario coverage')}
    <p class="disclaimer-line"><span class="status-pulse"></span>Market series and replay values are synthetic. No live market feed is connected.</p>`;
}

function renderHistoricalMarketPanel() {
  return `<section class="panel page-panel historical-market-panel" aria-labelledby="historical-market-title">
    <div class="panel-heading"><div><p class="section-kicker">ALPHA VANTAGE / DAILY / RAW</p><h2 id="historical-market-title">AAPL historical prices</h2></div><div class="historical-status-line"><span class="historical-badge" id="historical-market-status">NOT LOADED</span><button class="secondary-button" id="historical-market-load" type="button" data-action="load-historical-data">Load AAPL history</button></div></div>
    <p class="panel-subtitle historical-disclaimer">Historical daily OHLCV is real provider data when available. It is not mixed with the synthetic simulation.</p>
    <p class="form-error" id="historical-market-error" aria-live="polite"></p>
    <div id="historical-market-content" hidden>
      <div class="historical-metadata"><span>SYMBOL <strong id="historical-symbol">AAPL</strong></span><span>PROVIDER <strong id="historical-provider">Alpha Vantage</strong></span><span>FREQUENCY <strong>1D</strong></span><span>ADJUSTMENT <strong>RAW / UNADJUSTED</strong></span><span>EXCHANGE <strong id="historical-exchange">Not provided</strong></span><span>CURRENCY <strong id="historical-currency">Not provided</strong></span><span>UPDATED <strong id="historical-updated">--</strong></span></div>
      <div class="historical-chart-frame"><canvas id="historical-price-chart" role="img" aria-label="AAPL historical daily raw closing prices from Alpha Vantage"></canvas></div>
      <div class="table-scroll historical-table-scroll"><table class="workspace-table historical-table"><thead><tr><th>DATE</th><th>OPEN</th><th>HIGH</th><th>LOW</th><th>CLOSE</th><th>VOLUME</th><th>FREQUENCY</th><th>ADJUSTMENT</th></tr></thead><tbody id="historical-observations"></tbody></table></div>
    </div>
    <p class="historical-load-message" id="historical-market-message">No historical response loaded. Configure the key on the server to request AAPL daily data.</p>
  </section>`;
}

function renderHistoricalMarketState() {
  const status = document.querySelector('#historical-market-status');
  const error = document.querySelector('#historical-market-error');
  const button = document.querySelector('#historical-market-load');
  const message = document.querySelector('#historical-market-message');
  if (!status || !button || !message) return;
  status.textContent = historicalLoadState === 'loading' ? 'LOADING' : historicalMarketData ? 'HISTORICAL' : historicalLoadState === 'unavailable' ? 'UNAVAILABLE' : historicalLoadState === 'error' ? 'ERROR' : 'NOT LOADED';
  status.className = `historical-badge${historicalMarketData ? ' status-pass' : ''}`;
  button.disabled = historicalLoadState === 'loading';
  button.textContent = historicalMarketData ? 'Refresh AAPL history' : 'Load AAPL history';
  message.hidden = Boolean(historicalMarketData) || historicalLoadState === 'loading';
  message.textContent = historicalLoadError || 'No historical response loaded. Configure the key on the server to request AAPL daily data.';
  if (error) error.textContent = historicalLoadState === 'loading' ? 'Requesting AAPL daily data from the server-side provider proxy.' : historicalLoadError;
  const content = document.querySelector('#historical-market-content');
  if (content) content.hidden = !historicalMarketData;
}

function mountHistoricalMarketData() {
  if (!historicalMarketData || currentPage !== 'markets') return;
  const { data, lastUpdated } = historicalMarketData;
  document.querySelector('#historical-symbol').textContent = data.symbol;
  document.querySelector('#historical-provider').textContent = 'Alpha Vantage';
  document.querySelector('#historical-exchange').textContent = data.exchange ?? 'Not provided by daily endpoint';
  document.querySelector('#historical-currency').textContent = data.currency ?? 'Not provided by daily endpoint';
  document.querySelector('#historical-updated').textContent = new Date(lastUpdated).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  document.querySelector('#historical-observations').innerHTML = [...data.observations].reverse().map((observation) => `
    <tr><td>${escapeHTML(observation.date)}</td><td>${observation.open.toFixed(2)}</td><td>${observation.high.toFixed(2)}</td><td>${observation.low.toFixed(2)}</td><td>${observation.close.toFixed(2)}</td><td>${observation.volume.toLocaleString('en-US')}</td><td>1d</td><td>Raw</td></tr>`).join('');
  historicalMarketChart?.destroy();
  historicalMarketChart = createHistoricalPriceChart(document.querySelector('#historical-price-chart'), data.observations);
  renderHistoricalMarketState();
}

async function loadHistoricalMarketData() {
  if (historicalLoadState === 'loading') return;
  historicalLoadState = 'loading';
  historicalLoadError = '';
  renderHistoricalMarketState();
  try {
    const response = await fetch('/api/market-data/daily?symbol=AAPL', { headers: { Accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok) {
      historicalLoadState = payload.status === 'unavailable' ? 'unavailable' : 'error';
      throw new Error(payload.message || `Historical request failed (${response.status}).`);
    }
    if (payload.status !== 'historical' || payload.data?.symbol !== 'AAPL' || !Array.isArray(payload.data.observations) || !payload.data.observations.length) {
      historicalLoadState = 'error';
      throw new Error('The server returned no valid AAPL daily observations.');
    }
    historicalMarketData = payload;
    historicalLoadState = 'historical';
    historicalLoadError = '';
    mountHistoricalMarketData();
  } catch (error) {
    if (historicalLoadState !== 'unavailable') historicalLoadState = 'error';
    historicalLoadError = error.message || 'Could not load historical AAPL data.';
    renderHistoricalMarketState();
  }
}

function renderStrategiesPage() {
  return `${renderPageIntro('MODEL CONFIGURATION', 'Strategy attributes', 'Inspect the selected policy and adjust supported parameters for local simulation.')}
    <section class="panel page-panel strategy-attributes-panel"><div class="panel-heading"><div><p class="section-kicker">ACTIVE POLICY</p><h2 id="strategy-page-title">${escapeHTML(getStrategyName(strategyConfig.type))}</h2></div><span id="strategy-page-status" class="diagnostic-status status-${currentDiagnostics.status.toLowerCase()}">${currentDiagnostics.status}</span></div>
      <div class="strategy-detail-grid"><div class="strategy-description"><p class="attribute-label">STRATEGY TYPE</p><strong id="strategy-type-name">${escapeHTML(getStrategyName(strategyConfig.type))}</strong><p id="strategy-entry-description">${escapeHTML(strategyDescription(strategyConfig.type).entry)}</p><p id="strategy-exit-description">${escapeHTML(strategyDescription(strategyConfig.type).exit)}</p><div class="assumptions-block"><span class="attribute-label">ASSUMPTIONS & LIMITATIONS</span><p>Signals use closing prices and take effect on the following session. The model excludes fees, slippage, liquidity constraints, and short positions.</p></div></div>
        <form class="parameter-form" id="strategy-parameter-form" novalidate><label class="field-label" for="strategy-type">Strategy type<select id="strategy-type" data-policy-param><option value="moving-average" ${strategyConfig.type === 'moving-average' ? 'selected' : ''}>Moving-average crossover</option><option value="mean-reversion" ${strategyConfig.type === 'mean-reversion' ? 'selected' : ''}>Moving-average mean reversion</option><option value="volatility-filter" ${strategyConfig.type === 'volatility-filter' ? 'selected' : ''}>Volatility-filtered trend</option></select></label>
          <div class="parameter-fields"><label class="field-label" for="short-window">Short MA<input id="short-window" data-policy-param type="number" min="2" max="30" step="1" value="${escapeHTML(strategyConfig.shortWindow)}" /></label><label class="field-label" for="long-window">Long MA<input id="long-window" data-policy-param type="number" min="5" max="120" step="1" value="${escapeHTML(strategyConfig.longWindow)}" /></label><label class="field-label" for="strategy-lookback">Lookback<input id="strategy-lookback" data-policy-param type="number" min="5" max="252" step="1" value="${escapeHTML(strategyConfig.lookback)}" /></label><label class="field-label" for="volatility-sensitivity">Volatility sensitivity<input id="volatility-sensitivity" data-policy-param type="number" min="0.5" max="3" step="0.1" value="${escapeHTML(strategyConfig.volatilitySensitivity)}" /></label></div>
          <p class="form-error" id="strategy-config-error" aria-live="polite"></p><button class="primary-button" type="submit"><span data-icon="SlidersHorizontal"></span> Apply parameters</button>
        </form></div>
      <div class="strategy-specs"><div><span class="attribute-label">ENTRY</span><p id="strategy-spec-entry">${escapeHTML(strategyDescription(strategyConfig.type).entry)}</p></div><div><span class="attribute-label">EXIT</span><p id="strategy-spec-exit">${escapeHTML(strategyDescription(strategyConfig.type).exit)}</p></div><div><span class="attribute-label">TRADING FREQUENCY</span><p>Signals evaluated once per synthetic session; position changes apply next session.</p></div><div><span class="attribute-label">LOOKBACK</span><p id="strategy-spec-lookback">${strategyConfig.lookback} sessions, with MA windows ${strategyConfig.shortWindow} / ${strategyConfig.longWindow}.</p></div></div>
    </section>
    <div id="strategy-diagnostics">${renderDiagnosticsPanel(currentDiagnostics, 'Strategy diagnostics', latestBacktest ?? currentBacktest)}</div>
    <p class="disclaimer-line"><span class="status-pulse"></span>Strategy outputs are simulated and are not investment recommendations.</p>`;
}

function renderBacktestingPage() {
  return `${renderPageIntro('HISTORICAL SIMULATION', 'Backtest & policy review', 'Run the selected strategy against a reproducible synthetic price history.')}
    <section class="panel page-panel"><div class="panel-heading"><div><p class="section-kicker">RUN PARAMETERS</p><h2>Simulation setup</h2></div><span class="sim-tag">SIMULATED DATA</span></div>
      <div class="form-grid"><label class="field-label" for="backtest-period">Backtest period<select id="backtest-period">${periodOptions(currentPeriod)}</select></label><label class="field-label" for="backtest-seed">Deterministic seed<input id="backtest-seed" type="number" min="0" step="1" value="${simulationSeed}" /></label><div class="field-action"><button class="primary-button" type="button" data-action="run-backtest"><span data-icon="Activity"></span> Run backtest</button></div></div>
      <p class="panel-subtitle active-strategy-label">Active strategy: <strong>${escapeHTML(getStrategyName(strategyConfig.type))}</strong> / MA ${strategyConfig.shortWindow} - ${strategyConfig.longWindow}</p><p class="form-error" id="backtest-run-error" aria-live="polite"></p>
      <div class="result-block" id="backtest-results">${renderBacktestResults(latestBacktest)}</div>
    </section>
    <section class="panel page-panel guardrail-config-panel"><div class="panel-heading"><div><p class="section-kicker">SIMULATED RISK LIMITS</p><h2>Risk guardrails</h2></div><span id="backtest-risk-status" class="diagnostic-status status-${currentGuardrails.status.toLowerCase()}">${currentGuardrails.status}</span></div>
      <p class="disclaimer-line">These limits evaluate synthetic backtests only. They do not protect real investments.</p>
      <div class="threshold-grid">${thresholdField('risk-max-drawdown', 'maxDrawdown', 'Maximum drawdown', guardrailThresholds.maxDrawdown, 0.1, 100)}${thresholdField('risk-max-volatility', 'maxVolatility', 'Annualized volatility', guardrailThresholds.maxVolatility, 0.1, 300)}${thresholdField('risk-max-exposure', 'maxExposure', 'Maximum position exposure', guardrailThresholds.maxExposure, 0.1, 100)}${thresholdField('risk-loss-limit', 'lossLimit', 'Single-session loss limit', guardrailThresholds.lossLimit, 0.1, 100)}</div>
      <p class="form-error" id="guardrail-config-error" aria-live="polite"></p><button class="secondary-button" type="button" data-action="save-guardrails">Save thresholds</button><div id="backtest-guardrail-results" class="guardrail-results">${renderGuardrailChecks(currentGuardrails)}</div>
    </section>
    <section id="backtest-diagnostics">${renderDiagnosticsPanel(currentDiagnostics, 'Policy diagnostics', latestBacktest ?? currentBacktest)}</section>`;
}

function renderMonteCarloPage() {
  return `${renderPageIntro('SCENARIO ANALYSIS', 'Monte Carlo & policy heatmap', 'Explore deterministic scenario samples and compare calculated strategy parameter combinations.')}
    <section class="panel page-panel"><div class="panel-heading"><div><p class="section-kicker">PORTFOLIO OUTCOME MODEL</p><h2>Monte Carlo simulation</h2></div><span class="sim-tag">SIMULATED</span></div>
      <div class="form-grid"><label class="field-label" for="scenario-count">Number of scenarios<input id="scenario-count" type="number" min="100" max="10000" step="100" value="1000" /></label><label class="field-label" for="scenario-horizon">Horizon<select id="scenario-horizon"><option value="1">1 year</option><option value="3">3 years</option><option value="5">5 years</option></select></label><div class="field-action"><button class="primary-button" type="button" data-action="run-monte-carlo"><span data-icon="Database"></span> Run scenarios</button></div></div>
      <p class="form-error" id="monte-carlo-error" aria-live="polite"></p><div class="result-block" id="monte-carlo-results"><p class="empty-state">Run 100-10,000 scenarios over a 1-5 year horizon to calculate a synthetic outcome range.</p></div>
    </section>
    ${renderPolicyHeatmap('sharpeRatio')}
    ${renderCoverageMonitor(['Monte Carlo scenarios'], 'Monte Carlo coverage')}
    <p class="disclaimer-line"><span class="status-pulse"></span>Scenario outputs are synthetic and are not forecasts.</p>`;
}

function renderResearchPage() {
  const selected = experiments.find((experiment) => experiment.id === selectedExperimentId) ?? experiments[0] ?? null;
  selectedExperimentId = selected?.id ?? null;
  const experimentRows = experiments.length ? experiments.map((experiment) => `
    <tr><td><span class="experiment-name"><span class="experiment-glyph" data-icon="ChartNoAxesCombined"></span>${escapeHTML(experiment.name)}</span></td><td>${escapeHTML(experiment.strategyName)}</td><td>${escapeHTML(experiment.kind.replace('-', ' '))}</td><td>${formatRelativeTime(experiment.timestamp)}</td><td><span class="status-tag status-${experiment.status.toLowerCase()}">${experiment.status}</span></td><td class="action-cell"><button class="row-action" type="button" data-open-experiment="${escapeHTML(experiment.id)}">Reopen</button><button class="row-action" type="button" data-delete-experiment="${escapeHTML(experiment.id)}">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="6" class="empty-table">No local runs yet. Run a backtest or Monte Carlo simulation to populate analysis and coverage.</td></tr>';
  const selectedHasTrades = selected?.backtest.valid && selected.backtest.exposures.some((exposure) => exposure > 0);
  const analysis = selected ? `<div class="experiment-analysis-controls"><label class="field-label" for="experiment-selection">Selected run<select id="experiment-selection">${experiments.map((experiment) => `<option value="${escapeHTML(experiment.id)}" ${experiment.id === selected.id ? 'selected' : ''}>${escapeHTML(experiment.name)}</option>`).join('')}</select></label><span class="status-tag status-${selected.status.toLowerCase()}">${selected.status}</span></div>${selectedHasTrades ? `<div class="experiment-metric-grid">${experimentMetric('Total return', selected.backtest.metrics.totalReturn, '%')}${experimentMetric('Sharpe ratio', selected.backtest.metrics.sharpeRatio, '')}${experimentMetric('Max drawdown', selected.backtest.metrics.maxDrawdown, '%')}${experimentMetric('Volatility', selected.backtest.metrics.annualizedVolatility, '%')}</div>` : '<p class="empty-state">No positions were generated; performance percentages are unavailable for this run.</p>'}<div class="analysis-grid research-review-grid">${renderDiagnosticsPanel(selected.diagnostics, 'Run diagnostics', selected.backtest)}${renderGuardrailPanel(selected.guardrails, 'Run guardrails')}</div>${selected.monteCarlo?.valid ? `<div class="monte-carlo-distribution"><p class="section-kicker">MONTE CARLO / ${selected.monteCarlo.scenarioCount.toLocaleString()} PATHS</p><p class="result-caption">Terminal-return median ${selected.monteCarlo.median.toFixed(2)}%; maximum-drawdown median ${selected.monteCarlo.maximumDrawdown.median.toFixed(2)}%, 95th percentile ${selected.monteCarlo.maximumDrawdown.ninetyFifthPercentile.toFixed(2)}%. Higher drawdown percentages are worse.</p></div>` : ''}` : '<p class="empty-state">Select a saved run to inspect its calculated diagnostics and guardrails.</p>';
  return `${renderPageIntro('LOCAL EXPERIMENTS', 'Research lab', 'Review reproducible runs, calculated diagnostics, simulated risk, and measured coverage.', '<button class="primary-button" type="button" data-action="new-experiment"><span data-icon="ChartNoAxesCombined"></span> Run experiment</button>')}
    <section class="panel page-panel"><div class="panel-heading"><div><p class="section-kicker">EXPERIMENT HISTORY / ${experiments.length}</p><h2>Saved local runs</h2></div><span class="sim-tag">LOCAL STORAGE</span></div>
      <div class="table-scroll"><table class="workspace-table research-table"><thead><tr><th>EXPERIMENT</th><th>STRATEGY</th><th>RUN TYPE</th><th>RUN TIME</th><th>STATUS</th><th></th></tr></thead><tbody>${experimentRows}</tbody></table></div><p class="table-note">Metrics and status are recalculated from deterministic synthetic inputs. Clearing browser storage removes this log.</p>
    </section>
    <section class="panel page-panel experiment-analysis-panel"><div class="panel-heading"><div><p class="section-kicker">CALCULATED RESULTS</p><h2>Experiment analysis</h2></div></div>${analysis}</section>
    ${renderPolicyHeatmap('sharpeRatio')}
    ${renderCoverageMonitor(null, 'Research coverage')}`;
}

function renderSettingsPage() {
  const raised = document.documentElement.dataset.contrast === 'raised';
  return `${renderPageIntro('WORKSPACE PREFERENCES', 'Settings', 'Adjust the local research interface. No account or remote service is connected.')}
    <section class="panel page-panel settings-panel"><div class="panel-heading"><div><p class="section-kicker">DISPLAY</p><h2>Interface preferences</h2></div><span class="panel-index">03</span></div>
      <div class="setting-row"><div><h3>Higher contrast</h3><p>Increase separation between panels, labels, and borders.</p></div><button class="setting-switch ${raised ? 'is-on' : ''}" type="button" data-action="toggle-contrast" role="switch" aria-checked="${raised}" aria-label="Toggle higher contrast"><span></span></button></div>
      <div class="setting-row"><div><h3>Simulation data</h3><p>All prices, returns, and experiment outputs are generated locally.</p></div><span class="setting-value">LOCAL ONLY</span></div>
      <div class="setting-row"><div><h3>Experiment storage</h3><p>Saved runs are held in this browser's local storage.</p></div><span class="setting-value">${experiments.length} SAVED</span></div>
    </section>`;
}

function runNewSimulation({ save = true, seed = null, kind = 'simulation', name = null } = {}) {
  simulationSeed = seed ?? simulationSeed + 1;
  currentSeries = generateSeries(currentPeriod, simulationSeed);
  refreshPolicyState();
  updatePriceChart(performanceChart, currentSeries);
  updateDashboard(currentSeries);
  if (save) {
    addExperiment(createExperimentRecord({
      name: name ?? `SPX ${kind === 'backtest' ? 'backtest' : 'simulation'} ${String(simulationSeed).padStart(3, '0')}`,
      kind,
      series: currentSeries,
    }));
  }
  return currentSeries;
}

function openExperiment(experimentId) {
  const experiment = experiments.find((item) => item.id === experimentId);
  if (!experiment) return;
  stopReplay();
  strategyConfig = { ...experiment.strategyConfig };
  liveSimulationController.setStrategy(strategyConfig);
  guardrailThresholds = { ...experiment.guardrailThresholds };
  if (experiment.kind === 'backtest') latestBacktestSeries = experiment.series;
  currentPeriod = experiment.period;
  simulationSeed = experiment.seed;
  currentSeries = generateSeries(currentPeriod, simulationSeed);
  refreshPolicyState();
  updatePriceChart(performanceChart, currentSeries);
  updatePeriodButtons();
  updateDashboard(currentSeries);
  navigateTo('overview');
  showToast(`Reopened ${experiment.name}`);
}

function initializeReplay() {
  replayReadiness = getReplayReadiness(currentSeries, strategyConfig);
  replayChart = createReplayChart(document.querySelector('#replay-chart'), currentSeries, currentBacktest, replayIndex);
  const slider = document.querySelector('#replay-slider');
  slider.min = String(replayReadiness.firstPlayableIndex);
  slider.disabled = !replayReadiness.available;
  const unavailableMessage = document.querySelector('#replay-unavailable');
  unavailableMessage.hidden = replayReadiness.available;
  unavailableMessage.textContent = replayReadiness.reason;
  replayController = createReplayController({
    length: currentSeries.values.length,
    available: replayReadiness.available,
    firstPlayableIndex: replayReadiness.firstPlayableIndex,
    onStep: updateReplayStep,
    onState: (state) => setReplayButton(state.playing),
    schedule: (callback, delay) => window.setInterval(callback, delay),
    cancel: (timer) => window.clearInterval(timer),
  });
  setReplayButton(false);
  updateReplayControls();
}

function updateReplayStep(index) {
  if (!currentSeries.values.length) return;
  replayIndex = Math.max(0, Math.min(currentSeries.values.length - 1, index));
  const price = currentSeries.values[replayIndex];
  const shortAverage = currentBacktest.shortAverage[replayIndex];
  const longAverage = currentBacktest.longAverage[replayIndex];
  document.querySelector('#replay-session').textContent = currentSeries.labels[replayIndex] ?? `Session ${replayIndex + 1}`;
  document.querySelector('#replay-price').textContent = price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  document.querySelector('#replay-averages').textContent = shortAverage === null || longAverage === null
    ? 'Insufficient lookback'
    : `${shortAverage.toFixed(2)} / ${longAverage.toFixed(2)}`;
  document.querySelector('#replay-signal').textContent = currentBacktest.signals[replayIndex] ?? 'Unavailable';
  document.querySelector('#replay-signal').className = currentBacktest.signals[replayIndex] === 'LONG' ? 'signal-long' : 'signal-flat';
  document.querySelector('#replay-portfolio').textContent = currentBacktest.equityCurve[replayIndex]
    ? `$${currentBacktest.equityCurve[replayIndex].toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : 'Unavailable';
  document.querySelector('#replay-slider').value = String(replayIndex);
  document.querySelector('#replay-step-count').textContent = `${replayIndex + 1} / ${currentSeries.values.length}`;
  updateReplayControls();
  if (replayChart) updateReplayChart(replayChart, currentSeries, currentBacktest, replayIndex);
}

function stopReplay() {
  replayController?.pause();
  setReplayButton(false);
}

function toggleReplay() {
  if (!replayController) return;
  const playing = replayController.getState().playing;
  if (playing) replayController.pause();
  else replayController.play();
  setReplayButton(!playing && replayController.getState().playing);
}

function updateReplayControls() {
  if (!replayController || !replayReadiness) return;
  const { index, available } = replayController.getState();
  document.querySelector('[data-action="replay-prev"]').disabled = !available || index <= replayReadiness.firstPlayableIndex;
  document.querySelector('[data-action="replay-next"]').disabled = !available || index >= currentSeries.values.length - 1;
  document.querySelector('[data-action="replay-reset"]').disabled = !available;
  document.querySelector('#replay-play').disabled = !available;
}

function setReplayButton(playing) {
  const button = document.querySelector('#replay-play');
  if (!button) return;
  button.innerHTML = `<span data-icon="${playing ? 'Pause' : 'Play'}"></span> ${playing ? 'Pause' : 'Play'}`;
  hydrateIcons(button);
  button.setAttribute('aria-label', playing ? 'Pause replay' : 'Play replay');
  if (replayReadiness) button.disabled = !replayReadiness.available;
}

function updatePeriodButtons() {
  document.querySelectorAll('.period-button').forEach((button) => {
    const active = button.dataset.period === currentPeriod;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function runBacktest() {
  const period = document.querySelector('#backtest-period').value;
  const seedValue = Number(document.querySelector('#backtest-seed').value);
  const error = document.querySelector('#backtest-run-error');
  const validation = validateStrategyParameters(strategyConfig);
  if (!marketPeriodLengths[period] || !Number.isInteger(seedValue) || seedValue < 0 || !validation.valid) {
    error.textContent = !marketPeriodLengths[period]
      ? 'Choose a supported backtest period.'
      : !Number.isInteger(seedValue) || seedValue < 0
        ? 'The deterministic seed must be a non-negative whole number.'
        : validation.errors.join(' ');
    showToast('Backtest not run. Review the configuration.');
    return;
  }

  error.textContent = '';
  currentPeriod = period;
  simulationSeed = seedValue;
  currentSeries = generateSeries(period, seedValue);
  latestBacktestSeries = currentSeries;
  refreshPolicyState();
  updatePriceChart(performanceChart, currentSeries);
  updatePeriodButtons();
  updateDashboard(currentSeries);
  updateBacktestPanels();
  const record = createExperimentRecord({ name: `${getStrategyName(strategyConfig.type)} / ${period}`, kind: 'backtest', series: currentSeries, seed: seedValue });
  addExperiment(record);
  refreshCoveragePanels();
  showToast(record.status === 'FAIL' ? 'Backtest finished with a risk or policy failure.' : `Backtest calculated: ${record.status}.`);
  if (record.guardrails.status === 'FAIL') showToast(`Risk guardrail breach: ${record.guardrails.checks.filter((check) => check.status === 'FAIL' && check.key).map((check) => check.name).join(', ')}.`);
}

function updateBacktestPanels() {
  const resultElement = document.querySelector('#backtest-results');
  const guardrailElement = document.querySelector('#backtest-guardrail-results');
  const diagnosticElement = document.querySelector('#backtest-diagnostics');
  const statusElement = document.querySelector('#backtest-risk-status');
  if (resultElement) resultElement.innerHTML = renderBacktestResults(latestBacktest);
  if (guardrailElement) guardrailElement.innerHTML = renderGuardrailChecks(currentGuardrails);
  if (diagnosticElement) diagnosticElement.innerHTML = renderDiagnosticsPanel(currentDiagnostics, 'Policy diagnostics', latestBacktest ?? currentBacktest);
  if (statusElement) updateStatusBadge('#backtest-risk-status', currentGuardrails.status);
}

function readStrategyInputs() {
  const readNumber = (selector) => {
    const value = document.querySelector(selector).value;
    return value.trim() === '' ? Number.NaN : Number(value);
  };
  return {
    type: document.querySelector('#strategy-type').value,
    shortWindow: readNumber('#short-window'),
    longWindow: readNumber('#long-window'),
    lookback: readNumber('#strategy-lookback'),
    volatilitySensitivity: readNumber('#volatility-sensitivity'),
  };
}

function updateStrategyProfile(validation) {
  const name = getStrategyName(strategyConfig.type);
  const description = strategyDescription(strategyConfig.type);
  const title = document.querySelector('#strategy-page-title');
  const status = document.querySelector('#strategy-page-status');
  if (title) title.textContent = name;
  if (status) updateStatusBadge('#strategy-page-status', currentDiagnostics.status);
  const fields = [
    ['#strategy-type-name', name],
    ['#strategy-entry-description', description.entry],
    ['#strategy-exit-description', description.exit],
    ['#strategy-spec-entry', description.entry],
    ['#strategy-spec-exit', description.exit],
    ['#strategy-spec-lookback', `${String(strategyConfig.lookback)} sessions, with MA windows ${String(strategyConfig.shortWindow)} / ${String(strategyConfig.longWindow)}.`],
  ];
  fields.forEach(([selector, value]) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  });
  const errorElement = document.querySelector('#strategy-config-error');
  if (errorElement) errorElement.textContent = validation.valid ? '' : validation.errors.join(' ');
  const diagnosticElement = document.querySelector('#strategy-diagnostics');
  if (diagnosticElement) diagnosticElement.innerHTML = renderDiagnosticsPanel(currentDiagnostics, 'Strategy diagnostics', latestBacktest ?? currentBacktest);
}

function syncStrategyInputs({ persist = false } = {}) {
  strategyConfig = readStrategyInputs();
  const validation = validateStrategyParameters(strategyConfig);
  if (persist && validation.valid) saveStrategyPreferences();
  liveSimulationController?.setStrategy(strategyConfig);
  refreshPolicyState();
  updateDashboard(currentSeries);
  updateBacktestPanels();
  updateStrategyProfile(validation);
  return validation;
}

function applyStrategyForm() {
  const validation = syncStrategyInputs({ persist: true });
  showToast(validation.valid ? 'Strategy parameters applied.' : 'Invalid policy parameters remain visible for review.');
}

function validateGuardrailInputs(thresholds) {
  const bounds = { maxDrawdown: [0.1, 100], maxVolatility: [0.1, 300], maxExposure: [0.1, 100], lossLimit: [0.1, 100] };
  return Object.entries(bounds).filter(([key, [minimum, maximum]]) => {
    const value = thresholds[key];
    return !Number.isFinite(value) || value < minimum || value > maximum;
  });
}

function updateGuardrailInput(input, { persist = true } = {}) {
  const key = input.dataset.guardrailKey;
  if (!Object.hasOwn(guardrailThresholds, key)) return;
  const rawValue = input.value;
  guardrailThresholds = {
    ...guardrailThresholds,
    [key]: rawValue.trim() === '' ? Number.NaN : Number(rawValue),
  };
  const invalid = validateGuardrailInputs(guardrailThresholds);
  const errorElement = document.querySelector('#guardrail-config-error');
  if (errorElement) errorElement.textContent = invalid.length ? `Enter valid thresholds for: ${invalid.map(([key]) => key).join(', ')}.` : '';
  if (persist && !invalid.length) saveGuardrailPreferences();
  refreshPolicyState();
  updateDashboard(currentSeries);
  updateBacktestPanels();
}

function saveGuardrailInputs() {
  const invalid = validateGuardrailInputs(guardrailThresholds);
  const errorElement = document.querySelector('#guardrail-config-error');
  if (invalid.length) {
    if (errorElement) errorElement.textContent = `Enter valid thresholds for: ${invalid.map(([key]) => key).join(', ')}.`;
    return;
  }
  if (errorElement) errorElement.textContent = '';
  saveGuardrailPreferences();
  refreshPolicyState();
  updateDashboard(currentSeries);
  updateBacktestPanels();
  showToast(currentGuardrails.status === 'FAIL' ? 'Guardrail breach detected for this simulated backtest.' : currentGuardrails.status === 'PENDING' ? currentGuardrails.message : `Risk thresholds saved: ${currentGuardrails.status}.`);
}

function refreshCoveragePanels() {
  document.querySelectorAll('[data-coverage-groups]').forEach((panel) => {
    const encodedGroups = panel.dataset.coverageGroups;
    const groups = encodedGroups === 'all' ? null : encodedGroups.split('|');
    panel.outerHTML = renderCoverageMonitor(groups, panel.dataset.coverageTitle);
  });
}

function selectHeatmapParameters(button) {
  strategyConfig = {
    ...strategyConfig,
    shortWindow: Number(button.dataset.shortWindow),
    longWindow: Number(button.dataset.longWindow),
    lookback: Math.max(strategyConfig.lookback, Number(button.dataset.longWindow)),
  };
  saveStrategyPreferences();
  liveSimulationController?.setStrategy(strategyConfig);
  refreshPolicyState();
  updateDashboard(currentSeries);
  const heatmap = document.querySelector('.heatmap-panel');
  if (heatmap) heatmap.outerHTML = renderPolicyHeatmap(document.querySelector('#heatmap-metric')?.value ?? 'sharpeRatio');
  if (currentPage === 'strategies') renderWorkspacePage('strategies');
  showToast(`Applied MA ${strategyConfig.shortWindow} / ${strategyConfig.longWindow} from the calculated sweep.`);
}

function showToast(message) {
  window.clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.add('is-visible');
  toastTimeout = window.setTimeout(() => toast.classList.remove('is-visible'), 2800);
}

function closeSidebar() {
  sidebar.classList.remove('is-open');
  sidebarScrim.hidden = true;
  sidebarToggle.setAttribute('aria-expanded', 'false');
  sidebarToggle.setAttribute('aria-label', 'Open navigation');
}

function toggleContrast() {
  const raised = document.documentElement.dataset.contrast !== 'raised';
  document.documentElement.dataset.contrast = raised ? 'raised' : 'standard';
  const button = document.querySelector('#contrast-toggle');
  button.setAttribute('aria-pressed', String(raised));
  button.setAttribute('aria-label', raised ? 'Return to standard contrast' : 'Increase interface contrast');
  button.innerHTML = `<span data-icon="${raised ? 'Moon' : 'Sun'}"></span>`;
  hydrateIcons(button);
  if (currentPage === 'settings') renderWorkspacePage('settings');
}

document.querySelectorAll('.nav-link[data-page]').forEach((link) => {
  link.addEventListener('click', () => navigateTo(link.dataset.page));
});

document.querySelectorAll('[data-home-link]').forEach((link) => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    navigateTo('overview');
  });
});

document.querySelector('#settings-button').addEventListener('click', () => navigateTo('settings'));
document.querySelector('#view-research').addEventListener('click', () => navigateTo('research-lab'));
document.querySelector('#run-simulation').addEventListener('click', () => {
  runNewSimulation();
  showToast('Simulation complete. Run saved to the local research log.');
});
document.querySelector('#live-simulation-start').addEventListener('click', () => liveSimulationController.start());
document.querySelector('#live-simulation-pause').addEventListener('click', () => liveSimulationController.pause());
document.querySelector('#live-simulation-reset').addEventListener('click', () => liveSimulationController.reset());
document.querySelector('#live-history-window').addEventListener('change', (event) => {
  const selectedWindow = Number(event.target.value);
  if (!LIVE_SIMULATION_HISTORY_WINDOWS.includes(selectedWindow)) return;
  liveSimulationHistoryWindow = selectedWindow;
  updateLiveSimulationChart(liveSimulationChart, liveSimulationEngine.getState().history, liveSimulationHistoryWindow);
});
document.querySelector('#contrast-toggle').addEventListener('click', toggleContrast);

document.querySelector('#sidebar-toggle').addEventListener('click', () => {
  const isOpen = sidebar.classList.toggle('is-open');
  sidebarScrim.hidden = !isOpen;
  sidebarToggle.setAttribute('aria-expanded', String(isOpen));
  sidebarToggle.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
});
sidebarScrim.addEventListener('click', closeSidebar);

document.querySelectorAll('.period-button').forEach((button) => {
  button.addEventListener('click', () => {
    currentPeriod = button.dataset.period;
    updatePeriodButtons();
    currentSeries = generateSeries(currentPeriod, simulationSeed);
    refreshPolicyState();
    updatePriceChart(performanceChart, currentSeries);
    updateDashboard(currentSeries);
  });
});

document.addEventListener('click', (event) => {
  const reopenButton = event.target.closest('[data-open-experiment]');
  if (reopenButton) openExperiment(reopenButton.dataset.openExperiment);
  const deleteButton = event.target.closest('[data-delete-experiment]');
  if (deleteButton) deleteExperiment(deleteButton.dataset.deleteExperiment);
  const navigateButton = event.target.closest('[data-navigate]');
  if (navigateButton) navigateTo(navigateButton.dataset.navigate);
});

secondaryView.addEventListener('click', (event) => {
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === 'load-historical-data') loadHistoricalMarketData();
  if (action === 'run-backtest') runBacktest();
  if (action === 'save-guardrails') saveGuardrailInputs();
  if (action === 'apply-heatmap') selectHeatmapParameters(actionButton);
  if (action === 'replay-prev') replayController?.previous();
  if (action === 'replay-next') replayController?.next();
  if (action === 'replay-reset') replayController?.restart();
  if (action === 'replay-play') toggleReplay();
  if (action === 'run-monte-carlo') {
    const scenarioCount = Number(document.querySelector('#scenario-count').value);
    const years = Number(document.querySelector('#scenario-horizon').value);
    const errorElement = document.querySelector('#monte-carlo-error');
    const results = runMonteCarlo(scenarioCount, years, simulationSeed + scenarioCount + years);
    if (!results.valid) {
      errorElement.textContent = results.error;
      document.querySelector('#monte-carlo-results').innerHTML = '<p class="empty-state">No scenarios were run. Correct the parameters above.</p>';
      return;
    }
    errorElement.textContent = '';
    document.querySelector('#monte-carlo-results').innerHTML = `${renderMonteCarloSummary(results, scenarioCount, years)}<p class="result-caption">Synthetic outcomes are not forecasts.</p>`;
    const seed = simulationSeed + scenarioCount + years;
    const series = generateSeries(currentPeriod, seed);
    const monteCarlo = { ...results, scenarioCount, years, seed };
    addExperiment(createExperimentRecord({ name: `Monte Carlo / ${scenarioCount.toLocaleString()} scenarios`, kind: 'monte-carlo', series, seed, monteCarlo }));
    refreshCoveragePanels();
    showToast('Monte Carlo scenarios calculated and saved locally.');
  }
  if (action === 'new-experiment') {
    runNewSimulation({ kind: 'simulation', name: `Research run / ${String(simulationSeed + 1).padStart(3, '0')}` });
    navigateTo('overview');
    showToast('Experiment calculated and saved locally.');
  }
  if (action === 'toggle-contrast') toggleContrast();
  hydrateIcons(secondaryView);
});

secondaryView.addEventListener('submit', (event) => {
  if (event.target.id !== 'strategy-parameter-form') return;
  event.preventDefault();
  applyStrategyForm();
});

secondaryView.addEventListener('input', (event) => {
  if (event.target.id === 'replay-slider') replayController?.seek(Number(event.target.value));
  if (event.target.dataset.policyParam !== undefined) syncStrategyInputs();
  if (event.target.dataset.guardrailKey) updateGuardrailInput(event.target);
});

secondaryView.addEventListener('change', (event) => {
  if (event.target.dataset.policyParam !== undefined) syncStrategyInputs({ persist: true });
  if (event.target.dataset.guardrailKey) updateGuardrailInput(event.target);
  if (event.target.id === 'heatmap-metric') {
    const heatmap = document.querySelector('.heatmap-panel');
    if (heatmap) heatmap.outerHTML = renderPolicyHeatmap(event.target.value);
    hydrateIcons(secondaryView);
  }
  if (event.target.id === 'experiment-selection') {
    selectedExperimentId = event.target.value;
    renderWorkspacePage('research-lab');
  }
});