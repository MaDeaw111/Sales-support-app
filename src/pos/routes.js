import { createPORepository } from './repository.js';
import { resolveAuthenticatedUser } from '../auth/routes.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// Projection Filter
function filterPOForRole(po, caller) {
  const { role, user_id: callerUserId } = caller;
  if (role === 'ADMIN' || role === 'MANAGER' || role === 'SALES_SUPPORT') {
    return po; // Full view
  }

  if (role === 'EXTERNAL_SALES') {
    const activeRev = (po.revisions || []).find(r => r.status === 'ACTIVE');
    if (!activeRev) {
      return null;
    }
    if (activeRev.ownership_type_snapshot !== 'ASSIGNED_SALES' || activeRev.sales_owner_user_id_snapshot !== callerUserId) {
      return null;
    }

    const filteredLines = (activeRev.lines || []).map(line => {
      const cleanLine = { ...line };
      if (line.commission_recipient_user_id !== callerUserId) {
        delete cleanLine.commission_recipient_user_id;
        delete cleanLine.commission_rate_usd_mt;
      }
      return cleanLine;
    });

    const cleanActiveRev = {
      ...activeRev,
      lines: filteredLines
    };

    return {
      header: po.header,
      revisions: [cleanActiveRev]
    };
  }

  if (role === 'EXPORT') {
    const cleanRevisions = (po.revisions || []).map(rev => {
      const cleanLines = (rev.lines || []).map(line => {
        const cleanLine = { ...line };
        delete cleanLine.unit_price;
        delete cleanLine.unitPrice;
        delete cleanLine.suggested_price;
        delete cleanLine.suggestedPrice;
        delete cleanLine.price_override_reason;
        delete cleanLine.priceOverrideReason;
        delete cleanLine.commission_recipient_user_id;
        delete cleanLine.commissionRecipientUserId;
        delete cleanLine.commission_rate_usd_mt;
        delete cleanLine.commissionRateUsdMt;
        return cleanLine;
      });
      return {
        ...rev,
        lines: cleanLines
      };
    });

    return {
      header: po.header,
      revisions: cleanRevisions
    };
  }

  if (role === 'PRODUCTION_WAREHOUSE') {
    const cleanRevisions = (po.revisions || []).map(rev => {
      const cleanLines = (rev.lines || []).map(line => {
        return {
          line_id: line.line_id,
          line_no: line.line_no,
          product_id: line.product_id,
          spec_source: line.spec_source,
          spec_revision_id: line.spec_revision_id,
          contract_qty_mt: line.contract_qty_mt,
          min_qty_mt: line.min_qty_mt,
          max_qty_mt: line.max_qty_mt,
          packaging: line.packaging
        };
      });
      return {
        revision_id: rev.revision_id,
        revision_no: rev.revision_no,
        status: rev.status,
        delivery_start: rev.delivery_start,
        delivery_end: rev.delivery_end,
        lines: cleanLines
      };
    });

    return {
      header: {
        po_id: po.header.po_id,
        customer_id: po.header.customer_id,
        header_status: po.header.header_status
      },
      revisions: cleanRevisions
    };
  }

  return null;
}

