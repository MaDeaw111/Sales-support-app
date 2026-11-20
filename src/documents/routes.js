import { resolveAuthenticatedUser } from '../auth/routes.js';
import { createDocumentsRepository } from './repository.js';
import {
  MAX_FILE_SIZE_BYTES,
  normalizeEntityType,
  normalizeDocCategory,
  isCategoryValidForEntity,
  getReadableCategoriesForRole,
  canRoleReadCategory,
  canRoleUploadCategory,
  canCallerDeleteAttachment,
  sanitizeFileName,
  resolveAllowedContentType
} from './validation.js';

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function safeDecodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isOwnedByExternalSales(caller, context) {
  if (caller.role !== 'EXTERNAL_SALES') return true;
  if (!context) return false;
  return context.owner_user_id === caller.user_id || context.sales_owner_user_id === caller.user_id;
}

function formatPublicAttachment(row, caller) {
  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    doc_category: row.doc_category,
    file_name: row.file_name,
    content_type: row.content_type,
    file_size: Number(row.file_size || 0),
    uploaded_by: row.uploaded_by,
    uploaded_by_name: row.uploaded_by_name || row.uploaded_by,
    uploaded_at: row.uploaded_at,
    can_delete: canCallerDeleteAttachment(caller, row)
  };
}

export function createDocumentsHandler({ repo, resolveUser, db, bucket }) {
  const activeRepo = repo || createDocumentsRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const activeBucket = bucket || env?.DOCS_BUCKET;
    const caller = await activeResolveUser(request, env);
    if (!caller) return json({ status: 'ERROR', message: 'Authentication required.' }, 401);

    const url = new URL(request.url);
    const { pathname: path } = url;
    const { method } = request;

    // 1. LIST ATTACHMENTS: GET /api/documents?entityType=...&entityId=...(&docCategory=...)
    if (path === '/api/documents' && method === 'GET') {
      const entityType = normalizeEntityType(url.searchParams.get('entityType'));
      const entityId = String(url.searchParams.get('entityId') || '').trim();
      const rawCategory = url.searchParams.get('docCategory');
      const requestedCategory = rawCategory ? normalizeDocCategory(rawCategory) : null;

      if (!entityType || !entityId) {
        return json({ status: 'ERROR', message: 'entityType and entityId are required.' }, 400);
      }
      if (rawCategory && (!requestedCategory || !isCategoryValidForEntity(entityType, requestedCategory))) {
        return json({ status: 'ERROR', message: 'Invalid docCategory for entityType.' }, 400);
      }

      const readableCategories = getReadableCategoriesForRole(caller.role, entityType);
      if (readableCategories.length === 0) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      if (requestedCategory && !readableCategories.includes(requestedCategory)) {
        return json({ status: 'ERROR', message: 'Permission denied for requested document category.' }, 403);
      }

      const context = await activeRepo.resolveEntityContext(entityType, entityId, caller);
      if (!context) {
        return json({ status: 'ERROR', message: 'Target record not found.' }, 404);
      }
      if (!isOwnedByExternalSales(caller, context)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }

      const rows = await activeRepo.listAttachments({
        entityType: context.entity_type,
        entityId: context.entity_id,
        allowedCategories: readableCategories,
        docCategory: requestedCategory
      });

      let allShipDocUploadedAt = null;
      if (entityType === 'PAYMENT' && context.shipment_id) {
        allShipDocUploadedAt = await activeRepo.getEarliestAllShipDocUpload(context.shipment_id);
      } else if (entityType === 'SHIPMENT') {
        const allShipDocs = rows.filter((r) => r.doc_category === 'ALL_SHIP_DOC');
        if (allShipDocs.length > 0) {
          allShipDocUploadedAt = allShipDocs.reduce(
            (min, r) => (!min || r.uploaded_at < min ? r.uploaded_at : min),
            null
          );
        }
      }

      return json({
        status: 'SUCCESS',
        data: {
          entityType: context.entity_type,
          entityId: context.entity_id,
          readableCategories,
          allShipDocUploadedAt,
          documents: rows.map((row) => formatPublicAttachment(row, caller))
        }
      });
    }

    // 2. UPLOAD ATTACHMENTS: POST /api/documents/upload
    if (path === '/api/documents/upload' && method === 'POST') {
      if (!activeBucket) {
        return json({ status: 'ERROR', message: 'R2 DOCS_BUCKET binding is not configured.' }, 503);
      }

      let formData;
      try {
        formData = await request.formData();
      } catch {
        return json({ status: 'ERROR', message: 'Expected multipart/form-data payload.' }, 400);
      }

      const entityType = normalizeEntityType(formData.get('entityType'));
      const entityId = String(formData.get('entityId') || '').trim();
      const docCategory = normalizeDocCategory(formData.get('docCategory'));

      if (!entityType || !entityId || !docCategory) {
        return json({ status: 'ERROR', message: 'entityType, entityId, and docCategory are required.' }, 400);
      }
      if (!isCategoryValidForEntity(entityType, docCategory)) {
        return json({ status: 'ERROR', message: `docCategory ${docCategory} is not valid for entityType ${entityType}.` }, 400);
      }
      if (!canRoleUploadCategory(caller.role, entityType, docCategory)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }

      const context = await activeRepo.resolveEntityContext(entityType, entityId, caller);
      if (!context) {
        return json({ status: 'ERROR', message: 'Target record not found.' }, 404);
      }
      if (!isOwnedByExternalSales(caller, context)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }

      const rawFiles = [
        ...formData.getAll('files'),
        ...formData.getAll('file')
      ].filter((entry) => entry && typeof entry === 'object' && typeof entry.arrayBuffer === 'function');

      if (rawFiles.length === 0) {
        return json({ status: 'ERROR', message: 'At least one file is required.' }, 400);
      }

      const preparedFiles = [];
      for (const file of rawFiles) {
        const cleanName = sanitizeFileName(file.name);
        const contentType = resolveAllowedContentType(file.type, cleanName);
        if (!contentType) {
          return json({
            status: 'ERROR',
            message: `Unsupported file type for "${cleanName}". Allowed types: PDF, JPEG, PNG, WEBP.`
          }, 400);
        }
        const bytes = await file.arrayBuffer();
        const fileSize = bytes.byteLength;
        if (fileSize <= 0) {
          return json({ status: 'ERROR', message: `File "${cleanName}" is empty.` }, 400);
        }
        if (fileSize > MAX_FILE_SIZE_BYTES) {
          return json({
            status: 'ERROR',
            message: `File "${cleanName}" exceeds the 10 MB size limit.`
          }, 400);
        }
        preparedFiles.push({ cleanName, contentType, bytes, fileSize });
      }

      const created = [];
      const uploadedAt = new Date().toISOString();

      for (const item of preparedFiles) {
        const id = `DOC-${crypto.randomUUID()}`;
        const r2Key = `${context.entity_type.toLowerCase()}/${context.entity_id}/${docCategory.toLowerCase()}/${id}-${item.cleanName}`;

        await activeBucket.put(r2Key, item.bytes, {
          httpMetadata: { contentType: item.contentType },
          customMetadata: {
            entityType: context.entity_type,
            entityId: context.entity_id,
            docCategory,
            uploadedBy: caller.user_id
          }
        });

        try {
          const saved = await activeRepo.createAttachment({
            id,
            entity_type: context.entity_type,
            entity_id: context.entity_id,
            doc_category: docCategory,
            file_name: item.cleanName,
            content_type: item.contentType,
            file_size: item.fileSize,
            r2_key: r2Key,
            uploaded_by: caller.user_id,
            uploaded_at: uploadedAt
          });
          created.push(formatPublicAttachment(saved, caller));
        } catch (err) {
          try {
            await activeBucket.delete(r2Key);
          } catch {
            // Best-effort cleanup
          }
          throw err;
        }
      }

      return json({
        status: 'SUCCESS',
        data: {
          document: created[0],
          documents: created
        }
      }, 201);
    }

    // 3. PREVIEW / DOWNLOAD ATTACHMENT: GET /api/documents/:id/download
    const downloadMatch = path.match(/^\/api\/documents\/([^/]+)\/download$/);
    if (downloadMatch && method === 'GET') {
      if (!activeBucket) {
        return json({ status: 'ERROR', message: 'R2 DOCS_BUCKET binding is not configured.' }, 503);
      }
      const id = safeDecodeParam(downloadMatch[1]);
      if (!id) return json({ status: 'ERROR', message: 'Invalid document id.' }, 400);

      const attachment = await activeRepo.getAttachmentById(id);
      if (!attachment) return json({ status: 'ERROR', message: 'Document not found.' }, 404);

      if (!canRoleReadCategory(caller.role, attachment.doc_category)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }

      const context = await activeRepo.resolveEntityContext(attachment.entity_type, attachment.entity_id, caller);
      if (!context || !isOwnedByExternalSales(caller, context)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }

      const object = await activeBucket.get(attachment.r2_key);
      if (!object) {
        return json({ status: 'ERROR', message: 'Document file not found in storage.' }, 404);
      }

      const isAttachmentDownload = url.searchParams.get('download') === '1';
      const dispositionType = isAttachmentDownload ? 'attachment' : 'inline';
      const asciiFallback = attachment.file_name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
      const headers = new Headers({
        'content-type': attachment.content_type || 'application/octet-stream',
        'content-disposition': `${dispositionType}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(attachment.file_name)}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=300'
      });
      if (attachment.file_size > 0) {
        headers.set('content-length', String(attachment.file_size));
      }

      return new Response(object.body, { status: 200, headers });
    }

    // 4. DELETE ATTACHMENT: DELETE /api/documents/:id
    const deleteMatch = path.match(/^\/api\/documents\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      if (!activeBucket) {
        return json({ status: 'ERROR', message: 'R2 DOCS_BUCKET binding is not configured.' }, 503);
      }
      const id = safeDecodeParam(deleteMatch[1]);
      if (!id) return json({ status: 'ERROR', message: 'Invalid document id.' }, 400);

      const attachment = await activeRepo.getAttachmentById(id);
      if (!attachment) return json({ status: 'ERROR', message: 'Document not found.' }, 404);

      const context = await activeRepo.resolveEntityContext(attachment.entity_type, attachment.entity_id, caller);
      if (!context || !isOwnedByExternalSales(caller, context)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }

      if (!canCallerDeleteAttachment(caller, attachment)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }

      await activeBucket.delete(attachment.r2_key);
      await activeRepo.deleteAttachment(id);

      return json({
        status: 'SUCCESS',
        data: { deletedId: id }
      });
    }

    return json({ status: 'ERROR', message: 'Document route not found.' }, 404);
  };
}

export function createDocumentsHandlerFromEnv(env) {
  return createDocumentsHandler({
    db: env.DB,
    bucket: env.DOCS_BUCKET,
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
