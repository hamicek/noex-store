import { describe, it, expect } from 'vitest';
import { GenServer, Supervisor, EventBus } from '@hamicek/noex';

describe('smoke', () => {
  it('should verify test runner works', () => {
    expect(1 + 1).toBe(2);
  });

  it('should import @hamicek/noex', () => {
    expect(GenServer).toBeDefined();
    expect(Supervisor).toBeDefined();
    expect(EventBus).toBeDefined();
  });
});
