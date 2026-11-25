import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketDataApiHandler } from '../api/market-data/daily.js';

function responseRecorder() {
  let body = '';
  return {
    headers: {},
    statusCode: 200,
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { body = value; },
    result() { return { status: this.statusCode, headers: this.headers, body: JSON.parse(body) }; },
  };
}

test('Vercel API handler exposes the production route and reports missing server credentials safely', async () => {
  const handler = createMarketDataApiHandler({ apiKey: '' });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/daily?symbol=AAPL' }, response);
  const result = response.result();
  assert.equal(result.status, 503);
  assert.equal(result.body.status, 'unavailable');
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
});

test('Vercel API handler serves normalized historical data without exposing the provider key', async () => {
  const key = 'private-test-key';
  const handler = createMarketDataApiHandler({
    apiKey: key,
    fetchImpl: async (url) => {
      assert.equal(new URL(url).searchParams.get('apikey'), key);
      return {
        ok: true,
        json: async () => ({
          'Meta Data': { '2. Symbol': 'AAPL' },
          'Time Series (Daily)': {
            '2025-01-02': { '1. open': '101', '2. high': '103', '3. low': '100', '4. close': '102', '5. volume': '200' },
            '2025-01-01': { '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101', '5. volume': '100' },
          },
        }),
      };
    },
  });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/daily?symbol=AAPL' }, response);
  const result = response.result();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'historical');
  assert.deepEqual(result.body.data.observations.map((item) => item.date), ['2025-01-01', '2025-01-02']);
  assert.equal(JSON.stringify(result.body).includes(key), false);
});

test('Vercel API handler returns safe method and route errors', async () => {
  const handler = createMarketDataApiHandler({ apiKey: '' });
  const methodResponse = responseRecorder();
  await handler({ method: 'POST', url: '/api/market-data/daily?symbol=AAPL' }, methodResponse);
  assert.equal(methodResponse.result().status, 405);

  const routeResponse = responseRecorder();
  await handler({ method: 'GET', url: '/api/unknown' }, routeResponse);
  assert.equal(routeResponse.result().status, 404);
});

test('Vercel API handler serves multiple allowlisted US equities and ETFs', async () => {
  const handler = createMarketDataApiHandler({
    apiKey: 'multi-asset-key',
    fetchImpl: async (url) => {
      const symbol = new URL(url).searchParams.get('symbol');
      return {
        ok: true,
        json: async () => ({
          'Meta Data': { '2. Symbol': symbol },
          'Time Series (Daily)': {
            '2025-01-02': { '1. open': '101', '2. high': '103', '3. low': '100', '4. close': '102', '5. volume': '200' },
            '2025-01-01': { '1. open': '100', '2. high': '102', '3. low': '99', '4. close': '101', '5. volume': '100' },
          },
        }),
      };
    },
  });
  for (const symbol of ['MSFT', 'SPY', 'QQQ']) {
    const response = responseRecorder();
    await handler({ method: 'GET', url: `/api/market-data/daily?symbol=${symbol}` }, response);
    const result = response.result();
    assert.equal(result.status, 200);
    assert.equal(result.body.data.symbol, symbol);
    assert.ok(result.body.data.observations.every((item) => item.symbol === symbol));
  }
  const unsupported = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/daily?symbol=NOTREAL' }, unsupported);
  assert.equal(unsupported.result().status, 400);
});


test('quote endpoint returns a validated provider snapshot and keeps API credentials private', async () => {
  const key = 'private-quote-key';
  const handler = createMarketDataApiHandler({
    apiKey: key,
    now: () => Date.parse('2026-11-23T15:00:00.000Z'),
    fetchImpl: async (url) => {
      const params = new URL(url).searchParams;
      assert.equal(params.get('function'), 'GLOBAL_QUOTE');
      assert.equal(params.get('symbol'), 'MSFT');
      assert.equal(params.get('apikey'), key);
      return {
        ok: true,
        json: async () => ({
          'Global Quote': {
            '01. symbol': 'MSFT',
            '05. price': '510.25',
            '06. volume': '1234567',
            '07. latest trading day': '2026-11-20',
            '08. previous close': '505.00',
            '09. change': '5.25',
            '10. change percent': '1.0396%',
          },
        }),
      };
    },
  });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/quote?symbol=MSFT' }, response);
  const result = response.result();
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'quote');
  assert.equal(result.body.data.price, 510.25);
  assert.equal(result.body.data.changePercent, 1.0396);
  assert.equal(result.body.data.latestTradingDay, '2026-11-20');
  assert.equal(JSON.stringify(result.body).includes(key), false);
});

