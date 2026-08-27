import crypto from 'node:crypto';

function wrapDb(db) {
  if (!db) throw new Error('D1 DB binding is required.');
  
  const testStmt = db.prepare('SELECT 1');
  const isD1 = typeof testStmt.bind === 'function';
  
  if (isD1) {
    return db;
  }
  
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        _params: [],
        bind(...args) {
          this._params = args;
          return this;
        },
        async first() {
          const rows = stmt.all(...this._params);
          return rows[0] || null;
        },
        async run() {
          const res = stmt.run(...this._params);
          return { success: true, meta: res };
        },
        async all() {
          const rows = stmt.all(...this._params);
          return { results: rows, success: true };
        }
      };
    },
    async batch(statements) {
      const results = [];
      db.exec("BEGIN TRANSACTION");
      try {
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return results;
    }
  };
}

async function checkCustomerPoNoUnique(db, customerId, poId, customerPoNo) {
  if (!customerPoNo || !customerPoNo.trim()) return;
  const duplicate = await db.prepare(`
    SELECT 1 
    FROM po_revisions r
    JOIN po_headers h ON r.po_id = h.po_id
    WHERE h.customer_id = ?
      AND h.po_id != ?
      AND r.customer_po_no = ?
    LIMIT 1
  `).bind(customerId, poId || '', customerPoNo).first();
  
  if (duplicate) {
    const err = new Error(`Duplicate customer PO number: ${customerPoNo}`);
    err.code = 'PO_CUSTOMER_PO_DUPLICATE';
    throw err;
  }
}

async function validateSpecReference(db, productId, specSource, specRevisionId) {
  if (specSource === 'STANDARD') {
    const spec = await db.prepare("SELECT product_id, status FROM standard_specs WHERE standard_spec_id = ?").bind(specRevisionId).first();
    if (!spec) {
      throw new Error('Specification not found');
    }
    if (spec.product_id !== productId) {
      throw new Error('Product spec mismatch');
    }
    return spec;
  } else if (specSource === 'CUSTOMER') {
    const spec = await db.prepare("SELECT product_id, status FROM customer_specs WHERE customer_spec_id = ?").bind(specRevisionId).first();
    if (!spec) {
      throw new Error('Specification not found');
    }
    if (spec.product_id !== productId) {
      throw new Error('Product spec mismatch');
    }
    return spec;
  } else {
    throw new Error('Invalid spec source');
  }
}

async function matchManagerPriceNote(db, customerId, productId, incoterm, ownershipType, salesOwnerUserId) {
  let note;
  if (ownershipType === 'ASSIGNED_SALES') {
    note = await db.prepare(`
      SELECT note_id, offer_price_usd_per_mt 
      FROM manager_price_notes 
      WHERE sales_user_id = ? 
        AND customer_id = ? 
        AND product_id = ? 
        AND incoterm = ?
      ORDER BY created_at DESC 
      LIMIT 1
    `).bind(salesOwnerUserId, customerId, productId, incoterm).first();
  } else {
    note = await db.prepare(`
      SELECT note_id, offer_price_usd_per_mt 
      FROM manager_price_notes 
      WHERE sales_user_id IS NULL 
        AND customer_id = ? 
        AND product_id = ? 
        AND incoterm = ?
      ORDER BY created_at DESC 
      LIMIT 1
    `).bind(customerId, productId, incoterm).first();
  }
  return note || null;
}

