export async function validateSpecItems(db, items = []) {
  const validated = [];
  const seenParameters = new Set();

  for (const item of items) {
    if (!item.parameterId) {
      throw new Error('Parameter ID is required for each item.');
    }
    if (seenParameters.has(item.parameterId)) {
      throw new Error('Duplicate parameter in same specification.');
    }
    seenParameters.add(item.parameterId);

    // Fetch the parameter details
    const param = await db.prepare(`
      SELECT parameter_id, parameter_code, parameter_name, data_type, default_unit, status
      FROM spec_parameters
      WHERE parameter_id = ?
      LIMIT 1
    `).bind(item.parameterId).first();

    if (!param) {
      throw new Error(`Parameter not found: ${item.parameterId}`);
    }
    if (param.status === 'ARCHIVED') {
      throw new Error(`Parameter ${param.parameter_code} is archived.`);
    }

    const operator = String(item.operator || '').trim().toUpperCase();
    const allowedOperators = new Set(['MIN', 'MAX', 'RANGE', 'EXACT', 'TEXT']);
    if (!allowedOperators.has(operator)) {
      throw new Error(`Invalid operator: ${item.operator}`);
    }

    // DataType specific constraints
    if (param.data_type === 'TEXT') {
      if (operator !== 'TEXT') {
        throw new Error(`Text parameter must use TEXT operator.`);
      }
    } else if (param.data_type === 'NUMBER') {
      if (operator === 'TEXT') {
        throw new Error(`Numeric parameter must use a numeric operator (MIN, MAX, EXACT, RANGE).`);
      }
    }

    // Range checks
    if (operator === 'RANGE') {
      const lower = item.numericValue !== undefined && item.numericValue !== null ? Number(item.numericValue) : NaN;
      const upper = item.numericValueTo !== undefined && item.numericValueTo !== null ? Number(item.numericValueTo) : NaN;
      if (Number.isNaN(lower) || Number.isNaN(upper)) {
        throw new Error('RANGE operator requires both bounds.');
      }
      if (upper <= lower) {
        throw new Error('RANGE upper bound must be greater than lower bound.');
      }
    }

    validated.push({
      parameterId: item.parameterId,
      operator,
      numericValue: item.numericValue !== undefined && item.numericValue !== null ? Number(item.numericValue) : null,
      numericValueTo: item.numericValueTo !== undefined && item.numericValueTo !== null ? Number(item.numericValueTo) : null,
      textValue: item.textValue !== undefined && item.textValue !== null ? String(item.textValue).trim() : null,
      unit: String(item.unit || '').trim() || param.default_unit || '',
      sortOrder: Number(item.sortOrder || 0),
      notes: String(item.notes || '').trim()
    });
  }

  return validated;
}