test('quote endpoint rejects impossible calendar dates in provider snapshots', async () => {
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-date-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        'Global Quote': {
          '01. symbol': 'AAPL',
          '05. price': '200',
          '06. volume': '1000',
          '07. latest trading day': '2026-02-30',
          '08. previous close': '199',
          '09. change': '1',
          '10. change percent': '0.5025%',
        },
      }),
    }),
  });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
  assert.equal(response.result().status, 502);
  assert.equal(response.result().body.status, 'unavailable');
});

test('quote endpoint caches snapshots and rejects malformed provider responses', async () => {
  let requests = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-key',
    fetchImpl: async () => {
      requests += 1;
      return { ok: true, json: async () => ({ 'Global Quote': {} }) };
    },
  });
  const first = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, first);
  assert.equal(first.result().status, 502);
  assert.equal(first.result().body.status, 'unavailable');
  assert.equal(requests, 1);

  const noKey = createMarketDataApiHandler({ apiKey: '' });
  const unavailable = responseRecorder();
  await noKey({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, unavailable);
  assert.equal(unavailable.result().status, 503);
  assert.match(unavailable.result().body.message, /^Quote data is unavailable:/);
});


test('quote endpoint rejects blank required numeric fields instead of treating them as zero', async () => {
  const baseQuote = {
    '01. symbol': 'AAPL',
    '05. price': '100.00',
    '06. volume': '1000',
    '07. latest trading day': '2026-11-23',
    '08. previous close': '99.00',
    '09. change': '1.00',
    '10. change percent': '1.0101%',
  };
  for (const field of ['06. volume', '09. change', '10. change percent']) {
    const quote = { ...baseQuote, [field]: '' };
    const handler = createMarketDataApiHandler({
      apiKey: 'quote-integrity-key',
      fetchImpl: async () => ({ ok: true, json: async () => ({ 'Global Quote': quote }) }),
    });
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
    assert.equal(response.result().status, 502, `blank ${field} should be rejected`);
    assert.equal(response.result().body.status, 'unavailable');
  }
});

test('quote endpoint rejects internally inconsistent price change and percentage fields', async () => {
  const baseQuote = {
    '01. symbol': 'AAPL',
    '05. price': '100.00',
    '06. volume': '1000',
    '07. latest trading day': '2026-11-23',
    '08. previous close': '99.00',
    '09. change': '1.00',
    '10. change percent': '1.0101%',
  };
  for (const patch of [
    { '09. change': '2.00' },
    { '10. change percent': '2.0202%' },
  ]) {
    const quote = { ...baseQuote, ...patch };
    const handler = createMarketDataApiHandler({
      apiKey: 'quote-math-key',
      fetchImpl: async () => ({ ok: true, json: async () => ({ 'Global Quote': quote }) }),
    });
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
    assert.equal(response.result().status, 502);
    assert.equal(response.result().body.status, 'unavailable');
  }
});

test('quote endpoint accepts valid negative changes and zero volume', async () => {
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-negative-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        'Global Quote': {
          '01. symbol': 'AAPL',
          '05. price': '99.50',
          '06. volume': '0',
          '07. latest trading day': '2026-11-23',
          '08. previous close': '100.00',
          '09. change': '-0.50',
          '10. change percent': '-0.5000%',
        },
      }),
    }),
  });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
  assert.equal(response.result().status, 200);
  assert.equal(response.result().body.data.change, -0.5);
  assert.equal(response.result().body.data.changePercent, -0.5);
  assert.equal(response.result().body.data.volume, 0);
});


