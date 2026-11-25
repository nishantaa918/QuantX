export function createHealthApiHandler({ now = () => Date.now() } = {}) {
  return async function healthApiHandler(request, response) {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET');
      response.end(JSON.stringify({ status: 'error', message: 'Use GET for the health endpoint.' }));
      return;
    }
    response.statusCode = 200;
    response.end(JSON.stringify({
      status: 'ok',
      service: 'quantx-api',
      timestamp: new Date(now()).toISOString(),
    }));
  };
}

export default createHealthApiHandler();
