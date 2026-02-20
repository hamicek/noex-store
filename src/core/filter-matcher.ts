import type { FilterOperators, WhereFilter } from '../types/index.js';
import type { StoreRecord } from '../types/record.js';

export function isFilterOperators(value: unknown): value is FilterOperators {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every(k => k.startsWith('$'));
}

function matchFieldValue(recordValue: unknown, filterValue: unknown): boolean {
  if (!isFilterOperators(filterValue)) {
    return recordValue === filterValue;
  }

  const ops = filterValue;

  if (ops.$eq !== undefined && recordValue !== ops.$eq) return false;
  if (ops.$neq !== undefined && recordValue === ops.$neq) return false;

  if (ops.$gt !== undefined) {
    if (recordValue == null || !(recordValue > ops.$gt)) return false;
  }
  if (ops.$gte !== undefined) {
    if (recordValue == null || !(recordValue >= ops.$gte)) return false;
  }
  if (ops.$lt !== undefined) {
    if (recordValue == null || !(recordValue < ops.$lt)) return false;
  }
  if (ops.$lte !== undefined) {
    if (recordValue == null || !(recordValue <= ops.$lte)) return false;
  }

  if (ops.$in !== undefined) {
    if (!ops.$in.includes(recordValue)) return false;
  }
  if (ops.$nin !== undefined) {
    if (ops.$nin.includes(recordValue)) return false;
  }

  if (ops.$contains !== undefined) {
    if (typeof recordValue !== 'string') return false;
    if (!recordValue.toLowerCase().includes(ops.$contains.toLowerCase())) return false;
  }
  if (ops.$startsWith !== undefined) {
    if (typeof recordValue !== 'string') return false;
    if (!recordValue.startsWith(ops.$startsWith)) return false;
  }
  if (ops.$endsWith !== undefined) {
    if (typeof recordValue !== 'string') return false;
    if (!recordValue.endsWith(ops.$endsWith)) return false;
  }

  if (ops.$exists !== undefined) {
    const exists = recordValue !== undefined && recordValue !== null;
    if (ops.$exists !== exists) return false;
  }

  if (ops.$between !== undefined) {
    if (recordValue == null) return false;
    if (!(recordValue >= ops.$between[0] && recordValue <= ops.$between[1])) return false;
  }

  return true;
}

export function matchesFilter(record: StoreRecord, filter: WhereFilter): boolean {
  if (filter.$or !== undefined) {
    const orFilters = filter.$or as readonly WhereFilter[];
    if (!orFilters.some(f => matchesFilter(record, f))) return false;
  }

  if (filter.$and !== undefined) {
    const andFilters = filter.$and as readonly WhereFilter[];
    if (!andFilters.every(f => matchesFilter(record, f))) return false;
  }

  for (const [field, value] of Object.entries(filter)) {
    if (field === '$or' || field === '$and') continue;
    const recordValue = (record as Record<string, unknown>)[field];
    if (!matchFieldValue(recordValue, value)) return false;
  }

  return true;
}
