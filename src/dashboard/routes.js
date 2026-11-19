import { resolveAuthenticatedUser } from '../auth/routes.js';
import { createDashboardRepository } from './repository.js';

const DASHBOARD_ROLES = [
  'ADMIN',
  'MANAGER',
  'SALES_SUPPORT',
  'EXTERNAL_SALES',
  'EXPORT',
  'PRODUCTION_WAREHOUSE'
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

export function createDashboardHandler({ repo, resolveUser, db, now = () => new Date() }) {
  const activeRepo = repo || createDashboardRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    if (!DASHBOARD_ROLES.includes(caller.role)) {
      return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/dashboard' || request.method !== 'GET') {
      return json({ status: 'ERROR', message: 'Dashboard route not found.' }, 404);
    }

    const data = await activeRepo.getDashboardForCaller(caller, now());
    if (!data) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
    return json({ status: 'SUCCESS', data });
  };
}

export function createDashboardHandlerFromEnv(env) {
  return createDashboardHandler({
    db: env.DB,
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
