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

    if (url.pathname.startsWith('/api/customers/') && url.pathname.endsWith('/specs')) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createProductHandlerFromEnv } = await import('./products/routes.js');
      return createProductHandlerFromEnv(env)(request);
    }

    if (url.pathname === '/api/customers' || url.pathname.startsWith('/api/customers/') || url.pathname === '/api/customer-owners') {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createCustomerHandlerFromEnv } = await import('./customers/routes.js');
      return createCustomerHandlerFromEnv(env)(request);
    }

    if (url.pathname === '/api/external-sales' || url.pathname.startsWith('/api/external-sales/')) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createExternalSalesHandlerFromEnv } = await import('./external-sales/routes.js');
      return createExternalSalesHandlerFromEnv(env)(request);
    }

    if (
      url.pathname === '/api/manager-price-notes' || url.pathname.startsWith('/api/manager-price-notes/') ||
      url.pathname === '/api/freight-quotes' || url.pathname.startsWith('/api/freight-quotes/')
    ) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createPriceNoteHandlerFromEnv } = await import('./price-notes/routes.js');
      return createPriceNoteHandlerFromEnv(env)(request);
    }

    if (url.pathname === '/api/users' || url.pathname.startsWith('/api/users/')) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createUserHandlerFromEnv } = await import('./users/routes.js');
      return createUserHandlerFromEnv(env)(request);
    }

    if (
      url.pathname === '/api/shipments' || url.pathname.startsWith('/api/shipments/') ||
      url.pathname === '/api/expense-categories' || url.pathname.startsWith('/api/expense-categories/')
    ) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createShipmentHandlerFromEnv } = await import('./shipments/routes.js');
      return createShipmentHandlerFromEnv(env)(request);
    }

    if (url.pathname === '/api/service-partners' || url.pathname.startsWith('/api/service-partners/')) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createShippingDiHandlerFromEnv } = await import('./shipping-di/routes.js');
      return createShippingDiHandlerFromEnv(env)(request);
    }

    if (
      url.pathname === '/api/products' || url.pathname.startsWith('/api/products/') ||
      url.pathname === '/api/product-categories' || url.pathname.startsWith('/api/product-categories/') ||
      url.pathname === '/api/product-forms' || url.pathname.startsWith('/api/product-forms/') ||
      url.pathname === '/api/spec-parameters' || url.pathname.startsWith('/api/spec-parameters/') ||
      url.pathname === '/api/standard-specs' || url.pathname.startsWith('/api/standard-specs/') ||
      url.pathname === '/api/customer-specs' || url.pathname.startsWith('/api/customer-specs/') ||
      (url.pathname.startsWith('/api/customers/') && url.pathname.endsWith('/specs'))
    ) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createProductHandlerFromEnv } = await import('./products/routes.js');
      return createProductHandlerFromEnv(env)(request);
    }

    if (url.pathname === '/api/gateway') {
      return jsonResponse({
        status: 'ERROR',
        message: 'Backend action migration is not implemented in Cloudflare Phase 1-2.'
      }, 501);
    }

    if (url.pathname === '/api/pos' || url.pathname.startsWith('/api/pos/')) {
      if (!env.DB) return jsonResponse({ status: 'ERROR', message: 'D1 DB binding is not configured.' }, 503);
      const { createPOHandlerFromEnv } = await import('./pos/routes.js');
      return createPOHandlerFromEnv(env)(request);
    }

    if (url.pathname.startsWith('/api/')) {
      return jsonResponse({ status: 'ERROR', message: 'API route not found.' }, 404);
    }

    return env.ASSETS.fetch(request);
  }
};