async function logPOAuditEvent(db, poId, revisionId, eventType, actorId, detailsObj) {
  const eventId = `EVT-${crypto.randomUUID()}`;
  const metadata = detailsObj ? JSON.stringify(detailsObj) : null;
  await db.prepare(`
    INSERT INTO po_audit_events (event_id, po_id, po_revision_id, event_type, actor_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(eventId, poId, revisionId, eventType, actorId, metadata).run();
}

async function enforceNotSuperseded(db, revisionId) {
  const revision = await db.prepare("SELECT status, po_id FROM po_revisions WHERE revision_id = ?").bind(revisionId).first();
  if (!revision) {
    throw new Error(`Revision not found: ${revisionId}`);
  }
  if (revision.status === 'SUPERSEDED') {
    const err = new Error('Superseded revision is immutable');
    err.code = 'PO_SUPERSEDED_IMMUTABLE';
    throw err;
  }
  return revision;
}

async function enforceNotSupersededByDocId(db, documentId) {
  const doc = await db.prepare("SELECT po_revision_id FROM po_revision_documents WHERE document_id = ?").bind(documentId).first();
  if (!doc) {
    throw new Error(`Document not found: ${documentId}`);
  }
  const revision = await enforceNotSuperseded(db, doc.po_revision_id);
  return { revisionId: doc.po_revision_id, poId: revision.po_id };
}

async function enforceNotCancelledByPoId(db, poId) {
  const header = await db.prepare("SELECT header_status FROM po_headers WHERE po_id = ?").bind(poId).first();
  if (header && header.header_status === 'CANCELLED') {
    const err = new Error('PO is already cancelled');
    err.code = 'PO_ALREADY_CANCELLED';
    throw err;
  }
}

async function enforceNotCancelledByRevisionId(db, revisionId) {
  const revision = await db.prepare("SELECT po_id FROM po_revisions WHERE revision_id = ?").bind(revisionId).first();
  if (revision) {
    await enforceNotCancelledByPoId(db, revision.po_id);
  }
}

async function enforceNotCancelledByLineId(db, lineId) {
  const line = await db.prepare("SELECT po_revision_id FROM po_revision_lines WHERE line_id = ?").bind(lineId).first();
  if (line) {
    await enforceNotCancelledByRevisionId(db, line.po_revision_id);
  }
}

async function enforceNotCancelledByDocId(db, documentId) {
  const doc = await db.prepare("SELECT po_revision_id FROM po_revision_documents WHERE document_id = ?").bind(documentId).first();
  if (doc) {
    await enforceNotCancelledByRevisionId(db, doc.po_revision_id);
  }
}

function validateUrl(url) {
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    throw new Error('Invalid document URL: must begin with http:// or https://');
  }
}

async function generateAndLogFieldDiffs(db, poId, newRevisionId, oldRevisionId, statements) {
  const oldRev = await db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").bind(oldRevisionId).first();
  const newRev = await db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").bind(newRevisionId).first();
  if (!oldRev || !newRev) return;

  // 1. Compare overview fields
  const overviewFields = [
    'customer_po_no', 'po_date', 'buyer_reference', 'currency', 'incoterm',
    'destination', 'delivery_start', 'delivery_end', 'valid_until',
    'payment_term_snapshot', 'commercial_terms', 'operational_note'
  ];

  for (const field of overviewFields) {
    const oldVal = oldRev[field];
    const newVal = newRev[field];

    const normalizedOld = oldVal === undefined ? null : oldVal;
    const normalizedNew = newVal === undefined ? null : newVal;

    if (normalizedOld !== normalizedNew) {
      const diffId = `DIFF-${crypto.randomUUID()}`;
      const oldStr = normalizedOld !== null ? String(normalizedOld) : null;
      const newStr = normalizedNew !== null ? String(normalizedNew) : null;

      statements.push(
        db.prepare(`
          INSERT INTO po_field_diffs (diff_id, po_revision_id, entity_type, entity_id, field_name, old_value, new_value)
          VALUES (?, ?, 'REVISION', ?, ?, ?, ?)
        `).bind(diffId, newRevisionId, newRevisionId, field, oldStr, newStr)
      );
    }
  }

  // 2. Compare line fields
  const { results: oldLines } = await db.prepare("SELECT * FROM po_revision_lines WHERE po_revision_id = ?").bind(oldRevisionId).all();
  const { results: newLines } = await db.prepare("SELECT * FROM po_revision_lines WHERE po_revision_id = ?").bind(newRevisionId).all();

  const oldLinesMap = new Map((oldLines || []).map(l => [l.line_id, l]));
  const newLinesMapByPrevId = new Map((newLines || []).filter(l => l.previous_line_id).map(l => [l.previous_line_id, l]));

  const lineFields = [
    'contract_qty_mt', 'tolerance_pct', 'unit_price', 'packaging',
    'container_type', 'loading_pattern', 'commission_recipient_user_id',
    'commission_rate_usd_mt', 'commercial_line_term', 'operational_line_note'
  ];

  for (const newLine of newLines || []) {
    if (newLine.previous_line_id && oldLinesMap.has(newLine.previous_line_id)) {
      const oldLine = oldLinesMap.get(newLine.previous_line_id);
      for (const field of lineFields) {
        const oldVal = oldLine[field];
        const newVal = newLine[field];

        const normalizedOld = oldVal === undefined ? null : oldVal;
        const normalizedNew = newVal === undefined ? null : newVal;

        if (normalizedOld !== normalizedNew) {
          const diffId = `DIFF-${crypto.randomUUID()}`;
          const oldStr = normalizedOld !== null ? String(normalizedOld) : null;
          const newStr = normalizedNew !== null ? String(normalizedNew) : null;

          statements.push(
            db.prepare(`
              INSERT INTO po_field_diffs (diff_id, po_revision_id, entity_type, entity_id, field_name, old_value, new_value)
              VALUES (?, ?, 'LINE', ?, ?, ?, ?)
            `).bind(diffId, newRevisionId, newLine.line_id, field, oldStr, newStr)
          );
        }
      }
    } else {
      // New line added
      const diffId = `DIFF-${crypto.randomUUID()}`;
      statements.push(
        db.prepare(`
          INSERT INTO po_field_diffs (diff_id, po_revision_id, entity_type, entity_id, field_name, old_value, new_value)
          VALUES (?, ?, 'LINE', ?, 'line_added', NULL, ?)
        `).bind(diffId, newRevisionId, newLine.line_id, String(newLine.line_no))
      );
    }
  }

  for (const oldLine of oldLines || []) {
    if (!newLinesMapByPrevId.has(oldLine.line_id)) {
      // Line removed
      const diffId = `DIFF-${crypto.randomUUID()}`;
      statements.push(
        db.prepare(`
          INSERT INTO po_field_diffs (diff_id, po_revision_id, entity_type, entity_id, field_name, old_value, new_value)
          VALUES (?, ?, 'LINE', ?, 'line_removed', ?, NULL)
        `).bind(diffId, newRevisionId, oldLine.line_id, String(oldLine.line_no))
      );
    }
  }
}

export function createPORepository(dbBinding) {
  const db = wrapDb(dbBinding);
  
  return {
    async createDraftPO(dto, creatorId) {
      if (!dto.customerId) {
        throw new Error('customerId is required to create a PO');
      }

      // 1. CRM Ownership validation logic:
      const customer = await db.prepare("SELECT owner_user_id FROM customers WHERE customer_id = ?").bind(dto.customerId).first();
      if (!customer) {
        throw new Error(`Customer not found for customer_id: ${dto.customerId}`);
      }
      
      let ownership_type_snapshot = 'HOUSE_ACCOUNT';
      let sales_owner_user_id_snapshot = null;
      
      let ownerUserId = customer.owner_user_id;
      let ownershipType = ownerUserId ? 'ASSIGNED_SALES' : 'HOUSE_ACCOUNT';
      
      if (dto.ownershipType) {
        ownershipType = dto.ownershipType;
      }
      if (dto.salesOwnerUserId !== undefined) {
        ownerUserId = dto.salesOwnerUserId;
      }
      
      if (ownershipType === 'ASSIGNED_SALES') {
        if (!ownerUserId) {
          const err = new Error('Sales owner user required for ASSIGNED_SALES');
          err.code = 'PO_CUSTOMER_OWNER_REQUIRED';
          throw err;
        }
        
        // Validate that the owner exists in users and is active
        const user = await db.prepare("SELECT status FROM users WHERE user_id = ?").bind(ownerUserId).first();
        if (!user || user.status !== 'ACTIVE') {
          const err = new Error('Invalid sales owner user or user is inactive');
          err.code = 'PO_CUSTOMER_OWNER_REQUIRED';
          throw err;
        }
        ownership_type_snapshot = 'ASSIGNED_SALES';
        sales_owner_user_id_snapshot = ownerUserId;
      } else {
        ownership_type_snapshot = 'HOUSE_ACCOUNT';
        sales_owner_user_id_snapshot = null;
      }
      
      // 2. ID Sequence Generation:
      let year = new Date().getFullYear();
      if (dto.poDate) {
        const match = dto.poDate.match(/^(\d{4})/);
        if (match) {
          year = parseInt(match[1], 10);
        }
      }
      
      const prefix = `PO-${year}-`;
      const row = await db.prepare(`
        SELECT COALESCE(MAX(CAST(SUBSTR(po_id, 9) AS INTEGER)), 0) AS max_seq
        FROM po_headers
        WHERE po_id LIKE ?
      `).bind(prefix + '%').first();
      
      const nextSeq = (row?.max_seq || 0) + 1;
      const poId = `PO-${year}-${String(nextSeq).padStart(3, '0')}`;
      
      // Validate customer PO number uniqueness
      if (dto.customerPoNo) {
        await checkCustomerPoNoUnique(db, dto.customerId, poId, dto.customerPoNo);
      }
      
      // 3. Set Defaults & values from DTO
      const revisionId = `REV-${crypto.randomUUID()}`;
      const customerPoNo = dto.customerPoNo || null;
      const poDate = dto.poDate || new Date().toISOString().split('T')[0];
      const buyerReference = dto.buyerReference || null;
      const customerContactId = dto.customerContactId || null;
      
      let customerContactSnapshotJson = null;
      if (customerContactId) {
        const contact = await db.prepare("SELECT contact_name, email, phone FROM customer_contacts WHERE contact_id = ?").bind(customerContactId).first();
        if (contact) {
          customerContactSnapshotJson = JSON.stringify({
            name: contact.contact_name,
            email: contact.email,
            phone: contact.phone
          });
        }
      }
      
      const currency = dto.currency || 'USD';
      const incoterm = dto.incoterm || 'FOB';
      const destination = dto.destination || null;
      const deliveryStart = dto.deliveryStart || '';
      const deliveryEnd = dto.deliveryEnd || '';
      const validUntil = dto.validUntil || '';
      const paymentTermSnapshot = dto.paymentTermSnapshot || null;
      const commercialTerms = dto.commercialTerms || null;
      const operationalNote = dto.operationalNote || null;
      const revisionNote = dto.revisionNote || null;
      
      // Create Insert statements in safe order:
      // A. Insert Header with NULL revision reference
      const headerStmt = db.prepare(`
        INSERT INTO po_headers (
          po_id, customer_id, header_status, current_active_revision_id, current_draft_revision_id, created_by
        ) VALUES (?, ?, ?, NULL, NULL, ?)
      `).bind(poId, dto.customerId, 'OPEN', creatorId);
      
      // B. Insert Revision referencing the Header
      const revisionStmt = db.prepare(`
        INSERT INTO po_revisions (
          revision_id, po_id, revision_no, status, customer_po_no, po_date, buyer_reference,
          ownership_type_snapshot, sales_owner_user_id_snapshot, customer_contact_id, customer_contact_snapshot_json,
          currency, incoterm, destination, delivery_start, delivery_end, valid_until,
          payment_term_snapshot, commercial_terms, operational_note, revision_note, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        revisionId, poId, 0, 'DRAFT', customerPoNo, poDate, buyerReference,
        ownership_type_snapshot, sales_owner_user_id_snapshot, customerContactId, customerContactSnapshotJson,
        currency, incoterm, destination, deliveryStart, deliveryEnd, validUntil,
        paymentTermSnapshot, commercialTerms, operationalNote, revisionNote, creatorId
      );
      
      // C. Update Header to set current_draft_revision_id
      const updateHeaderStmt = db.prepare(`
        UPDATE po_headers
        SET current_draft_revision_id = ?
        WHERE po_id = ?
      `).bind(revisionId, poId);

      // Batch execute insertion & updates
      await db.batch([headerStmt, revisionStmt, updateHeaderStmt]);
      
      // Retrieve the newly created objects to return
      const createdHeader = await db.prepare("SELECT * FROM po_headers WHERE po_id = ?").bind(poId).first();
      const createdRevision = await db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").bind(revisionId).first();
      
      return {
        header: createdHeader,
        revision: createdRevision
      };
    },

    async createNextRevision(poId, creatorId) {
      // 1. Validation queries
      await enforceNotCancelledByPoId(db, poId);
      const header = await db.prepare("SELECT current_draft_revision_id, current_active_revision_id FROM po_headers WHERE po_id = ?").bind(poId).first();
      if (!header) {
        throw new Error(`PO not found: ${poId}`);
      }

      if (header.current_draft_revision_id) {
        const err = new Error('Draft revision already exists');
        err.code = 'PO_DRAFT_ALREADY_EXISTS';
        throw err;
      }

      if (!header.current_active_revision_id) {
        throw new Error('No active revision to clone');
      }

      // Fetch the active revision
      const activeRevision = await db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").bind(header.current_active_revision_id).first();
      if (!activeRevision) {
        throw new Error(`Active revision not found: ${header.current_active_revision_id}`);
      }

      const newRevId = `REV-${crypto.randomUUID()}`;
      const newRevNo = activeRevision.revision_no + 1;

      // 2. Prepare statements
      // A. Insert Revision
      const insertRevStmt = db.prepare(`
        INSERT INTO po_revisions (
          revision_id, po_id, revision_no, status, customer_po_no, po_date, buyer_reference,
          ownership_type_snapshot, sales_owner_user_id_snapshot, customer_contact_id, customer_contact_snapshot_json,
          currency, incoterm, destination, delivery_start, delivery_end, valid_until,
          payment_term_snapshot, commercial_terms, operational_note, revision_note,
          approved_by, approved_at, approval_note, approval_summary_json, created_by
        ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?)
      `).bind(
        newRevId,
        poId,
        newRevNo,
        activeRevision.customer_po_no,
        activeRevision.po_date,
        activeRevision.buyer_reference,
        activeRevision.ownership_type_snapshot,
        activeRevision.sales_owner_user_id_snapshot,
        activeRevision.customer_contact_id,
        activeRevision.customer_contact_snapshot_json,
        activeRevision.currency,
        activeRevision.incoterm,
        activeRevision.destination,
        activeRevision.delivery_start,
        activeRevision.delivery_end,
        activeRevision.valid_until,
        activeRevision.payment_term_snapshot,
        activeRevision.commercial_terms,
        activeRevision.operational_note,
        creatorId
      );

      // B. Fetch and clone Lines
      const { results: lines } = await db.prepare("SELECT * FROM po_revision_lines WHERE po_revision_id = ?").bind(header.current_active_revision_id).all();
      const insertLineStmts = (lines || []).map(line => {
        const newLineId = `LINE-${crypto.randomUUID()}`;
        return db.prepare(`
          INSERT INTO po_revision_lines (
            line_id, po_revision_id, line_no, previous_line_id, product_id, spec_source, spec_revision_id,
            spec_override_json, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, price_unit,
            source_price_note_id, suggested_price, price_override_reason, packaging, container_type, loading_pattern,
            commission_recipient_user_id, commission_rate_usd_mt, commercial_line_term, operational_line_note
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          newLineId,
          newRevId,
          line.line_no,
          line.line_id,
          line.product_id,
          line.spec_source,
          line.spec_revision_id,
          line.spec_override_json,
          line.contract_qty_mt,
          line.tolerance_pct,
          line.min_qty_mt,
          line.max_qty_mt,
          line.unit_price,
          line.price_unit,
          line.source_price_note_id,
          line.suggested_price,
          line.price_override_reason,
          line.packaging,
          line.container_type,
          line.loading_pattern,
          line.commission_recipient_user_id,
          line.commission_rate_usd_mt,
          line.commercial_line_term,
          line.operational_line_note
        );
      });

      // C. Fetch and clone Documents
      const { results: docs } = await db.prepare("SELECT * FROM po_revision_documents WHERE po_revision_id = ?").bind(header.current_active_revision_id).all();
      const insertDocStmts = (docs || []).map(doc => {
        const newDocId = `DOC-${crypto.randomUUID()}`;
        return db.prepare(`
          INSERT INTO po_revision_documents (
            document_id, po_revision_id, document_type, label, url, created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          newDocId,
          newRevId,
          doc.document_type,
          doc.label,
          doc.url,
          creatorId,
          creatorId
        );
      });

      // D. Update Header
      const updateHeaderStmt = db.prepare(`
        UPDATE po_headers
        SET current_draft_revision_id = ?
        WHERE po_id = ?
      `).bind(newRevId, poId);

      // 3. Batch execute
      await db.batch([
        insertRevStmt,
        ...insertLineStmts,
        ...insertDocStmts,
        updateHeaderStmt
      ]);

      // Return the newly created revision
      const clonedRevision = await db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").bind(newRevId).first();
      return clonedRevision;
    },

    async updateRevisionOverview(revisionId, dto) {
      await enforceNotCancelledByRevisionId(db, revisionId);
      // Fetch revision
      const revision = await db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").bind(revisionId).first();
      if (!revision) {
        throw new Error(`Revision not found: ${revisionId}`);
      }

      // Enforce status constraint
      if (revision.status !== 'DRAFT') {
        const err = new Error('Cannot edit active or superseded revision');
        err.code = 'PO_ACTIVE_IMMUTABLE';
        throw err;
      }

      // Fetch customer_id from po_headers
      const header = await db.prepare("SELECT customer_id FROM po_headers WHERE po_id = ?").bind(revision.po_id).first();
      if (!header) {
        throw new Error(`PO header not found for po_id: ${revision.po_id}`);
      }

      // If customerPoNo is updated, validate uniqueness
      const newCustomerPoNo = dto.customerPoNo !== undefined ? dto.customerPoNo : revision.customer_po_no;
      if (dto.customerPoNo !== undefined && dto.customerPoNo !== revision.customer_po_no) {
        await checkCustomerPoNoUnique(db, header.customer_id, revision.po_id, newCustomerPoNo);
      }

      // Build update statement dynamically
      const fieldMappings = {
        customerPoNo: 'customer_po_no',
        poDate: 'po_date',
        buyerReference: 'buyer_reference',
        currency: 'currency',
        incoterm: 'incoterm',
        destination: 'destination',
        deliveryStart: 'delivery_start',
        deliveryEnd: 'delivery_end',
        validUntil: 'valid_until',
        paymentTermSnapshot: 'payment_term_snapshot',
        commercialTerms: 'commercial_terms',
        operationalNote: 'operational_note',
        revisionNote: 'revision_note'
      };

      const setClauses = [];
      const bindParams = [];

      for (const [dtoKey, sqlColumn] of Object.entries(fieldMappings)) {
        if (dto[dtoKey] !== undefined) {
          setClauses.push(`${sqlColumn} = ?`);
          bindParams.push(dto[dtoKey]);
        }
      }

      if (setClauses.length > 0) {
        const query = `UPDATE po_revisions SET ${setClauses.join(', ')} WHERE revision_id = ?`;
        bindParams.push(revisionId);
        await db.prepare(query).bind(...bindParams).run();
      }

      // Return the updated revision
      const updatedRevision = await db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").bind(revisionId).first();
      return updatedRevision;
    },

    async createPORevisionLine(revisionId, dto) {
      await enforceNotCancelledByRevisionId(db, revisionId);
      // 1. Enforce status constraint
      const revision = await db.prepare("SELECT status, po_id, incoterm, ownership_type_snapshot, sales_owner_user_id_snapshot FROM po_revisions WHERE revision_id = ?").bind(revisionId).first();
      if (!revision) {
        throw new Error(`Revision not found: ${revisionId}`);
      }
      if (revision.status !== 'DRAFT') {
        const err = new Error('Cannot modify lines of an active or superseded revision');
        err.code = 'PO_ACTIVE_IMMUTABLE';
        throw err;
      }

      // 2. Validate inputs
      if (dto.contractQtyMt < 0) throw new Error('Contract quantity cannot be negative');
      if (dto.tolerancePct < 0 || dto.tolerancePct > 100) throw new Error('Tolerance must be between 0 and 100');
      if (dto.unitPrice < 0) throw new Error('Unit price cannot be negative');
      if (dto.commissionRateUsdMt !== undefined && dto.commissionRateUsdMt < 0) {
        throw new Error('Commission rate cannot be negative');
      }

      // Validate specification reference and product match
      await validateSpecReference(db, dto.productId, dto.specSource, dto.specRevisionId);

      // 3. Enforce line_no uniqueness
      const duplicate = await db.prepare("SELECT 1 FROM po_revision_lines WHERE po_revision_id = ? AND line_no = ?").bind(revisionId, dto.lineNo).first();
      if (duplicate) {
        const err = new Error(`Duplicate line number: ${dto.lineNo}`);
        err.code = 'PO_LINE_NUMBER_DUPLICATE';
        throw err;
      }

      // 4. Match Manager Price Note
      const header = await db.prepare("SELECT customer_id FROM po_headers WHERE po_id = ?").bind(revision.po_id).first();
      if (!header) {
        throw new Error(`PO header not found for po_id: ${revision.po_id}`);
      }

      const note = await matchManagerPriceNote(
        db,
        header.customer_id,
        dto.productId,
        revision.incoterm,
        revision.ownership_type_snapshot,
        revision.sales_owner_user_id_snapshot
      );

      let suggestedPrice = null;
      let sourcePriceNoteId = null;
      if (note) {
        suggestedPrice = note.offer_price_usd_per_mt;
        sourcePriceNoteId = note.note_id;
      }

      // Validate unit price vs suggested price override reason
      if (suggestedPrice !== null && dto.unitPrice !== suggestedPrice) {
        if (!dto.priceOverrideReason || !dto.priceOverrideReason.trim()) {
          const err = new Error('Price override reason is required when price differs from suggested price');
          err.code = 'PO_PRICE_OVERRIDE_REASON_REQUIRED';
          throw err;
        }
      }

      // 5. Calculate tolerance boundaries (rounded to 4 decimal places)
      const minQty = Math.round((dto.contractQtyMt * (1 - dto.tolerancePct / 100)) * 10000) / 10000;
      const maxQty = Math.round((dto.contractQtyMt * (1 + dto.tolerancePct / 100)) * 10000) / 10000;

      const lineId = `LINE-${crypto.randomUUID()}`;
      const priceUnit = dto.priceUnit || '/MT';
      const commissionRate = dto.commissionRateUsdMt || 0;

      // 6. Insert PO Line
      await db.prepare(`
        INSERT INTO po_revision_lines (
          line_id, po_revision_id, line_no, previous_line_id, product_id, spec_source, spec_revision_id,
          spec_override_json, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, price_unit,
          source_price_note_id, suggested_price, price_override_reason, packaging, container_type, loading_pattern,
          commission_recipient_user_id, commission_rate_usd_mt, commercial_line_term, operational_line_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        lineId,
        revisionId,
        dto.lineNo,
        dto.previousLineId || null,
        dto.productId,
        dto.specSource,
        dto.specRevisionId,
        dto.specOverrideJson ? JSON.stringify(dto.specOverrideJson) : null,
        dto.contractQtyMt,
        dto.tolerancePct,
        minQty,
        maxQty,
        dto.unitPrice,
        priceUnit,
        sourcePriceNoteId,
        suggestedPrice,
        dto.priceOverrideReason || null,
        dto.packaging,
        dto.containerType,
        dto.loadingPattern,
        dto.commissionRecipientUserId || null,
        commissionRate,
        dto.commercialLineTerm || null,
        dto.operationalLineNote || null
      ).run();

      return await db.prepare("SELECT * FROM po_revision_lines WHERE line_id = ?").bind(lineId).first();
    },

    async updatePORevisionLine(lineId, dto) {
      await enforceNotCancelledByLineId(db, lineId);
      // 1. Fetch line and parent status
      const existingLine = await db.prepare("SELECT * FROM po_revision_lines WHERE line_id = ?").bind(lineId).first();
      if (!existingLine) {
        throw new Error(`Line not found: ${lineId}`);
      }

      const revision = await db.prepare("SELECT status, po_id, incoterm, ownership_type_snapshot, sales_owner_user_id_snapshot FROM po_revisions WHERE revision_id = ?").bind(existingLine.po_revision_id).first();
      if (!revision) {
        throw new Error(`Revision not found: ${existingLine.po_revision_id}`);
      }
      if (revision.status !== 'DRAFT') {
        const err = new Error('Cannot modify lines of an active or superseded revision');
        err.code = 'PO_ACTIVE_IMMUTABLE';
        throw err;
      }

      // 2. Prevent product replacement
      if (dto.productId !== undefined && dto.productId !== existingLine.product_id) {
        throw new Error('Product cannot be replaced on an existing line');
      }

      // 3. Setup values for math checks
      const contractQty = dto.contractQtyMt !== undefined ? dto.contractQtyMt : existingLine.contract_qty_mt;
      const tolerancePct = dto.tolerancePct !== undefined ? dto.tolerancePct : existingLine.tolerance_pct;
      const unitPrice = dto.unitPrice !== undefined ? dto.unitPrice : existingLine.unit_price;
      const commissionRate = dto.commissionRateUsdMt !== undefined ? dto.commissionRateUsdMt : existingLine.commission_rate_usd_mt;
      const priceOverrideReason = dto.priceOverrideReason !== undefined ? dto.priceOverrideReason : existingLine.price_override_reason;

      if (contractQty < 0) throw new Error('Contract quantity cannot be negative');
      if (tolerancePct < 0 || tolerancePct > 100) throw new Error('Tolerance must be between 0 and 100');
      if (unitPrice < 0) throw new Error('Unit price cannot be negative');
      if (commissionRate < 0) throw new Error('Commission rate cannot be negative');

      // Validate specification reference and product match
      const specSource = dto.specSource !== undefined ? dto.specSource : existingLine.spec_source;
      const specRevisionId = dto.specRevisionId !== undefined ? dto.specRevisionId : existingLine.spec_revision_id;
      await validateSpecReference(db, existingLine.product_id, specSource, specRevisionId);

      // 4. Enforce line_no uniqueness
      if (dto.lineNo !== undefined && dto.lineNo !== existingLine.line_no) {
        const duplicate = await db.prepare("SELECT 1 FROM po_revision_lines WHERE po_revision_id = ? AND line_no = ? AND line_id != ?").bind(existingLine.po_revision_id, dto.lineNo, lineId).first();
        if (duplicate) {
          const err = new Error(`Duplicate line number: ${dto.lineNo}`);
          err.code = 'PO_LINE_NUMBER_DUPLICATE';
          throw err;
        }
      }

      // 5. Match Manager Price Note
      const header = await db.prepare("SELECT customer_id FROM po_headers WHERE po_id = ?").bind(revision.po_id).first();
      if (!header) {
        throw new Error(`PO header not found for po_id: ${revision.po_id}`);
      }

      const note = await matchManagerPriceNote(
        db,
        header.customer_id,
        existingLine.product_id,
        revision.incoterm,
        revision.ownership_type_snapshot,
        revision.sales_owner_user_id_snapshot
      );

      let suggestedPrice = null;
      let sourcePriceNoteId = null;
      if (note) {
        suggestedPrice = note.offer_price_usd_per_mt;
        sourcePriceNoteId = note.note_id;
      }

      // Validate price override reason
      if (suggestedPrice !== null && unitPrice !== suggestedPrice) {
        if (!priceOverrideReason || !priceOverrideReason.trim()) {
          const err = new Error('Price override reason is required when price differs from suggested price');
          err.code = 'PO_PRICE_OVERRIDE_REASON_REQUIRED';
          throw err;
        }
      }

      // 6. Calculate tolerance boundaries (rounded to 4 decimal places)
      const minQty = Math.round((contractQty * (1 - tolerancePct / 100)) * 10000) / 10000;
      const maxQty = Math.round((contractQty * (1 + tolerancePct / 100)) * 10000) / 10000;

      // 7. Dynamic update query builder
      const fieldMappings = {
        lineNo: 'line_no',
        previousLineId: 'previous_line_id',
        specSource: 'spec_source',
        specRevisionId: 'spec_revision_id',
        contractQtyMt: 'contract_qty_mt',
        tolerancePct: 'tolerance_pct',
        unitPrice: 'unit_price',
        priceUnit: 'price_unit',
        priceOverrideReason: 'price_override_reason',
        packaging: 'packaging',
        containerType: 'container_type',
        loadingPattern: 'loading_pattern',
        commissionRecipientUserId: 'commission_recipient_user_id',
        commissionRateUsdMt: 'commission_rate_usd_mt',
        commercialLineTerm: 'commercial_line_term',
        operationalLineNote: 'operational_line_note'
      };

      const setClauses = ['min_qty_mt = ?', 'max_qty_mt = ?', 'suggested_price = ?', 'source_price_note_id = ?'];
      const bindParams = [minQty, maxQty, suggestedPrice, sourcePriceNoteId];

      for (const [dtoKey, sqlColumn] of Object.entries(fieldMappings)) {
        if (dto[dtoKey] !== undefined) {
          setClauses.push(`${sqlColumn} = ?`);
          bindParams.push(dto[dtoKey]);
        }
      }

      if (dto.specOverrideJson !== undefined) {
        setClauses.push('spec_override_json = ?');
        bindParams.push(dto.specOverrideJson ? JSON.stringify(dto.specOverrideJson) : null);
      }

      const query = `UPDATE po_revision_lines SET ${setClauses.join(', ')} WHERE line_id = ?`;
      bindParams.push(lineId);
      await db.prepare(query).bind(...bindParams).run();

      return await db.prepare("SELECT * FROM po_revision_lines WHERE line_id = ?").bind(lineId).first();
    },

    async deletePORevisionLine(lineId) {
      await enforceNotCancelledByLineId(db, lineId);
      // 1. Fetch line and parent status
      const existingLine = await db.prepare("SELECT * FROM po_revision_lines WHERE line_id = ?").bind(lineId).first();
      if (!existingLine) {
        throw new Error(`Line not found: ${lineId}`);
      }

      const revision = await db.prepare("SELECT status FROM po_revisions WHERE revision_id = ?").bind(existingLine.po_revision_id).first();
      if (!revision) {
        throw new Error(`Revision not found: ${existingLine.po_revision_id}`);
      }
      if (revision.status !== 'DRAFT') {
        const err = new Error('Cannot modify lines of an active or superseded revision');
        err.code = 'PO_ACTIVE_IMMUTABLE';
        throw err;
      }

      // 2. Delete PO Line
      await db.prepare("DELETE FROM po_revision_lines WHERE line_id = ?").bind(lineId).run();
    },

    async validateRevisionSpecsForActivation(revisionId) {
      const { results: lines } = await db.prepare("SELECT * FROM po_revision_lines WHERE po_revision_id = ?").bind(revisionId).all();
      
      let hasOutdated = false;
      const outdatedSpecs = [];

      for (const line of (lines || [])) {
        const spec = await validateSpecReference(db, line.product_id, line.spec_source, line.spec_revision_id);
        
        if (spec.status === 'DRAFT') {
          const err = new Error('Draft spec not allowed for activation');
          err.code = 'PO_SPEC_REQUIRED';
          throw err;
        }

        if (line.spec_source === 'STANDARD') {
          const stdSpec = await db.prepare("SELECT application, revision_no FROM standard_specs WHERE standard_spec_id = ?").bind(line.spec_revision_id).first();
          if (stdSpec) {
            const activeSpec = await db.prepare("SELECT standard_spec_id FROM standard_specs WHERE product_id = ? AND application = ? AND status = 'ACTIVE' LIMIT 1").bind(line.product_id, stdSpec.application).first();
            if (activeSpec && activeSpec.standard_spec_id !== line.spec_revision_id) {
              hasOutdated = true;
              outdatedSpecs.push({
                line_id: line.line_id,
                spec_source: line.spec_source,
                spec_revision_id: line.spec_revision_id
              });
            }
          }
        } else if (line.spec_source === 'CUSTOMER') {
          const custSpec = await db.prepare("SELECT customer_id, application FROM customer_specs WHERE customer_spec_id = ?").bind(line.spec_revision_id).first();
          if (custSpec) {
            const activeCustSpec = await db.prepare("SELECT customer_spec_id FROM customer_specs WHERE customer_id = ? AND product_id = ? AND application = ? AND status = 'ACTIVE' LIMIT 1").bind(custSpec.customer_id, line.product_id, custSpec.application).first();
            if (activeCustSpec && activeCustSpec.customer_spec_id !== line.spec_revision_id) {
              hasOutdated = true;
              outdatedSpecs.push({
                line_id: line.line_id,
                spec_source: line.spec_source,
                spec_revision_id: line.spec_revision_id
              });
            }
          }
        }
      }

      return {
        hasOutdated,
        outdatedSpecs
      };
    },

    async createPORevisionDocument(revisionId, dto, creatorId) {
      await enforceNotCancelledByRevisionId(db, revisionId);
      // 1. Enforce superseded constraint
      const revision = await enforceNotSuperseded(db, revisionId);

      // 2. Validate URL format
      validateUrl(dto.url);

      const documentId = `DOC-${crypto.randomUUID()}`;

      // 3. Insert document record
      await db.prepare(`
        INSERT INTO po_revision_documents (document_id, po_revision_id, document_type, label, url, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        documentId,
        revisionId,
        dto.documentType,
        dto.label,
        dto.url,
        creatorId
      ).run();

      // 4. Log audit event
      await logPOAuditEvent(db, revision.po_id, revisionId, 'DOCUMENT_ADDED', creatorId, {
        label: dto.label,
        documentType: dto.documentType
      });

      return await db.prepare("SELECT * FROM po_revision_documents WHERE document_id = ?").bind(documentId).first();
    },

    async updatePORevisionDocument(documentId, dto, updaterId) {
      await enforceNotCancelledByDocId(db, documentId);
      // 1. Enforce superseded constraint
      const { revisionId, poId } = await enforceNotSupersededByDocId(db, documentId);

      // 2. Validate URL format if updated
      if (dto.url !== undefined) {
        validateUrl(dto.url);
      }

      // 3. Dynamic update query builder
      const setClauses = ['updated_at = CURRENT_TIMESTAMP'];
      const bindParams = [];
      const fieldMappings = {
        documentType: 'document_type',
        label: 'label',
        url: 'url'
      };

      for (const [dtoKey, sqlColumn] of Object.entries(fieldMappings)) {
        if (dto[dtoKey] !== undefined) {
          setClauses.push(`${sqlColumn} = ?`);
          bindParams.push(dto[dtoKey]);
        }
      }

      const query = `UPDATE po_revision_documents SET ${setClauses.join(', ')} WHERE document_id = ?`;
      bindParams.push(documentId);
      await db.prepare(query).bind(...bindParams).run();

      // 4. Log audit event
      await logPOAuditEvent(db, poId, revisionId, 'DOCUMENT_UPDATED', updaterId, {
        documentId,
        updates: dto
      });

      return await db.prepare("SELECT * FROM po_revision_documents WHERE document_id = ?").bind(documentId).first();
    },

    async deletePORevisionDocument(documentId, updaterId) {
      await enforceNotCancelledByDocId(db, documentId);
      // 1. Enforce superseded constraint
      const { revisionId, poId } = await enforceNotSupersededByDocId(db, documentId);

      // 2. Get document info for audit log
      const doc = await db.prepare("SELECT label, document_type FROM po_revision_documents WHERE document_id = ?").bind(documentId).first();

      // 3. Delete document record
      await db.prepare("DELETE FROM po_revision_documents WHERE document_id = ?").bind(documentId).run();

      // 4. Log audit event
      await logPOAuditEvent(
        db,
        poId,
        revisionId,
        'DOCUMENT_REMOVED',
        updaterId,
        {
          label: doc?.label,
          documentType: doc?.document_type
        }
      );
    },

    async validateRevisionDocumentsForActivation(revisionId) {
      const row = await db.prepare(`
        SELECT COUNT(*) as count 
        FROM po_revision_documents 
        WHERE po_revision_id = ? 
          AND document_type IN ('CUSTOMER_PO', 'EMAIL_CONFIRMATION')
      `).bind(revisionId).first();

      if (!row || row.count === 0) {
        const err = new Error('Evidence document (CUSTOMER_PO or EMAIL_CONFIRMATION) is required to activate revision');
        err.code = 'PO_EVIDENCE_REQUIRED';
        throw err;
      }
    },

    async activateRevision(revisionId, approverId, approvalNote) {
      await enforceNotCancelledByRevisionId(db, revisionId);
      // 1. Fetch and validate revision
      const revision = await db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").bind(revisionId).first();
      if (!revision) {
        throw new Error(`Revision not found: ${revisionId}`);
      }
      if (revision.status !== 'DRAFT') {
        throw new Error('Only draft revisions can be activated');
      }

      // 2. Fetch and validate PO Header
      const header = await db.prepare("SELECT * FROM po_headers WHERE po_id = ?").bind(revision.po_id).first();
      if (!header) {
        throw new Error(`PO header not found: ${revision.po_id}`);
      }

      // 3. Ensure revision has at least one line item
      const { results: lines } = await db.prepare("SELECT * FROM po_revision_lines WHERE po_revision_id = ?").bind(revisionId).all();
      if (!lines || lines.length === 0) {
        throw new Error('Revision must have at least one line item to activate');
      }

      // 4. Verify validity date
      if (revision.valid_until) {
        const today = new Date().toISOString().split('T')[0];
        if (revision.valid_until < today) {
          const err = new Error('PO revision validity has expired');
          err.code = 'PO_VALIDITY_EXPIRED';
          throw err;
        }
      }

      // 5. Trigger spec validation
      const specCheck = await this.validateRevisionSpecsForActivation(revisionId);

      // 6. Trigger document validation
      await this.validateRevisionDocumentsForActivation(revisionId);

      // 7. For revisions other than Rev.0, verify revision note
      if (revision.revision_no > 0) {
        if (!revision.revision_note || !revision.revision_note.trim()) {
          const err = new Error('Revision note is required for revision number > 0');
          err.code = 'PO_REVISION_NOTE_REQUIRED';
          throw err;
        }
      }

      // 8. Fetch other info for approval snapshot
      const customer = await db.prepare("SELECT * FROM customers WHERE customer_id = ?").bind(header.customer_id).first();
      const { results: docs } = await db.prepare("SELECT * FROM po_revision_documents WHERE po_revision_id = ?").bind(revisionId).all();

      const approvalSnapshot = {
        header,
        customer,
        revision,
        lines,
        documents: docs
      };
      const approvalSummaryJson = JSON.stringify(approvalSnapshot);

      // 9. Prepare atomic swap updates
      const statements = [];

      // A. Supersede any existing active revisions
      const oldActive = await db.prepare("SELECT revision_id, revision_no FROM po_revisions WHERE po_id = ? AND status = 'ACTIVE'").bind(revision.po_id).first();
      
      statements.push(
        db.prepare("UPDATE po_revisions SET status = 'SUPERSEDED' WHERE po_id = ? AND status = 'ACTIVE'").bind(revision.po_id)
      );

      // B. Log old revision superseded event if exists
      if (oldActive) {
        const supersededEventId = `EVT-${crypto.randomUUID()}`;
        const supersededEventMetadata = JSON.stringify({ revision_no: oldActive.revision_no });
        statements.push(
          db.prepare(`
            INSERT INTO po_audit_events (event_id, po_id, po_revision_id, event_type, actor_id, metadata_json)
            VALUES (?, ?, ?, 'REVISION_SUPERSEDED', ?, ?)
          `).bind(supersededEventId, revision.po_id, oldActive.revision_id, approverId, supersededEventMetadata)
        );
      }

      // C. Activate current draft
      statements.push(
        db.prepare(`
          UPDATE po_revisions 
          SET status = 'ACTIVE',
              approved_by = ?,
              approved_at = datetime('now'),
              approval_note = ?,
              approval_summary_json = ?
          WHERE revision_id = ?
        `).bind(approverId, approvalNote || null, approvalSummaryJson, revisionId)
      );

      // D. Update PO Header
      statements.push(
        db.prepare(`
          UPDATE po_headers 
          SET current_active_revision_id = ?,
              current_draft_revision_id = NULL
          WHERE po_id = ?
        `).bind(revisionId, revision.po_id)
      );

      // E. Mirror to legacy pos table (Ruling 01)
      const firstLine = lines[0];
      statements.push(
        db.prepare(`
          INSERT INTO pos (po_id, customer_id, product_id, incoterm, destination_port, po_date, status)
          VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')
          ON CONFLICT(po_id) DO UPDATE SET 
            customer_id = excluded.customer_id, 
            product_id = excluded.product_id, 
            incoterm = excluded.incoterm, 
            destination_port = excluded.destination_port, 
            po_date = excluded.po_date, 
            status = excluded.status
        `).bind(
          revision.po_id,
          header.customer_id,
          firstLine.product_id,
          revision.incoterm,
          revision.destination || null,
          revision.po_date || null
        )
      );

      // F. Log revision activated event
      const activeEventId = `EVT-${crypto.randomUUID()}`;
      const activeEventMetadata = JSON.stringify({ revision_no: revision.revision_no });
      statements.push(
        db.prepare(`
          INSERT INTO po_audit_events (event_id, po_id, po_revision_id, event_type, actor_id, metadata_json)
          VALUES (?, ?, ?, 'REVISION_ACTIVATED', ?, ?)
        `).bind(activeEventId, revision.po_id, revisionId, approverId, activeEventMetadata)
      );

      // G. Log SPEC_OLD_REVISION_CONFIRMED for outdated specs
      for (const outSpec of specCheck.outdatedSpecs) {
        const specEventId = `EVT-${crypto.randomUUID()}`;
        const specEventMetadata = JSON.stringify({
          line_id: outSpec.line_id,
          spec_source: outSpec.spec_source,
          spec_revision_id: outSpec.spec_revision_id
        });
        statements.push(
          db.prepare(`
            INSERT INTO po_audit_events (event_id, po_id, po_revision_id, event_type, actor_id, metadata_json)
            VALUES (?, ?, ?, 'SPEC_OLD_REVISION_CONFIRMED', ?, ?)
          `).bind(specEventId, revision.po_id, revisionId, approverId, specEventMetadata)
        );
      }

      // H. If there was an old active revision, generate and log field diffs
      if (oldActive) {
        await generateAndLogFieldDiffs(db, revision.po_id, revisionId, oldActive.revision_id, statements);
      }

      // Execute transaction batch
      await db.batch(statements);
    },

    async deleteDraftPO(poId) {
      // 1. Fetch PO Header
      const header = await db.prepare("SELECT * FROM po_headers WHERE po_id = ?").bind(poId).first();
      if (!header) {
        throw new Error(`PO not found: ${poId}`);
      }

      // 2. Check if it has ever had an active revision
      if (header.current_active_revision_id !== null) {
        const err = new Error('Cannot delete PO with active history');
        err.code = 'PO_ACTIVE_IMMUTABLE';
        throw err;
      }

      const revCheck = await db.prepare("SELECT COUNT(*) as count FROM po_revisions WHERE po_id = ? AND status IN ('ACTIVE', 'SUPERSEDED')").bind(poId).first();
      if (revCheck && revCheck.count > 0) {
        const err = new Error('Cannot delete PO with active history');
        err.code = 'PO_ACTIVE_IMMUTABLE';
        throw err;
      }

      // 3. Execute hard delete on po_headers (cascades)
      await db.prepare("DELETE FROM po_headers WHERE po_id = ?").bind(poId).run();
    },

    async cancelPO(poId, cancellerId, reason) {
      // 1. Validate reason
      if (!reason || !reason.trim()) {
        throw new Error('Cancellation reason is required');
      }

      // 2. Fetch PO Header
      const header = await db.prepare("SELECT * FROM po_headers WHERE po_id = ?").bind(poId).first();
      if (!header) {
        throw new Error(`PO not found: ${poId}`);
      }

      // 3. Update header status to CANCELLED
      await db.prepare(`
        UPDATE po_headers 
        SET header_status = 'CANCELLED',
            cancelled_by = ?,
            cancelled_at = datetime('now'),
            cancellation_reason = ?
        WHERE po_id = ?
      `).bind(cancellerId, reason, poId).run();

      // 4. Log PO_CANCELLED audit event
      await logPOAuditEvent(db, poId, header.current_active_revision_id, 'PO_CANCELLED', cancellerId, { reason });
    }
  };
}
