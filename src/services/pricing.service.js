const { Parser } = require('expr-eval');
const logger = require('../utils/logger');

const MAX_VARIABLES = 15;

const VALID_TYPES = new Set(['text', 'number', 'choice', 'boolean']);

/**
 * Parse and validate the JSON-encoded variable definitions stored on an
 * Agent. Returns an array of { label, type, choices, required } or throws
 * if the definition is malformed.
 */
function parseVariables(json) {
  if (!json) return [];
  let arr;
  try {
    arr = JSON.parse(json);
  } catch (e) {
    throw new Error(`pricingVariables is not valid JSON: ${e.message}`);
  }
  if (!Array.isArray(arr)) {
    throw new Error('pricingVariables must be a JSON array');
  }
  if (arr.length > MAX_VARIABLES) {
    throw new Error(`Too many pricing variables (max ${MAX_VARIABLES})`);
  }

  const seenLabels = new Set();
  for (const v of arr) {
    if (!v.label || typeof v.label !== 'string') {
      throw new Error('Every variable needs a non-empty "label" string');
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v.label)) {
      throw new Error(`Variable label "${v.label}" must be a valid identifier (letters, digits, underscore; cannot start with digit)`);
    }
    if (seenLabels.has(v.label)) {
      throw new Error(`Duplicate variable label: ${v.label}`);
    }
    seenLabels.add(v.label);

    if (!VALID_TYPES.has(v.type)) {
      throw new Error(`Variable "${v.label}" has invalid type "${v.type}" (must be one of: ${[...VALID_TYPES].join(', ')})`);
    }
    if (v.type === 'choice') {
      if (!Array.isArray(v.choices) || v.choices.length === 0) {
        throw new Error(`Choice variable "${v.label}" requires a non-empty "choices" array`);
      }
    }
  }
  return arr;
}

/**
 * Validate a formula string against a set of variables. Compiles the formula
 * with expr-eval (safe expression parser, no access to fs/network/process),
 * checks that every symbol it references is a declared variable, and returns
 * the compiled expression so callers can evaluate it without re-parsing.
 */
function compileFormula(formula, variables) {
  if (!formula || typeof formula !== 'string') {
    throw new Error('Formula is empty');
  }
  if (formula.length > 2000) {
    throw new Error('Formula too long (max 2000 chars)');
  }

  const parser = new Parser({
    operators: {
      // Allow arithmetic and conditional, disallow assignment
      add: true, subtract: true, multiply: true, divide: true,
      remainder: true, power: true, concatenate: false,
      conditional: true, logical: true, comparison: true,
      'in': false, assignment: false
    }
  });

  let expr;
  try {
    expr = parser.parse(formula);
  } catch (e) {
    throw new Error(`Formula syntax error: ${e.message}`);
  }

  // Every symbol used in the formula must be a declared variable.
  // Choice-type variables also expose <label>_idx (the position in the
  // choices array, 0-based) so users can write arithmetic on them.
  const declared = new Set();
  for (const v of variables) {
    declared.add(v.label);
    if (v.type === 'choice') declared.add(`${v.label}_idx`);
  }
  const used = expr.variables();
  const undeclared = used.filter(s => !declared.has(s));
  if (undeclared.length > 0) {
    throw new Error(`Formula references undeclared variable(s): ${undeclared.join(', ')}`);
  }

  return expr;
}

/**
 * Coerce raw input values (likely strings from the LLM extraction) into the
 * types declared on each variable. Missing required variables → error.
 */
function coerceInputs(inputs, variables) {
  const coerced = {};
  for (const v of variables) {
    let raw = inputs[v.label];
    const isMissing = raw === undefined || raw === null || raw === '';
    if (isMissing) {
      if (v.required) throw new Error(`Required variable "${v.label}" is missing`);
      // Default missing optional values to a type-appropriate zero
      coerced[v.label] = v.type === 'number' ? 0 : v.type === 'boolean' ? false : '';
      continue;
    }

    switch (v.type) {
      case 'number': {
        const n = Number(raw);
        if (Number.isNaN(n)) throw new Error(`Variable "${v.label}" must be a number, got "${raw}"`);
        coerced[v.label] = n;
        break;
      }
      case 'boolean': {
        if (typeof raw === 'boolean') { coerced[v.label] = raw; break; }
        const s = String(raw).toLowerCase().trim();
        if (['true', '1', 'yes', 'sí', 'si', 'y'].includes(s)) coerced[v.label] = true;
        else if (['false', '0', 'no', 'n'].includes(s)) coerced[v.label] = false;
        else throw new Error(`Variable "${v.label}" must be yes/no, got "${raw}"`);
        break;
      }
      case 'choice': {
        const s = String(raw).trim();
        if (!v.choices.includes(s)) {
          throw new Error(`Variable "${v.label}" must be one of [${v.choices.join(', ')}], got "${raw}"`);
        }
        // expr-eval cannot do string equality with operators, so map to index
        // Users reference choices in their formula by literal string in
        // ternary-like expressions. We expose both: the string and the index.
        coerced[v.label] = s;
        coerced[`${v.label}_idx`] = v.choices.indexOf(s);
        break;
      }
      case 'text':
      default:
        coerced[v.label] = String(raw);
        break;
    }
  }
  return coerced;
}

/**
 * Calculate the total for an agent given the captured inputs.
 * Throws if pricing is not configured or inputs are invalid.
 */
function calculate(agent, inputs) {
  if (!agent.pricingFormula || !agent.pricingVariables) {
    throw new Error('Pricing not configured for this agent');
  }

  const variables = parseVariables(agent.pricingVariables);
  const expr = compileFormula(agent.pricingFormula, variables);
  const coerced = coerceInputs(inputs, variables);

  let total;
  try {
    total = expr.evaluate(coerced);
  } catch (e) {
    throw new Error(`Formula evaluation failed: ${e.message}`);
  }

  if (typeof total !== 'number' || Number.isNaN(total) || !Number.isFinite(total)) {
    throw new Error(`Formula did not return a finite number (got ${total})`);
  }

  // Round to 2 decimals (currency)
  total = Math.round(total * 100) / 100;

  return {
    amount: total,
    currency: agent.pricingCurrency || 'EUR',
    inputs: coerced
  };
}

/**
 * Validate a complete pricing configuration without evaluating it.
 * Used by the dashboard's "Save" and "Test" actions.
 */
function validateConfig({ variables, formula }) {
  const parsed = typeof variables === 'string' ? parseVariables(variables) : parseVariables(JSON.stringify(variables));
  compileFormula(formula, parsed);
  return { ok: true, variableCount: parsed.length };
}

module.exports = { calculate, validateConfig, parseVariables, compileFormula, MAX_VARIABLES };
