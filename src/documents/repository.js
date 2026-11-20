async function scopedWorkspaceDetailReference(caller, deliveryInstructionId) {
  const source = `phase6-workspace:${caller.user_id}:${caller.role}:${deliveryInstructionId}`;
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hasDocumentAttachmentsTable(db) {
  if (!db?.prepare) return false;
  try {
    const row = await db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'document_attachments'"
    ).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

export function createDocumentsRepository(db) {
  async function resolveShipmentOrDiRecord(entityId, caller) {
    // 1. Direct lookup by shipment_id
    let row = await db.prepare(`
      SELECT
        s.shipment_id,
        di.di_id,
        di.customer_id,
        c.owner_user_id,
        pr.sales_owner_user_id_snapshot
      FROM phase6_shipments s
      JOIN delivery_instructions di ON di.di_id = s.di_id
      JOIN customers c ON c.customer_id = di.customer_id
      LEFT JOIN po_revisions pr ON pr.revision_id = di.po_revision_id
      WHERE s.shipment_id = ?
      LIMIT 1
    `).bind(entityId).first();
    if (row) {
      return {
        canonical_id: row.shipment_id,
        shipment_id: row.shipment_id,
        di_id: row.di_id,
        customer_id: row.customer_id,
        owner_user_id: row.owner_user_id || null,
        sales_owner_user_id: row.sales_owner_user_id_snapshot || null
      };
    }

    // 2. Lookup by di_id (canonicalize to shipment_id if shipment exists, else di_id for DRAFT DI)
    row = await db.prepare(`
      SELECT
        s.shipment_id,
        di.di_id,
        di.customer_id,
        c.owner_user_id,
        pr.sales_owner_user_id_snapshot
      FROM delivery_instructions di
      LEFT JOIN phase6_shipments s ON s.di_id = di.di_id
      JOIN customers c ON c.customer_id = di.customer_id
      LEFT JOIN po_revisions pr ON pr.revision_id = di.po_revision_id
      WHERE di.di_id = ?
      LIMIT 1
    `).bind(entityId).first();
    if (row) {
      return {
        canonical_id: row.shipment_id || row.di_id,
        shipment_id: row.shipment_id || null,
        di_id: row.di_id,
        customer_id: row.customer_id,
        owner_user_id: row.owner_user_id || null,
        sales_owner_user_id: row.sales_owner_user_id_snapshot || null
      };
    }

    // 3. Opaque workspace detail_ref resolution for restricted roles (EXTERNAL_SALES / PRODUCTION_WAREHOUSE)
    if (caller && /^[a-f0-9]{64}$/i.test(String(entityId || ''))) {
      const { results: candidates } = await db.prepare(`
        SELECT
          s.shipment_id,
          di.di_id,
          di.customer_id,
          c.owner_user_id,
          pr.sales_owner_user_id_snapshot
        FROM delivery_instructions di
        LEFT JOIN phase6_shipments s ON s.di_id = di.di_id
        JOIN customers c ON c.customer_id = di.customer_id
        LEFT JOIN po_revisions pr ON pr.revision_id = di.po_revision_id
      `).all();
      for (const candidate of candidates || []) {
        const ref = await scopedWorkspaceDetailReference(caller, candidate.di_id);
        if (ref === entityId) {
          return {
            canonical_id: candidate.shipment_id || candidate.di_id,
            shipment_id: candidate.shipment_id || null,
            di_id: candidate.di_id,
            customer_id: candidate.customer_id,
            owner_user_id: candidate.owner_user_id || null,
            sales_owner_user_id: candidate.sales_owner_user_id_snapshot || null
          };
        }
      }
    }

    return null;
  }

  return {
    async resolveEntityContext(entityType, entityId, caller) {
      const id = String(entityId || '').trim();
      if (!id) return null;

      if (entityType === 'PO') {
        const row = await db.prepare(`
          SELECT
            po.po_id,
            po.customer_id,
            c.owner_user_id,
            (
              SELECT pr.sales_owner_user_id_snapshot
              FROM po_revisions pr
              WHERE pr.po_id = po.po_id AND pr.status = 'ACTIVE'
              ORDER BY pr.revision_no DESC
              LIMIT 1
            ) AS sales_owner_user_id
          FROM po_headers po
          JOIN customers c ON c.customer_id = po.customer_id
          WHERE po.po_id = ?
          LIMIT 1
        `).bind(id).first();
        if (!row) return null;
        return {
          entity_type: 'PO',
          entity_id: row.po_id,
          customer_id: row.customer_id,
          owner_user_id: row.owner_user_id || null,
          sales_owner_user_id: row.sales_owner_user_id || null
        };
      }

      if (entityType === 'SHIPMENT' || entityType === 'PAYMENT') {
        const resolved = await resolveShipmentOrDiRecord(id, caller);
        if (!resolved) return null;
        if (entityType === 'PAYMENT' && !resolved.shipment_id) return null;
        return {
          entity_type: entityType,
          entity_id: resolved.canonical_id,
          shipment_id: resolved.shipment_id,
          di_id: resolved.di_id,
          customer_id: resolved.customer_id,
          owner_user_id: resolved.owner_user_id,
          sales_owner_user_id: resolved.sales_owner_user_id
        };
      }

      return null;
    },

    async listAttachments({ entityType, entityId, allowedCategories, docCategory = null }) {
      if (!Array.isArray(allowedCategories) || allowedCategories.length === 0) {
        return [];
      }
      const categories = docCategory ? [docCategory] : allowedCategories;
      const placeholders = categories.map(() => '?').join(', ');
      const { results } = await db.prepare(`
        SELECT
          da.id,
          da.entity_type,
          da.entity_id,
          da.doc_category,
          da.file_name,
          da.content_type,
          da.file_size,
          da.r2_key,
          da.uploaded_by,
          COALESCE(u.full_name, da.uploaded_by) AS uploaded_by_name,
          da.uploaded_at
        FROM document_attachments da
        LEFT JOIN users u ON u.user_id = da.uploaded_by
        WHERE da.entity_type = ?
          AND da.entity_id = ?
          AND da.doc_category IN (${placeholders})
        ORDER BY da.uploaded_at DESC, da.rowid DESC
      `).bind(entityType, entityId, ...categories).all();
      return (results || []).map((row) => ({
        ...row,
        file_size: Number(row.file_size || 0)
      }));
    },

    async createAttachment(record) {
      await db.prepare(`
        INSERT INTO document_attachments (
          id, entity_type, entity_id, doc_category, file_name,
          content_type, file_size, r2_key, uploaded_by, uploaded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        record.id,
        record.entity_type,
        record.entity_id,
        record.doc_category,
        record.file_name,
        record.content_type,
        record.file_size,
        record.r2_key,
        record.uploaded_by,
        record.uploaded_at
      ).run();

      return this.getAttachmentById(record.id);
    },

    async getAttachmentById(id) {
      const row = await db.prepare(`
        SELECT
          da.id,
          da.entity_type,
          da.entity_id,
          da.doc_category,
          da.file_name,
          da.content_type,
          da.file_size,
          da.r2_key,
          da.uploaded_by,
          COALESCE(u.full_name, da.uploaded_by) AS uploaded_by_name,
          da.uploaded_at
        FROM document_attachments da
        LEFT JOIN users u ON u.user_id = da.uploaded_by
        WHERE da.id = ?
        LIMIT 1
      `).bind(id).first();
      if (!row) return null;
      return {
        ...row,
        file_size: Number(row.file_size || 0)
      };
    },

    async deleteAttachment(id) {
      await db.prepare('DELETE FROM document_attachments WHERE id = ?').bind(id).run();
    },

    async getEarliestAllShipDocUpload(shipmentId) {
      if (!shipmentId) return null;
      const row = await db.prepare(`
        SELECT MIN(uploaded_at) AS first_uploaded_at
        FROM document_attachments
        WHERE entity_type = 'SHIPMENT'
          AND entity_id = ?
          AND doc_category = 'ALL_SHIP_DOC'
      `).bind(shipmentId).first();
      return row?.first_uploaded_at || null;
    }
  };
}

export async function getShipmentAttachmentSummaryMap(db, shipmentIds = []) {
  const map = new Map();
  const ids = [...new Set((shipmentIds || []).filter(Boolean))];
  if (ids.length === 0) return map;
  if (!(await hasDocumentAttachmentsTable(db))) return map;

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db.prepare(`
    SELECT
      entity_id,
      SUM(CASE WHEN entity_type = 'SHIPMENT' AND doc_category = 'STUFFING_REPORT' THEN 1 ELSE 0 END) AS stuffing_report_count,
      SUM(CASE WHEN entity_type = 'SHIPMENT' AND doc_category = 'ALL_SHIP_DOC' THEN 1 ELSE 0 END) AS all_ship_doc_count,
      SUM(CASE WHEN entity_type = 'SHIPMENT' AND doc_category = 'DI' THEN 1 ELSE 0 END) AS di_doc_count,
      SUM(CASE WHEN entity_type = 'PAYMENT' AND doc_category = 'PAYMENT_SLIP' THEN 1 ELSE 0 END) AS payment_slip_count,
      MIN(CASE WHEN entity_type = 'SHIPMENT' AND doc_category = 'ALL_SHIP_DOC' THEN uploaded_at END) AS all_ship_doc_uploaded_at
    FROM document_attachments
    WHERE entity_id IN (${placeholders})
      AND entity_type IN ('SHIPMENT', 'PAYMENT')
    GROUP BY entity_id
  `).bind(...ids).all();

  for (const row of results || []) {
    const stuffingCount = Number(row.stuffing_report_count || 0);
    const allShipCount = Number(row.all_ship_doc_count || 0);
    map.set(row.entity_id, {
      stuffing_report_count: stuffingCount,
      all_ship_doc_count: allShipCount,
      customer_docs_count: stuffingCount + allShipCount,
      di_doc_count: Number(row.di_doc_count || 0),
      payment_slip_count: Number(row.payment_slip_count || 0),
      all_ship_doc_uploaded_at: row.all_ship_doc_uploaded_at || null
    });
  }
  return map;
}
