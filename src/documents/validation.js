export const ENTITY_TYPES = ['PO', 'SHIPMENT', 'PAYMENT'];

export const DOC_CATEGORIES = ['PO', 'DI', 'STUFFING_REPORT', 'ALL_SHIP_DOC', 'PAYMENT_SLIP'];

export const ENTITY_CATEGORY_MAP = {
  PO: ['PO'],
  SHIPMENT: ['DI', 'STUFFING_REPORT', 'ALL_SHIP_DOC'],
  PAYMENT: ['PAYMENT_SLIP']
};

export const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp'
];

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

const EXTENSION_TO_MIME = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp'
};

const FULL_ACCESS_ROLES = ['ADMIN', 'MANAGER', 'SALES_SUPPORT'];

export function normalizeEntityType(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return ENTITY_TYPES.includes(normalized) ? normalized : null;
}

export function normalizeDocCategory(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return DOC_CATEGORIES.includes(normalized) ? normalized : null;
}

export function isCategoryValidForEntity(entityType, docCategory) {
  const allowed = ENTITY_CATEGORY_MAP[entityType];
  return Array.isArray(allowed) && allowed.includes(docCategory);
}

export function getReadableCategoriesForRole(role, entityType = null) {
  let categories = [];
  if (FULL_ACCESS_ROLES.includes(role)) {
    categories = [...DOC_CATEGORIES];
  } else if (role === 'EXPORT') {
    categories = [...DOC_CATEGORIES];
  } else if (role === 'EXTERNAL_SALES') {
    categories = ['PO', 'STUFFING_REPORT', 'ALL_SHIP_DOC'];
  } else if (role === 'PRODUCTION_WAREHOUSE') {
    categories = ['DI'];
  }
  if (!entityType) return categories;
  const entityCategories = ENTITY_CATEGORY_MAP[entityType] || [];
  return categories.filter((c) => entityCategories.includes(c));
}

export function canRoleReadCategory(role, docCategory) {
  return getReadableCategoriesForRole(role).includes(docCategory);
}

export function canRoleUploadCategory(role, entityType, docCategory) {
  if (!isCategoryValidForEntity(entityType, docCategory)) return false;
  if (FULL_ACCESS_ROLES.includes(role)) return true;
  if (role === 'EXPORT') {
    return entityType === 'SHIPMENT' && ['DI', 'STUFFING_REPORT', 'ALL_SHIP_DOC'].includes(docCategory);
  }
  if (role === 'EXTERNAL_SALES') {
    return entityType === 'PO' && docCategory === 'PO';
  }
  return false;
}

export function canCallerDeleteAttachment(caller, attachment) {
  if (!caller || !attachment) return false;
  const role = caller.role;
  const category = attachment.doc_category;
  const entityType = attachment.entity_type;

  if (role === 'ADMIN' || role === 'MANAGER' || role === 'SALES_SUPPORT') {
    return true;
  }
  if (role === 'EXPORT') {
    return entityType === 'SHIPMENT' && ['DI', 'STUFFING_REPORT', 'ALL_SHIP_DOC'].includes(category);
  }
  if (role === 'EXTERNAL_SALES') {
    return entityType === 'PO' && category === 'PO' && attachment.uploaded_by === caller.user_id;
  }
  return false;
}

export function sanitizeFileName(rawName) {
  const base = String(rawName || 'document')
    .replace(/^.*[/\\]/, '')
    .replace(/[\r\n\t\0"]/g, '')
    .replace(/[^\p{L}\p{N}._\-() ]+/gu, '_')
    .trim();
  if (!base) return 'document';
  return base.slice(0, 180);
}

export function resolveAllowedContentType(rawType, fileName) {
  const normalized = String(rawType || '').split(';')[0].trim().toLowerCase();
  if (ALLOWED_CONTENT_TYPES.includes(normalized)) {
    return normalized;
  }
  if (!normalized || normalized === 'application/octet-stream') {
    const lowerName = String(fileName || '').trim().toLowerCase();
    for (const [ext, mime] of Object.entries(EXTENSION_TO_MIME)) {
      if (lowerName.endsWith(ext)) return mime;
    }
  }
  return null;
}
