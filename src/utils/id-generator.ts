import { randomUUID } from 'node:crypto';

export function generateUuid(): string {
  return randomUUID();
}

export function generateTimestamp(): number {
  return Date.now();
}