export function createPOHandler({ repo, resolveUser, db }) {
  return async function handle(request, env) {
    const caller = await resolveUser(request, env);
    if (!caller) {
      return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const isAdmin = caller.role === 'ADMIN';
    const isManager = caller.role === 'MANAGER';
    const isSalesSupport = caller.role === 'SALES_SUPPORT';

    const canWrite = isAdmin || isManager || isSalesSupport;
    const canApproveOrCancel = isAdmin || isManager;

    // GET /api/pos (List)
    if (path === '/api/pos' && method === 'GET') {
      const headers = await repo.listPOs();
      const filtered = [];
      for (const h of headers) {
        const detail = await repo.getPO(h.po_id);
        const clean = filterPOForRole(detail, caller);
        if (clean) {
          filtered.push(clean);
        }
      }
      return json({ status: 'SUCCESS', data: { pos: filtered } });
    }

    // POST /api/pos (Create PO)
    if (path === '/api/pos' && method === 'POST') {
      if (!canWrite) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body) return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);

      try {
        const po = await repo.createDraftPO(body, caller.user_id);
        return json({ status: 'SUCCESS', data: { po } });
      } catch (err) {
        return handleRepoError(err);
      }
    }

    // GET /api/pos/:poId
    const detailMatch = path.match(/^\/api\/pos\/([^/]+)$/);
    if (detailMatch) {
      const poId = detailMatch[1];

      if (method === 'GET') {
        const detail = await repo.getPO(poId);
        if (!detail) {
          return json({ status: 'ERROR', message: 'PO not found.' }, 404);
        }
        const clean = filterPOForRole(detail, caller);
        if (!clean) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        return json({ status: 'SUCCESS', data: { po: clean } });
      }

      if (method === 'DELETE') {
        if (!canWrite) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        try {
          await repo.deleteDraftPO(poId);
          return json({ status: 'SUCCESS', message: 'PO deleted.' });
        } catch (err) {
          return handleRepoError(err);
        }
      }
    }

    // POST /api/pos/:poId/cancel
    const cancelMatch = path.match(/^\/api\/pos\/([^/]+)\/cancel$/);
    if (cancelMatch && method === 'POST') {
      if (!canApproveOrCancel) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const poId = cancelMatch[1];
      const body = await readJson(request);
      const reason = body?.reason;

      try {
        await repo.cancelPO(poId, caller.user_id, reason);
        return json({ status: 'SUCCESS', message: 'PO cancelled.' });
      } catch (err) {
        return handleRepoError(err);
      }
    }

    // POST /api/pos/:poId/revisions/:revisionId/create-next
    const createNextMatch = path.match(/^\/api\/pos\/([^/]+)\/revisions\/([^/]+)\/create-next$/);
    if (createNextMatch && method === 'POST') {
      if (!canWrite) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const poId = createNextMatch[1];
      try {
        const revision = await repo.createNextRevision(poId, caller.user_id);
        return json({ status: 'SUCCESS', data: { revision } });
      } catch (err) {
        return handleRepoError(err);
      }
    }

    // PATCH /api/pos/:poId/revisions/:revisionId
    const patchRevMatch = path.match(/^\/api\/pos\/([^/]+)\/revisions\/([^/]+)$/);
    if (patchRevMatch && method === 'PATCH') {
      if (!canWrite) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const revisionId = patchRevMatch[2];
      const body = await readJson(request);
      try {
        const revision = await repo.updateRevisionOverview(revisionId, body);
        return json({ status: 'SUCCESS', data: { revision } });
      } catch (err) {
        return handleRepoError(err);
      }
    }

    // POST /api/pos/:poId/revisions/:revisionId/activate
    const activateMatch = path.match(/^\/api\/pos\/([^/]+)\/revisions\/([^/]+)\/activate$/);
    if (activateMatch && method === 'POST') {
      if (!canApproveOrCancel) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const revisionId = activateMatch[2];
      const body = await readJson(request);
      try {
        await repo.activateRevision(revisionId, caller.user_id, body?.approvalNote);
        return json({ status: 'SUCCESS', message: 'Revision activated.' });
      } catch (err) {
        return handleRepoError(err);
      }
    }

    // POST /api/pos/:poId/revisions/:revisionId/lines
    const linesMatch = path.match(/^\/api\/pos\/([^/]+)\/revisions\/([^/]+)\/lines$/);
    if (linesMatch && method === 'POST') {
      if (!canWrite) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const revisionId = linesMatch[2];
      const body = await readJson(request);
      try {
        const line = await repo.createPORevisionLine(revisionId, body);
        return json({ status: 'SUCCESS', data: { line } });
      } catch (err) {
        return handleRepoError(err);
      }
    }

    // PATCH/DELETE /api/pos/:poId/revisions/:revisionId/lines/:lineId
    const patchLineMatch = path.match(/^\/api\/pos\/([^/]+)\/revisions\/([^/]+)\/lines\/([^/]+)$/);
    if (patchLineMatch) {
      const lineId = patchLineMatch[3];

      if (method === 'PATCH') {
        if (!canWrite) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        const body = await readJson(request);
        try {
          const line = await repo.updatePORevisionLine(lineId, body);
          return json({ status: 'SUCCESS', data: { line } });
        } catch (err) {
          return handleRepoError(err);
        }
      }

      if (method === 'DELETE') {
        if (!canWrite) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        try {
          await repo.deletePORevisionLine(lineId);
          return json({ status: 'SUCCESS', message: 'Line deleted.' });
        } catch (err) {
          return handleRepoError(err);
        }
      }
    }

    // POST /api/pos/:poId/revisions/:revisionId/documents
    const docsMatch = path.match(/^\/api\/pos\/([^/]+)\/revisions\/([^/]+)\/documents$/);
    if (docsMatch && method === 'POST') {
      if (!canWrite) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const revisionId = docsMatch[2];
      const body = await readJson(request);
      try {
        const document = await repo.createPORevisionDocument(revisionId, body, caller.user_id);
        return json({ status: 'SUCCESS', data: { document } });
      } catch (err) {
        return handleRepoError(err);
      }
    }

    // PATCH/DELETE /api/pos/:poId/revisions/:revisionId/documents/:documentId
    const patchDocMatch = path.match(/^\/api\/pos\/([^/]+)\/revisions\/([^/]+)\/documents\/([^/]+)$/);
    if (patchDocMatch) {
      const documentId = patchDocMatch[3];

      if (method === 'PATCH') {
        if (!canWrite) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        const body = await readJson(request);
        try {
          const document = await repo.updatePORevisionDocument(documentId, body, caller.user_id);
          return json({ status: 'SUCCESS', data: { document } });
        } catch (err) {
          return handleRepoError(err);
        }
      }

      if (method === 'DELETE') {
        if (!canWrite) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        try {
          await repo.deletePORevisionDocument(documentId, caller.user_id);
          return json({ status: 'SUCCESS', message: 'Document deleted.' });
        } catch (err) {
          return handleRepoError(err);
        }
      }
    }

    return json({ status: 'ERROR', message: 'API route not found.' }, 404);
  };
}

function handleRepoError(err) {
  const code = err.code;
  const message = err.message;

  if (code === 'PO_PRICE_OVERRIDE_REASON_REQUIRED' ||
      code === 'PO_SPEC_REQUIRED' ||
      code === 'PO_EVIDENCE_REQUIRED' ||
      code === 'PO_REVISION_NOTE_REQUIRED' ||
      code === 'PO_VALIDITY_EXPIRED' ||
      code === 'PO_ALREADY_CANCELLED') {
    return json({ status: 'ERROR', message, code }, 400);
  }

  if (code === 'PO_CUSTOMER_PO_DUPLICATE') {
    return json({ status: 'ERROR', message, code }, 409);
  }

  if (code === 'PO_ACTIVE_IMMUTABLE') {
    return json({ status: 'ERROR', message, code }, 403);
  }

  return json({ status: 'ERROR', message }, 400);
}

export function createPOHandlerFromEnv(env) {
  return createPOHandler({
    repo: createPORepository(env.DB),
    resolveUser: resolveAuthenticatedUser,
    db: env.DB
  });
}
