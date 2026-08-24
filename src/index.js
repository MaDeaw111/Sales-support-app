function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({
        status: 'SUCCESS',
        data: {
          service: 'WCAT Sales Support',
          runtime: 'Cloudflare Workers'
        }
      });
    }

    if (url.pathname === '/api/gateway') {
      return jsonResponse({
        status: 'ERROR',
        message: 'Backend action migration is not implemented in Cloudflare Phase 1-2.'
      }, 501);
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ status: 'ERROR', message: 'API route not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