test('market-data routes handle network failures without exposing upstream error details', async () => {
  for (const path of ['/api/market-data/daily?symbol=AAPL', '/api/market-data/quote?symbol=AAPL']) {
    const handler = createMarketDataApiHandler({
      apiKey: 'private-network-key',
      fetchImpl: async () => { throw new Error('socket failure containing private diagnostic'); },
    });
    const response = responseRecorder();
    await handler({ method: 'GET', url: path }, response);
    const result = response.result();
    assert.equal(result.status, 502);
    assert.equal(JSON.stringify(result.body).includes('private diagnostic'), false);
  }
});

test('market-data routes classify request timeouts and aborts safely', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    for (const path of ['/api/market-data/daily?symbol=AAPL', '/api/market-data/quote?symbol=AAPL']) {
      const handler = createMarketDataApiHandler({
        apiKey: 'private-timeout-key',
        fetchImpl: async () => { const error = new Error('internal abort detail'); error.name = name; throw error; },
      });
      const response = responseRecorder();
      await handler({ method: 'GET', url: path }, response);
      const result = response.result();
      assert.equal(result.status, 502);
      assert.match(result.body.message, /timeout/i);
      assert.equal(result.body.message.includes('internal abort detail'), false);
    }
  }
});

test('market-data routes handle malformed JSON responses with safe messages', async () => {
  for (const path of ['/api/market-data/daily?symbol=AAPL', '/api/market-data/quote?symbol=AAPL']) {
    const handler = createMarketDataApiHandler({
      apiKey: 'private-json-key',
      fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError('private parser detail'); } }),
    });
    const response = responseRecorder();
    await handler({ method: 'GET', url: path }, response);
    const result = response.result();
    assert.equal(result.status, 502);
    assert.match(result.body.message, /unreadable response/i);
    assert.equal(result.body.message.includes('private parser detail'), false);
  }
});

test('market-data routes reject upstream HTTP failures without caching an error response', async () => {
  for (const path of ['/api/market-data/daily?symbol=AAPL', '/api/market-data/quote?symbol=AAPL']) {
    let calls = 0;
    const handler = createMarketDataApiHandler({
      apiKey: 'private-http-key',
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 503, json: async () => ({}) };
      },
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = responseRecorder();
      await handler({ method: 'GET', url: path }, response);
      assert.equal(response.result().status, 502);
    }
    assert.equal(calls, 2, 'failed upstream responses must not be cached');
  }
});


function validQuote(symbol, price) {
  const previousClose = price - 1;
  return {
    'Global Quote': {
      '01. symbol': symbol,
      '05. price': String(price),
      '06. volume': '1000',
      '07. latest trading day': '2026-11-23',
      '08. previous close': String(previousClose),
      '09. change': '1',
      '10. change percent': String((1 / previousClose) * 100) + '%',
    },
  };
}

function dailyProviderPayload(symbol, adjusted = false) {
  const base = symbol === 'MSFT' ? 200 : 100;
  const row = (offset) => ({
    '1. open': String(base + offset),
    '2. high': String(base + offset + 2),
    '3. low': String(base + offset - 1),
    '4. close': String(base + offset + 1),
    ...(adjusted ? {
      '5. adjusted close': String(base + offset + 0.5),
      '6. volume': '1000',
      '7. dividend amount': '0',
      '8. split coefficient': '1',
    } : { '5. volume': '1000' }),
  });
  return {
    'Meta Data': { '2. Symbol': symbol },
    [adjusted ? 'Time Series (Daily Adjusted)' : 'Time Series (Daily)']: {
      '2025-01-02': row(1),
      '2025-01-01': row(0),
    },
  };
}

test('quote cache serves a fresh snapshot and fetches again after its TTL expires', async () => {
  let clock = 1_800_000_000_000;
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-cache-key',
    now: () => clock,
    quoteCacheTtlMs: 60_000,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => validQuote('AAPL', 100 + calls) };
    },
  });

  const request = async () => {
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
    return response.result();
  };

  const first = await request();
  const cached = await request();
  assert.equal(first.status, 200);
  assert.equal(cached.status, 200);
  assert.equal(first.body.data.price, cached.body.data.price);
  assert.equal(calls, 1, 'a fresh quote should be served from cache');

  clock += 60_001;
  const refreshed = await request();
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.data.price, first.body.data.price + 1);
  assert.equal(calls, 2, 'an expired quote should trigger a provider request');
});

