import { createAuthHandlerFromEnv } from './auth/routes.js';

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

    if (url.pathname.startsWith('/api/auth/')) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      return createAuthHandlerFromEnv(env)(request);
    }

    if (url.pathname === '/api/customers' || url.pathname.startsWith('/api/customers/')) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createCustomerHandlerFromEnv } = await import('./customers/routes.js');
      return createCustomerHandlerFromEnv(env)(request);
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
