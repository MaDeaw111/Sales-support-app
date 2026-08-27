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
      for (const stmt of statements) {
        results.push(await stmt.run());
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
    }
  };
}