test('forced quote refresh bypasses cache, and a failed refresh preserves the still-fresh snapshot', async () => {
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-refresh-key',
    now: () => Date.parse('2026-11-23T15:00:00.000Z'),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, json: async () => validQuote('AAPL', 150) };
    },
  });

  const request = async (url) => {
    const response = responseRecorder();
    await handler({ method: 'GET', url }, response);
    return response.result();
  };

  const initial = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(initial.status, 200);
  const forced = await request('/api/market-data/quote?symbol=AAPL&refresh=1');
  assert.equal(forced.status, 502);
  const afterFailure = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(afterFailure.status, 200);
  assert.equal(afterFailure.body.data.price, 150);
  assert.equal(calls, 2, 'the failed forced refresh must not overwrite or discard the fresh cached snapshot');
});

test('daily cache isolates symbols and raw versus adjusted requests while reusing matching entries', async () => {
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'daily-cache-key',
    fetchImpl: async (url) => {
      calls += 1;
      const params = new URL(url).searchParams;
      const symbol = params.get('symbol');
      const adjusted = params.get('function') === 'TIME_SERIES_DAILY_ADJUSTED';
      return { ok: true, json: async () => dailyProviderPayload(symbol, adjusted) };
    },
  });

  const request = async (symbol, adjustment = 'raw') => {
    const response = responseRecorder();
    await handler({
      method: 'GET',
      url: `/api/market-data/daily?symbol=${symbol}&adjustment=${adjustment}`,
    }, response);
    return response.result();
  };

  const aaplRaw = await request('AAPL');
  const aaplRawCached = await request('AAPL');
  const msftRaw = await request('MSFT');
  const aaplAdjusted = await request('AAPL', 'adjusted');
  const aaplAdjustedCached = await request('AAPL', 'adjusted');

  assert.equal(aaplRaw.status, 200);
  assert.equal(aaplRawCached.status, 200);
  assert.equal(msftRaw.status, 200);
  assert.equal(aaplAdjusted.status, 200);
  assert.equal(aaplAdjustedCached.status, 200);
  assert.equal(aaplRaw.body.data.symbol, 'AAPL');
  assert.equal(msftRaw.body.data.symbol, 'MSFT');
  assert.equal(aaplAdjusted.body.data.requestedAdjustment, 'adjusted');
  assert.equal(aaplAdjusted.body.data.observations[0].adjustedClose, 100.5);
  assert.equal(calls, 3, 'only the three distinct symbol/adjustment combinations should fetch');
});

test('daily cache expires according to its configured TTL', async () => {
  let clock = 1_800_000_000_000;
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'daily-expiry-key',
    now: () => clock,
    cacheTtlMs: 100,
    fetchImpl: async (url) => {
      calls += 1;
      const symbol = new URL(url).searchParams.get('symbol');
      return { ok: true, json: async () => dailyProviderPayload(symbol) };
    },
  });

  const request = async () => {
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/daily?symbol=AAPL' }, response);
    return response.result();
  };

  assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200);
  assert.equal(calls, 1, 'a fresh daily snapshot should be cached');
  clock += 101;
  assert.equal((await request()).status, 200);
  assert.equal(calls, 2, 'an expired daily snapshot should be fetched again');
});


test('simultaneous quote cache misses share one provider request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-single-flight-key',
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return { ok: true, json: async () => validQuote('AAPL', 175) };
    },
  });
  const request = async () => {
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
    return response.result();
  };

  const first = request();
  const second = request();
  assert.equal(calls, 1, 'concurrent misses for one quote should start one upstream request');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body.data, b.body.data);
  assert.equal(calls, 1);
});

