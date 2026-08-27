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
    }
  };
}
