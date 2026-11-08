import Chart from 'chart.js/auto';

function movingAverage(values, windowSize) {
  return values.map((_, index) => {
    if (index + 1 < windowSize) return null;
    const window = values.slice(index + 1 - windowSize, index + 1);
    return window.reduce((total, value) => total + value, 0) / windowSize;
  });
}

const crosshairPlugin = {
  id: 'quantxCrosshair',
  afterDatasetsDraw(chart) {
    const activePoints = chart.tooltip?.getActiveElements() ?? [];
    if (!activePoints.length) return;
    const { ctx, chartArea } = chart;
    const x = activePoints[0].element.x;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(147, 164, 178, 0.38)';
    ctx.setLineDash([3, 4]);
    ctx.stroke();
    ctx.restore();
  },
};

function toChartData(series) {
  return {
    labels: series.labels,
    datasets: [
      { label: 'Price', data: series.values, borderColor: '#22c58b', backgroundColor: 'rgba(34, 197, 139, 0.07)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, pointHoverRadius: 3, pointHitRadius: 12, order: 1 },
      { label: 'MA (5)', data: movingAverage(series.values, 5), borderColor: '#8bb6a4', borderWidth: 1.25, borderDash: [4, 3], pointRadius: 0, pointHitRadius: 0, tension: 0.15, spanGaps: true, fill: false, order: 2 },
      { label: 'MA (20)', data: movingAverage(series.values, 20), borderColor: '#74869a', borderWidth: 1.25, borderDash: [2, 4], pointRadius: 0, pointHitRadius: 0, tension: 0.15, spanGaps: true, fill: false, order: 3 },
    ],
  };
}

export function createPriceChart(canvas, series) {
  return new Chart(canvas, {
    type: 'line',
    data: toChartData(series),
    plugins: [crosshairPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220 },
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      layout: { padding: { top: 6, right: 6, bottom: 0, left: 0 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index', intersect: false, backgroundColor: '#18232d', borderColor: '#334452', borderWidth: 1,
          titleColor: '#aab8c5', bodyColor: '#e7edf2', padding: 11, displayColors: true, boxPadding: 4,
          callbacks: { label: (context) => `${context.dataset.label}: ${context.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: '#778796', maxTicksLimit: 7, maxRotation: 0, autoSkip: true, font: { family: 'DM Mono, monospace', size: 10 } } },
        y: {
          border: { display: false }, grid: { color: 'rgba(110, 128, 143, 0.13)', drawTicks: false },
          ticks: { color: '#778796', maxTicksLimit: 6, padding: 10, callback: (value) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 }), font: { family: 'DM Mono, monospace', size: 10 } },
        },
      },
    },
  });
}

export function createHistoricalPriceChart(canvas, observations) {
  return new Chart(canvas, buildHistoricalPriceChartConfig(observations));
}

export function buildHistoricalPriceChartConfig(observations) {
  return {
    type: 'line',
    data: {
      labels: observations.map((observation) => observation.date),
      datasets: [{
        label: 'AAPL daily close',
        data: observations.map((observation) => observation.close),
        borderColor: '#22c58b',
        backgroundColor: 'rgba(34, 197, 139, 0.06)',
        borderWidth: 1.7,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.14,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: '#18232d',
          borderColor: '#334452',
          borderWidth: 1,
          titleColor: '#aab8c5',
          bodyColor: '#e7edf2',
          callbacks: {
            title: (items) => items[0]?.label ?? '',
            label: (context) => `Close: $${context.parsed.y.toFixed(2)}`,
            afterBody: (items) => {
              const observation = observations[items[0]?.dataIndex];
              return observation ? [
                `Open: $${observation.open.toFixed(2)}`,
                `High: $${observation.high.toFixed(2)}`,
                `Low: $${observation.low.toFixed(2)}`,
                `Volume: ${observation.volume.toLocaleString('en-US')}`,
              ] : [];
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#778796', maxTicksLimit: 8, maxRotation: 0, font: { family: 'DM Mono, monospace', size: 9 } },
        },
        y: {
          border: { display: false },
          grid: { color: 'rgba(110, 128, 143, 0.12)', drawTicks: false },
          title: { display: true, text: 'AAPL RAW CLOSE (USD)', color: '#8795a5', font: { family: 'DM Mono, monospace', size: 8 } },
          ticks: { color: '#778796', maxTicksLimit: 5, padding: 8, callback: (value) => `$${Number(value).toFixed(0)}`, font: { family: 'DM Mono, monospace', size: 9 } },
        },
      },
    },
  };
}

export function updatePriceChart(chart, series) {
  chart.data = toChartData(series);
  chart.update();
}

export function createReplayChart(canvas, series, backtest, selectedIndex = 0) {
  const replayValues = backtest?.valid ? backtest.equityCurve : [];
  return new Chart(canvas, {
    type: 'line',
    data: {
      labels: series.labels,
      datasets: [{
        label: 'Portfolio value',
        data: replayValues.map((value, index) => index <= selectedIndex ? value : null),
        borderColor: '#22c58b',
        backgroundColor: 'rgba(34, 197, 139, 0.06)',
        borderWidth: 1.7,
        pointRadius: 0,
        pointHoverRadius: 2,
        tension: 0.18,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      scales: {
        x: { display: false },
        y: {
          border: { display: false },
          grid: { color: 'rgba(110, 128, 143, 0.12)', drawTicks: false },
          ticks: {
            color: '#778796',
            maxTicksLimit: 3,
            padding: 6,
            callback: (value) => `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
            font: { family: 'DM Mono, monospace', size: 9 },
          },
        },
      },
    },
  });
}