test('simultaneous daily cache misses share one provider request', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = createMarketDataApiHandler({
    apiKey: 'daily-single-flight-key',
    fetchImpl: async (url) => {
      calls += 1;
      await gate;
      const symbol = new URL(url).searchParams.get('symbol');
      return { ok: true, json: async () => dailyProviderPayload(symbol) };
    },
  });
  const request = async () => {
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/daily?symbol=AAPL' }, response);
    return response.result();
  };

  const first = request();
  const second = request();
  assert.equal(calls, 1, 'concurrent misses for one daily series should start one upstream request');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body.data, b.body.data);
  assert.equal(calls, 1);
});

test('failed shared provider requests are cleared so a later request can retry', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = createMarketDataApiHandler({
    apiKey: 'single-flight-retry-key',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, json: async () => validQuote('AAPL', 180) };
    },
  });
  const request = async () => {
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
    return response.result();
  };

  const first = request();
  const second = request();
  assert.equal(calls, 1);
  release();
  const [failedA, failedB] = await Promise.all([first, second]);
  assert.equal(failedA.status, 502);
  assert.equal(failedB.status, 502);
  const retry = await request();
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.price, 180);
  assert.equal(calls, 2);
});


test('successful forced quote refresh replaces the cached snapshot', async () => {
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-successful-refresh-key',
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => validQuote('AAPL', calls === 1 ? 150 : 160) };
    },
  });
  const request = async (url) => {
    const response = responseRecorder();
    await handler({ method: 'GET', url }, response);
    return response.result();
  };

  assert.equal((await request('/api/market-data/quote?symbol=AAPL')).body.data.price, 150);
  assert.equal((await request('/api/market-data/quote?symbol=AAPL&refresh=1')).body.data.price, 160);
  assert.equal((await request('/api/market-data/quote?symbol=AAPL')).body.data.price, 160);
  assert.equal(calls, 2, 'the successful forced refresh should replace the previous cached snapshot');
});

test('normal quote reads remain isolated from an in-progress forced refresh', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-refresh-isolation-key',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) await gate;
      return { ok: true, json: async () => validQuote('AAPL', calls === 1 ? 150 : 160) };
    },
  });
  const request = async (url) => {
    const response = responseRecorder();
    await handler({ method: 'GET', url }, response);
    return response.result();
  };

  const initial = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(initial.body.data.price, 150);
  const refreshing = request('/api/market-data/quote?symbol=AAPL&refresh=1');
  const duringRefresh = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(duringRefresh.status, 200);
  assert.equal(duringRefresh.body.data.price, 150, 'normal reads may use the still-valid snapshot while refresh runs');
  release();
  const refreshed = await refreshing;
  assert.equal(refreshed.body.data.price, 160);
  const afterRefresh = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(afterRefresh.body.data.price, 160);
  assert.equal(calls, 2);
});

test('cache lifecycle remains bounded across every allowlisted symbol and prunes expired entries', async () => {
  const symbols = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'SPY', 'QQQ', 'DIA', 'IWM'];
  let clock = 1_800_000_000_000;
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'cache-lifecycle-key',
    now: () => clock,
    cacheTtlMs: 100,
    quoteCacheTtlMs: 100,
    providerRequestLimit: 40,
    fetchImpl: async (url) => {
      calls += 1;
      const params = new URL(url).searchParams;
      const symbol = params.get('symbol');
      if (params.get('function') === 'GLOBAL_QUOTE') {
        return { ok: true, json: async () => validQuote(symbol, 200) };
      }
      const adjusted = params.get('function') === 'TIME_SERIES_DAILY_ADJUSTED';
      return { ok: true, json: async () => dailyProviderPayload(symbol, adjusted) };
    },
  });
  const request = async (path) => {
    const response = responseRecorder();
    await handler({ method: 'GET', url: path }, response);
    return response.result();
  };

  for (const symbol of symbols) {
    assert.equal((await request(`/api/market-data/quote?symbol=${symbol}`)).status, 200);
    assert.equal((await request(`/api/market-data/daily?symbol=${symbol}&adjustment=raw`)).status, 200);
    assert.equal((await request(`/api/market-data/daily?symbol=${symbol}&adjustment=adjusted`)).status, 200);
  }
  assert.equal(calls, symbols.length * 3, 'the allowlist yields at most three distinct cache keys per symbol');

  assert.equal((await request('/api/market-data/quote?symbol=AAPL')).status, 200);
  assert.equal(calls, symbols.length * 3, 'revisiting a symbol within TTL should reuse its cache entry');

  clock += 101;
  assert.equal((await request('/api/market-data/quote?symbol=AAPL')).status, 200);
  assert.equal(calls, symbols.length * 3 + 1, 'expired quote entry should be refetched');
  assert.equal((await request('/api/market-data/daily?symbol=MSFT&adjustment=raw')).status, 200);
  assert.equal(calls, symbols.length * 3 + 2, 'expired daily entry should also be refetched after cleanup');
});


