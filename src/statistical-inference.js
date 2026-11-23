const DEFAULT_HAC_OPTIONS = {
  bandwidth: 'newey-west',
  kernel: 'bartlett',
  finiteSampleCorrection: true,
  hc0Only: false,
};

function isFiniteMatrix(matrix) {
  return Array.isArray(matrix) && matrix.length > 0
    && matrix.every((row) => Array.isArray(row) && row.length === matrix[0].length
      && row.every(Number.isFinite));
}

function transpose(matrix) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function multiply(left, right) {
  return left.map((row) => right[0].map((_, column) =>
    row.reduce((sum, value, index) => sum + value * right[index][column], 0)));
}

function inverse(matrix) {
  const size = matrix.length;
  const work = matrix.map((row, index) => [
    ...row,
    ...Array.from({ length: size }, (_, column) => Number(index === column)),
  ]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row][column]) > Math.abs(work[pivot][column])) pivot = row;
    }
    if (Math.abs(work[pivot][column]) < 1e-12) return null;
    [work[column], work[pivot]] = [work[pivot], work[column]];
    const scale = work[column][column];
    work[column] = work[column].map((value) => value / scale);
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = work[row][column];
      work[row] = work[row].map((value, index) => value - factor * work[column][index]);
    }
  }
  return work.map((row) => row.slice(size));
}