export function updateReplayChart(chart, series, backtest, selectedIndex) {
  const replayValues = backtest?.valid ? backtest.equityCurve : [];
  chart.data.labels = series.labels;
  chart.data.datasets[0].data = replayValues.map((value, index) => index <= selectedIndex ? value : null);
  chart.update('none');
}

export const LIVE_SIMULATION_HISTORY_WINDOWS = [30, 60, 120, 300];

export function buildLiveSimulationChartConfig(history = []) {
  const points = history.slice(-60);
  const labels = points.map((point) => point.tick);
  const prices = points.map((point) => point.price);
  const equity = points.map((point) => point.equity);
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Synthetic market price', data: prices, yAxisID: 'price', borderColor: '#22c58b', backgroundColor: 'rgba(34, 197, 139, 0.04)', borderWidth: 1.6, pointRadius: 0, tension: 0.18 },
        { label: 'Portfolio equity', data: equity, yAxisID: 'equity', borderColor: '#91a5b7', backgroundColor: 'transparent', borderWidth: 1.4, pointRadius: 0, tension: 0.18 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: '#18232d',
          borderColor: '#334452',
          borderWidth: 1,
          titleColor: '#aab8c5',
          bodyColor: '#e7edf2',
          callbacks: {
            title: (items) => items.length ? `T+${items[0].label}s` : '',
            label: (context) => context.dataset.yAxisID === 'equity'
              ? `Portfolio equity: $${context.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : `Synthetic price: ${context.parsed.y.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} pts`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#778796', maxTicksLimit: 7, maxRotation: 0, font: { family: 'DM Mono, monospace', size: 9 }, callback(value) { return `T+${this.getLabelForValue(value)}s`; } },
        },
        price: {
          type: 'linear',
          position: 'left',
          border: { display: false },
          grid: { color: 'rgba(110, 128, 143, 0.12)', drawTicks: false },
          title: { display: true, text: 'PRICE (INDEX POINTS)', color: '#22c58b', font: { family: 'DM Mono, monospace', size: 8 } },
          ticks: { color: '#22c58b', maxTicksLimit: 4, padding: 6, callback: (value) => Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 }), font: { family: 'DM Mono, monospace', size: 9 } },
        },
        equity: {
          type: 'linear',
          position: 'right',
          border: { display: false },
          grid: { drawOnChartArea: false, drawTicks: false },
          title: { display: true, text: 'PORTFOLIO EQUITY (USD)', color: '#91a5b7', font: { family: 'DM Mono, monospace', size: 8 } },
          ticks: { color: '#91a5b7', maxTicksLimit: 4, padding: 6, callback: (value) => `$${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}`, font: { family: 'DM Mono, monospace', size: 9 } },
        },
      },
    },
  };
}

export function createLiveSimulationChart(canvas, history) {
  return new Chart(canvas, buildLiveSimulationChartConfig(history));
}

export function updateLiveSimulationChart(chart, history, historyWindow = 60) {
  const windowSize = LIVE_SIMULATION_HISTORY_WINDOWS.includes(historyWindow) ? historyWindow : 60;
  const points = history.slice(-windowSize);
  chart.data.labels = points.map((point) => point.tick);
  chart.data.datasets[0].data = points.map((point) => point.price);
  chart.data.datasets[1].data = points.map((point) => point.equity);
  chart.update('none');
}