test('provider request budget is shared across quote and daily routes', async () => {
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'provider-budget-key',
    now: () => 1_800_000_000_000,
    providerRequestLimit: 2,
    fetchImpl: async (url) => {
      calls += 1;
      const params = new URL(url).searchParams;
      if (params.get('function') === 'GLOBAL_QUOTE') {
        return { ok: true, json: async () => validQuote(params.get('symbol'), 200) };
      }
      return { ok: true, json: async () => dailyProviderPayload(params.get('symbol')) };
    },
  });
  const request = async (url) => {
    const response = responseRecorder();
    await handler({ method: 'GET', url }, response);
    return response.result();
  };

  assert.equal((await request('/api/market-data/quote?symbol=AAPL')).status, 200);
  assert.equal((await request('/api/market-data/daily?symbol=MSFT')).status, 200);
  const blocked = await request('/api/market-data/daily?symbol=NVDA');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.status, 'rate_limited');
  assert.equal(Number(blocked.headers['Retry-After']), 86400);
  assert.equal(calls, 2, 'the local daily budget must cover both endpoint types');
});

test('cached responses do not consume the provider request budget', async () => {
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'provider-cache-budget-key',
    providerRequestLimit: 1,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => validQuote('AAPL', 200) };
    },
  });
  const request = async (url) => {
    const response = responseRecorder();
    await handler({ method: 'GET', url }, response);
    return response.result();
  };

  assert.equal((await request('/api/market-data/quote?symbol=AAPL')).status, 200);
  assert.equal((await request('/api/market-data/quote?symbol=AAPL')).status, 200);
  const blocked = await request('/api/market-data/quote?symbol=MSFT');
  assert.equal(blocked.status, 429);
  assert.equal(calls, 1, 'cache hits must not spend provider request capacity');
});

test('provider rate-limit responses activate a shared cooldown across quote and daily routes', async () => {
  let clock = 1_800_000_000_000;
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'provider-cooldown-key',
    now: () => clock,
    providerRateLimitCooldownMs: 5_000,
    fetchImpl: async (url) => {
      calls += 1;
      const params = new URL(url).searchParams;
      if (calls === 1) {
        return { ok: true, json: async () => ({ Note: 'API call frequency limit reached.' }) };
      }
      return { ok: true, json: async () => dailyProviderPayload(params.get('symbol')) };
    },
  });
  const request = async (url) => {
    const response = responseRecorder();
    await handler({ method: 'GET', url }, response);
    return response.result();
  };

  const providerLimited = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(providerLimited.status, 429);
  assert.equal(providerLimited.headers['Retry-After'], '5');

  const duringCooldown = await request('/api/market-data/daily?symbol=MSFT');
  assert.equal(duringCooldown.status, 429);
  assert.equal(duringCooldown.headers['Retry-After'], '5');
  assert.equal(calls, 1, 'the second route must not call the provider during cooldown');

  clock += 5_001;
  const afterCooldown = await request('/api/market-data/daily?symbol=MSFT');
  assert.equal(afterCooldown.status, 200);
  assert.equal(calls, 2, 'provider requests may resume after the configured cooldown');
});

