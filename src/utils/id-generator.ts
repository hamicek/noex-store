import { randomBytes, randomUUID } from 'node:crypto';

export function generateUuid(): string {
  return randomUUID();
}

export function generateCuid(): string {
  return `c${randomBytes(16).toString('hex')}`;
}

export function generateTimestamp(): number {
  return Date.now();
}
