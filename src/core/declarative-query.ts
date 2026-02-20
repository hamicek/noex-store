import type { QueryContext, WhereFilter } from '../types/query.js';
import type { DeclarativeQueryConfig } from '../types/declarative-query.js';
import type { StoreRecord } from '../types/record.js';

// ── Parameter interpolation ──────────────────────────────────────

const PARAM_RE = /^\{\{\s*params\.(\w+)\s*\}\}$/;

function interpolateValue(value: unknown, params: Record<string, unknown> | undefined): unknown {
  if (typeof value === 'string') {
    const match = PARAM_RE.exec(value);
    if (match !== null) {
      return params?.[match[1]!];
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        return interpolateParams(item as Readonly<WhereFilter>, params);
      }
      return interpolateValue(item, params);
    });
  }

  if (typeof value === 'object' && value !== null) {
    return interpolateParams(value as Readonly<WhereFilter>, params);
  }

  return value;
}

function interpolateParams(
  filter: Readonly<WhereFilter>,
  params: unknown,
): WhereFilter {
  const result: Record<string, unknown> = {};
  const p = params as Record<string, unknown> | undefined;

  for (const [key, value] of Object.entries(filter)) {
    result[key] = interpolateValue(value, p);
  }

  return result as WhereFilter;
}

// ── Sorting ──────────────────────────────────────────────────────

function sortRecords(
  records: StoreRecord[],
  sort: Readonly<Record<string, 'asc' | 'desc'>>,
): StoreRecord[] {
  const entries = Object.entries(sort);
  if (entries.length === 0) return records;

  const sorted = [...records];
  sorted.sort((a, b) => {
    for (const [field, direction] of entries) {
      const aVal = a[field];
      const bVal = b[field];

      if (aVal === bVal) continue;

      // nullish values go last regardless of direction
      if (aVal == null) return 1;
      if (bVal == null) return -1;

      const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;

      return direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });

  return sorted;
}

// ── Projection ───────────────────────────────────────────────────

function pickFields(
  record: StoreRecord,
  fields: readonly string[],
): StoreRecord {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in record) {
      result[field] = record[field];
    }
  }
  return result as StoreRecord;
}

// ── Aggregation ──────────────────────────────────────────────────

function computeAggregate(
  records: StoreRecord[],
  aggregate: NonNullable<DeclarativeQueryConfig['aggregate']>,
): number | undefined {
  switch (aggregate.function) {
    case 'count':
      return records.length;

    case 'sum': {
      let total = 0;
      for (const r of records) {
        const val = r[aggregate.field!];
        if (typeof val === 'number') total += val;
      }
      return total;
    }

    case 'avg': {
      if (records.length === 0) return 0;
      let total = 0;
      let count = 0;
      for (const r of records) {
        const val = r[aggregate.field!];
        if (typeof val === 'number') {
          total += val;
          count++;
        }
      }
      return count === 0 ? 0 : total / count;
    }

    case 'min': {
      let min: number | undefined;
      for (const r of records) {
        const val = r[aggregate.field!];
        if (typeof val === 'number' && (min === undefined || val < min)) {
          min = val;
        }
      }
      return min;
    }

    case 'max': {
      let max: number | undefined;
      for (const r of records) {
        const val = r[aggregate.field!];
        if (typeof val === 'number' && (max === undefined || val > max)) {
          max = val;
        }
      }
      return max;
    }
  }
}

// ── Main factory ─────────────────────────────────────────────────

export type DeclarativeQueryFn = (ctx: QueryContext, params?: unknown) => Promise<unknown>;

export function createQueryFunction(config: DeclarativeQueryConfig): DeclarativeQueryFn {
  return async (ctx: QueryContext, params?: unknown): Promise<unknown> => {
    const bucket = ctx.bucket(config.bucket);

    // 1. Get records — apply filter if present
    const filter = config.filter
      ? interpolateParams(config.filter, params)
      : undefined;

    let records: StoreRecord[];
    if (filter !== undefined && Object.keys(filter).length > 0) {
      records = await bucket.where(filter);
    } else {
      records = await bucket.all();
    }

    // 2. Aggregation short-circuit
    if (config.aggregate !== undefined) {
      return computeAggregate(records, config.aggregate);
    }

    // 3. Sort
    if (config.sort !== undefined) {
      records = sortRecords(records, config.sort);
    }

    // 4. Offset
    if (config.offset !== undefined && config.offset > 0) {
      records = records.slice(config.offset);
    }

    // 5. Limit
    if (config.limit !== undefined) {
      records = records.slice(0, config.limit);
    }

    // 6. Projection
    if (config.fields !== undefined && config.fields.length > 0) {
      records = records.map(r => pickFields(r, config.fields!));
    }

    return records;
  };
}