test('concurrent duplicate requests spend only one provider budget unit', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = createMarketDataApiHandler({
    apiKey: 'provider-single-budget-key',
    providerRequestLimit: 1,
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return { ok: true, json: async () => validQuote('AAPL', 200) };
    },
  });
  const request = async () => {
    const response = responseRecorder();
    await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
    return response.result();
  };

  const first = request();
  const second = request();
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(calls, 1);
  const otherSymbol = await requestForSymbol(handler, 'MSFT');
  assert.equal(otherSymbol.status, 429, 'the shared request should consume exactly one budget unit');
});

async function requestForSymbol(handler, symbol) {
  const response = responseRecorder();
  await handler({ method: 'GET', url: `/api/market-data/quote?symbol=${symbol}` }, response);
  return response.result();
}

test('quote refresh bypasses a fresh cache entry and replaces it for subsequent reads', async () => {
  let calls = 0;
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-refresh-cache-key',
    providerRequestLimit: 3,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => validQuote('AAPL', 200 + calls) };
    },
  });
  const request = async (url) => {
    const response = responseRecorder();
    await handler({ method: 'GET', url }, response);
    return response.result();
  };

  const initial = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.data.price, 201);

  const cached = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(cached.status, 200);
  assert.equal(cached.body.data.price, 201);
  assert.equal(calls, 1, 'ordinary reads should reuse the fresh quote cache');

  const refreshed = await request('/api/market-data/quote?symbol=AAPL&refresh=1');
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.data.price, 202);
  assert.equal(calls, 2, 'an explicit refresh should make a new provider request');

  const afterRefresh = await request('/api/market-data/quote?symbol=AAPL');
  assert.equal(afterRefresh.status, 200);
  assert.equal(afterRefresh.body.data.price, 202);
  assert.equal(calls, 2, 'the refreshed snapshot should replace the previous cache entry');
});

test('market-data routes classify provider plan notices without exposing provider text', async () => {
  for (const [path, expectedMessage] of [
    ['/api/market-data/daily?symbol=AAPL', /endpoint is unavailable/i],
    ['/api/market-data/quote?symbol=AAPL', /endpoint is unavailable/i],
  ]) {
    const handler = createMarketDataApiHandler({
      apiKey: 'private-plan-key',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ Information: 'PRIVATE PLAN NOTICE: upgrade at https://provider.invalid/private' }),
      }),
    });
    const response = responseRecorder();
    await handler({ method: 'GET', url: path }, response);
    const result = response.result();
    assert.equal(result.status, 503);
    assert.equal(result.body.status, 'unavailable');
    assert.match(result.body.message, expectedMessage);
    assert.equal(JSON.stringify(result.body).includes('PRIVATE PLAN NOTICE'), false);
    assert.equal(JSON.stringify(result.body).includes('provider.invalid'), false);
  }
});

test('market-data routes sanitize provider symbol and request rejection messages', async () => {
  for (const [path, expectedStatus] of [
    ['/api/market-data/daily?symbol=AAPL', 502],
    ['/api/market-data/quote?symbol=AAPL', 502],
  ]) {
    const handler = createMarketDataApiHandler({
      apiKey: 'private-provider-error-key',
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ 'Error Message': 'PRIVATE PROVIDER DETAIL: account identifier 12345' }),
      }),
    });
    const response = responseRecorder();
    await handler({ method: 'GET', url: path }, response);
    const result = response.result();
    assert.equal(result.status, expectedStatus);
    assert.equal(result.body.status, 'error');
    assert.equal(JSON.stringify(result.body).includes('PRIVATE PROVIDER DETAIL'), false);
    assert.equal(JSON.stringify(result.body).includes('12345'), false);
  }
});

test('quote endpoint rejects a provider snapshot for a different symbol', async () => {
  const handler = createMarketDataApiHandler({
    apiKey: 'quote-symbol-integrity-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => validQuote('MSFT', 250),
    }),
  });
  const response = responseRecorder();
  await handler({ method: 'GET', url: '/api/market-data/quote?symbol=AAPL' }, response);
  const result = response.result();
  assert.equal(result.status, 502);
  assert.equal(result.body.status, 'unavailable');
  assert.match(result.body.message, /no complete quote snapshot/i);
});