function normalCdf(value) {
  // Abramowitz-Stegun 7.1.26 approximation; adequate for asymptotic diagnostics.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
    - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function twoSidedNormalPValue(statistic) {
  return Math.max(0, Math.min(1, 2 * (1 - normalCdf(Math.abs(statistic)))));
}

/**
 * OLS with Bartlett-kernel Newey-West HAC covariance.
 * X must contain any desired intercept column explicitly.
 * P-values use an asymptotic standard-normal reference distribution.
 */
export function fitHacRegression(y, X, options = {}) {
  const config = { ...DEFAULT_HAC_OPTIONS, ...options };
  if (!Array.isArray(y) || !isFiniteMatrix(X) || X.length !== y.length
    || !y.every(Number.isFinite)) {
    return { valid: false, error: 'finite_aligned_design_required' };
  }
  const observations = y.length;
  const parameters = X[0].length;
  if (observations < 5 || parameters < 1 || observations <= parameters) {
    return { valid: false, error: 'insufficient_sample_for_hac', observations, parameters };
  }
  if (config.kernel !== 'bartlett') {
    return { valid: false, error: 'unsupported_kernel', supportedKernels: ['bartlett'] };
  }
  const maxLag = Math.min(observations - 2, Math.floor(observations / 3));
  let lag;
  if (Number.isInteger(config.bandwidth)) {
    if (config.bandwidth < 0) return { valid: false, error: 'invalid_bandwidth' };
    lag = config.bandwidth;
  } else if (config.bandwidth === 'newey-west') {
    lag = Math.floor(4 * (observations / 100) ** (2 / 9));
  } else {
    return { valid: false, error: 'unsupported_bandwidth_method' };
  }
  lag = config.hc0Only && lag === 0 ? 0 : Math.max(1, Math.min(lag, maxLag));

  const xt = transpose(X);
  const xtx = multiply(xt, X);
  const bread = inverse(xtx);
  if (!bread) return { valid: false, error: 'design_near_singular' };
  const beta = multiply(multiply(bread, xt), y.map((value) => [value])).map((row) => row[0]);
  const residuals = y.map((value, index) =>
    value - X[index].reduce((sum, item, column) => sum + item * beta[column], 0));
  const scores = X.map((row, index) => row.map((value) => value * residuals[index]));
  const meat = Array.from({ length: parameters }, () => Array(parameters).fill(0));

  for (let time = 0; time < observations; time += 1) {
    for (let i = 0; i < parameters; i += 1) {
      for (let j = 0; j < parameters; j += 1) meat[i][j] += scores[time][i] * scores[time][j];
    }
  }
  for (let offset = 1; offset <= lag; offset += 1) {
    const weight = 1 - offset / (lag + 1);
    for (let time = offset; time < observations; time += 1) {
      for (let i = 0; i < parameters; i += 1) {
        for (let j = 0; j < parameters; j += 1) {
          const cross = scores[time][i] * scores[time - offset][j]
            + scores[time - offset][i] * scores[time][j];
          meat[i][j] += weight * cross;
        }
      }
    }
  }

  const correction = config.finiteSampleCorrection === false ? 1 : observations / (observations - parameters);
  const covariance = multiply(multiply(bread, meat), bread)
    .map((row) => row.map((value) => value * correction));
  for (let i = 0; i < parameters; i += 1) {
    for (let j = i + 1; j < parameters; j += 1) {
      const symmetric = (covariance[i][j] + covariance[j][i]) / 2;
      covariance[i][j] = symmetric;
      covariance[j][i] = symmetric;
    }
  }
  const standardErrors = covariance.map((row, index) =>
    row[index] >= 0 ? Math.sqrt(row[index]) : NaN);
  if (standardErrors.some((value) => !Number.isFinite(value))) {
    return { valid: false, error: 'hac_non_positive_variance', bandwidth: lag };
  }
  const statistics = beta.map((value, index) =>
    standardErrors[index] > 0 ? value / standardErrors[index] : NaN);
  const pValues = statistics.map(twoSidedNormalPValue);
  return {
    valid: true,
    method: 'OLS with Newey-West HAC covariance',
    kernel: 'bartlett',
    bandwidthMethod: Number.isInteger(config.bandwidth) ? 'fixed' : 'newey-west',
    bandwidth: lag,
    observations,
    parameters,
    finiteSampleCorrection: correction,
    coefficients: beta,
    residuals,
    covariance,
    standardErrors,
    statistics,
    pValues,
    referenceDistribution: 'asymptotic_standard_normal',
    warnings: observations < 20 ? ['hac_small_sample'] : [],
  };
}

/**
 * Adjust a family of p-values using Bonferroni, Benjamini-Hochberg, or
 * Benjamini-Yekutieli. Returns adjusted p-values in original input order.
 */
export function adjustPValues(pValues, {
  method = 'by',
  alpha = 0.05,
} = {}) {
  if (!Array.isArray(pValues) || !pValues.length || !pValues.every((value) =>
    Number.isFinite(value) && value >= 0 && value <= 1)) {
    return { valid: false, error: 'p_values_must_be_finite_and_between_zero_and_one' };
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    return { valid: false, error: 'alpha_must_be_between_zero_and_one' };
  }
  if (!['bonferroni', 'bh', 'by'].includes(method)) {
    return { valid: false, error: 'unsupported_adjustment_method' };
  }
  const count = pValues.length;
  const ordered = pValues.map((pValue, index) => ({ pValue, index }))
    .sort((left, right) => left.pValue - right.pValue || left.index - right.index);
  const adjusted = Array(count).fill(1);
  if (method === 'bonferroni') {
    ordered.forEach(({ pValue, index }) => { adjusted[index] = Math.min(1, pValue * count); });
  } else {
    const dependenceFactor = method === 'by'
      ? Array.from({ length: count }, (_, index) => 1 / (index + 1)).reduce((sum, value) => sum + value, 0)
      : 1;
    let runningMinimum = 1;
    for (let rank = count; rank >= 1; rank -= 1) {
      const item = ordered[rank - 1];
      runningMinimum = Math.min(runningMinimum,
        item.pValue * count * dependenceFactor / rank);
      adjusted[item.index] = Math.min(1, runningMinimum);
    }
  }
  return {
    valid: true,
    method,
    alpha,
    adjustedPValues: adjusted,
    reject: adjusted.map((value) => value <= alpha),
    familySize: count,
    guarantee: method === 'by' ? 'FDR control under arbitrary dependence'
      : method === 'bh' ? 'FDR control under independence or PRDS; otherwise not guaranteed'
        : 'FWER control under arbitrary dependence',
  };
}
