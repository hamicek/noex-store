import { describe, it, expect, afterEach } from 'vitest';
import { Store } from '../../src/core/store.js';
import { ReferentialIntegrityError } from '../../src/core/ref-manager.js';
import type { BucketDefinition } from '../../src/types/index.js';

// ── Fixtures ─────────────────────────────────────────────────────

const customersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    name: { type: 'string', required: true },
  },
};

const ordersDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'number', required: true, ref: 'customers' },
    product: { type: 'string', required: true },
  },
};

const ordersWithCascadeDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'number', required: true, ref: 'customers', onDelete: 'cascade' },
    product: { type: 'string', required: true },
  },
};

const ordersWithSetNullDef: BucketDefinition = {
  key: 'id',
  schema: {
    id: { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'number', ref: 'customers', onDelete: 'set_null' },
    product: { type: 'string', required: true },
  },
};

// ── Helpers ───────────────────────────────────────────────────────

let store: Store;

afterEach(async () => {
  if (store !== undefined) {
    await store.stop();
  }
});

async function setupCustomersAndOrders(orderDef: BucketDefinition = ordersDef) {
  store = await Store.start();
  await store.defineBucket('customers', customersDef);
  await store.defineBucket('orders', orderDef);
  return {
    customers: store.bucket('customers'),
    orders: store.bucket('orders'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Referential integrity — insert validation', () => {
  it('allows insert when referenced record exists', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const customer = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: customer.id, product: 'Widget' });
    expect(order.customerId).toBe(customer.id);
  });

  it('rejects insert when referenced record does not exist', async () => {
    const { orders } = await setupCustomersAndOrders();
    await expect(
      orders.insert({ customerId: 999, product: 'Widget' }),
    ).rejects.toThrow(ReferentialIntegrityError);
  });

  it('error message includes details about the missing ref', async () => {
    const { orders } = await setupCustomersAndOrders();
    await expect(
      orders.insert({ customerId: 42, product: 'Widget' }),
    ).rejects.toThrow(/bucket "customers".*key "42"/);
  });

  it('allows insert with null ref when field is not required', async () => {
    const { orders } = await setupCustomersAndOrders(ordersWithSetNullDef);
    const order = await orders.insert({ customerId: null, product: 'Widget' });
    expect(order.customerId).toBeNull();
  });

  it('allows insert when ref field is omitted (undefined)', async () => {
    const { orders } = await setupCustomersAndOrders(ordersWithSetNullDef);
    const order = await orders.insert({ product: 'Widget' });
    expect(order.customerId).toBeUndefined();
  });
});

describe('Referential integrity — update validation', () => {
  it('allows update when new ref target exists', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const bob = await customers.insert({ name: 'Bob' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    const updated = await orders.update(order.id, { customerId: bob.id });
    expect(updated.customerId).toBe(bob.id);
  });

  it('rejects update when new ref target does not exist', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    await expect(
      orders.update(order.id, { customerId: 999 }),
    ).rejects.toThrow(ReferentialIntegrityError);
  });

  it('allows update when ref field is not in changes', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    const updated = await orders.update(order.id, { product: 'Gadget' });
    expect(updated.product).toBe('Gadget');
    expect(updated.customerId).toBe(alice.id);
  });

  it('allows update setting ref to null (set_null schema)', async () => {
    const { customers, orders } = await setupCustomersAndOrders(ordersWithSetNullDef);
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    const updated = await orders.update(order.id, { customerId: null });
    expect(updated.customerId).toBeNull();
  });
});

describe('Referential integrity — delete with restrict (default)', () => {
  it('allows deleting a record with no incoming references', async () => {
    const { customers } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    await customers.delete(alice.id);
    expect(await customers.get(alice.id)).toBeUndefined();
  });

  it('rejects deleting a record that is referenced (restrict)', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    await expect(customers.delete(alice.id)).rejects.toThrow(ReferentialIntegrityError);
  });

  it('restrict error message includes source bucket and field', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    await expect(customers.delete(alice.id)).rejects.toThrow(
      /referenced by bucket "orders".*field "customerId"/,
    );
  });

  it('allows deleting after the referencing record is removed', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    await orders.delete(order.id);
    await customers.delete(alice.id);
    expect(await customers.get(alice.id)).toBeUndefined();
  });
});

describe('Referential integrity — delete with cascade', () => {
  it('cascade-deletes referencing records', async () => {
    const { customers, orders } = await setupCustomersAndOrders(ordersWithCascadeDef);
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    await customers.delete(alice.id);
    expect(await customers.get(alice.id)).toBeUndefined();
    expect(await orders.get(order.id)).toBeUndefined();
  });

  it('cascade-deletes multiple referencing records', async () => {
    const { customers, orders } = await setupCustomersAndOrders(ordersWithCascadeDef);
    const alice = await customers.insert({ name: 'Alice' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    await orders.insert({ customerId: alice.id, product: 'Gadget' });
    await orders.insert({ customerId: alice.id, product: 'Doohickey' });
    await customers.delete(alice.id);
    expect(await orders.count()).toBe(0);
  });

  it('does not cascade-delete unrelated records', async () => {
    const { customers, orders } = await setupCustomersAndOrders(ordersWithCascadeDef);
    const alice = await customers.insert({ name: 'Alice' });
    const bob = await customers.insert({ name: 'Bob' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    const bobOrder = await orders.insert({ customerId: bob.id, product: 'Gadget' });
    await customers.delete(alice.id);
    expect(await orders.count()).toBe(1);
    expect(await orders.get(bobOrder.id)).toBeDefined();
  });
});

describe('Referential integrity — delete with set_null', () => {
  it('nulls out the ref field in referencing records', async () => {
    const { customers, orders } = await setupCustomersAndOrders(ordersWithSetNullDef);
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    await customers.delete(alice.id);
    expect(await customers.get(alice.id)).toBeUndefined();
    const updated = await orders.get(order.id);
    expect(updated).toBeDefined();
    expect(updated!.customerId).toBeNull();
  });

  it('nulls out multiple referencing records', async () => {
    const { customers, orders } = await setupCustomersAndOrders(ordersWithSetNullDef);
    const alice = await customers.insert({ name: 'Alice' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    await orders.insert({ customerId: alice.id, product: 'Gadget' });
    await customers.delete(alice.id);
    const allOrders = await orders.all();
    for (const o of allOrders) {
      expect(o.customerId).toBeNull();
    }
  });
});

describe('Referential integrity — insertMany', () => {
  it('allows batch insert when all refs exist', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const bob = await customers.insert({ name: 'Bob' });
    const records = await orders.insertMany([
      { customerId: alice.id, product: 'Widget' },
      { customerId: bob.id, product: 'Gadget' },
    ]);
    expect(records).toHaveLength(2);
  });

  it('rejects batch insert when any ref is missing', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    await expect(
      orders.insertMany([
        { customerId: alice.id, product: 'Widget' },
        { customerId: 999, product: 'Gadget' },
      ]),
    ).rejects.toThrow(ReferentialIntegrityError);
    // None were inserted because validation runs before the GenServer call
    expect(await orders.count()).toBe(0);
  });
});

describe('Referential integrity — updateMany', () => {
  it('allows updateMany when new ref target exists', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const bob = await customers.insert({ name: 'Bob' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    await orders.insert({ customerId: alice.id, product: 'Gadget' });
    const count = await orders.updateMany({ customerId: alice.id }, { customerId: bob.id });
    expect(count).toBe(2);
  });

  it('rejects updateMany when new ref target does not exist', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    await expect(
      orders.updateMany({ customerId: alice.id }, { customerId: 999 }),
    ).rejects.toThrow(ReferentialIntegrityError);
  });

  it('allows updateMany for non-ref fields', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    const count = await orders.updateMany({ customerId: alice.id }, { product: 'Updated' });
    expect(count).toBe(1);
  });
});

describe('Referential integrity — deleteMany', () => {
  it('cascade-deletes on deleteMany', async () => {
    const { customers, orders } = await setupCustomersAndOrders(ordersWithCascadeDef);
    const alice = await customers.insert({ name: 'Alice' });
    const bob = await customers.insert({ name: 'Bob' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    await orders.insert({ customerId: bob.id, product: 'Gadget' });
    const count = await customers.deleteMany({ name: { $in: ['Alice', 'Bob'] } });
    expect(count).toBe(2);
    expect(await orders.count()).toBe(0);
  });

  it('restrict blocks deleteMany when refs exist', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    await expect(
      customers.deleteMany({ name: 'Alice' }),
    ).rejects.toThrow(ReferentialIntegrityError);
  });
});

describe('Referential integrity — upsert', () => {
  it('validates refs on upsert-as-insert', async () => {
    const { orders } = await setupCustomersAndOrders();
    await expect(
      orders.upsert({ customerId: 999, product: 'Widget' }),
    ).rejects.toThrow(ReferentialIntegrityError);
  });

  it('validates refs on upsert-as-update', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    await expect(
      orders.upsert({ id: order.id, customerId: 999, product: 'Widget' }),
    ).rejects.toThrow(ReferentialIntegrityError);
  });

  it('allows upsert when refs are valid', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.upsert({ customerId: alice.id, product: 'Widget' });
    expect(order.customerId).toBe(alice.id);
  });
});

describe('Referential integrity — multi-level cascade', () => {
  it('cascades through multiple levels', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersWithCascadeDef);
    await store.defineBucket('line_items', {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        orderId: { type: 'number', required: true, ref: 'orders', onDelete: 'cascade' },
        sku: { type: 'string', required: true },
      },
    });

    const customers = store.bucket('customers');
    const orders = store.bucket('orders');
    const lineItems = store.bucket('line_items');

    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });
    await lineItems.insert({ orderId: order.id, sku: 'WDG-001' });
    await lineItems.insert({ orderId: order.id, sku: 'WDG-002' });

    // Deleting the customer should cascade-delete the order and all its line items
    await customers.delete(alice.id);
    expect(await customers.count()).toBe(0);
    expect(await orders.count()).toBe(0);
    expect(await lineItems.count()).toBe(0);
  });
});

describe('Referential integrity — mixed onDelete strategies', () => {
  it('handles mixed cascade and set_null across buckets', async () => {
    store = await Store.start();
    await store.defineBucket('customers', customersDef);
    await store.defineBucket('orders', ordersWithCascadeDef);
    await store.defineBucket('reviews', {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        customerId: { type: 'number', ref: 'customers', onDelete: 'set_null' },
        text: { type: 'string', required: true },
      },
    });

    const customers = store.bucket('customers');
    const orders = store.bucket('orders');
    const reviews = store.bucket('reviews');

    const alice = await customers.insert({ name: 'Alice' });
    await orders.insert({ customerId: alice.id, product: 'Widget' });
    const review = await reviews.insert({ customerId: alice.id, text: 'Great!' });

    // Deleting customer cascades orders, sets_null reviews
    await customers.delete(alice.id);
    expect(await orders.count()).toBe(0);
    const updatedReview = await reviews.get(review.id);
    expect(updatedReview!.customerId).toBeNull();
  });
});

describe('Referential integrity — string keys', () => {
  it('works with UUID (string) keys', async () => {
    store = await Store.start();
    await store.defineBucket('users', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        name: { type: 'string', required: true },
      },
    });
    await store.defineBucket('posts', {
      key: 'id',
      schema: {
        id: { type: 'string', generated: 'uuid' },
        authorId: { type: 'string', required: true, ref: 'users' },
        title: { type: 'string', required: true },
      },
    });

    const users = store.bucket('users');
    const posts = store.bucket('posts');

    const user = await users.insert({ name: 'Alice' });
    const post = await posts.insert({ authorId: user.id, title: 'Hello' });
    expect(post.authorId).toBe(user.id);

    // Restrict: can't delete user with posts
    await expect(users.delete(user.id)).rejects.toThrow(ReferentialIntegrityError);
  });
});

describe('Referential integrity — index maintenance', () => {
  it('updates reverse index on update (allows delete after ref change)', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const bob = await customers.insert({ name: 'Bob' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });

    // Order references Alice — can't delete Alice
    await expect(customers.delete(alice.id)).rejects.toThrow(ReferentialIntegrityError);

    // Change ref to Bob
    await orders.update(order.id, { customerId: bob.id });

    // Now Alice can be deleted (no more references)
    await customers.delete(alice.id);
    expect(await customers.get(alice.id)).toBeUndefined();
  });

  it('cleans up reverse index on record delete', async () => {
    const { customers, orders } = await setupCustomersAndOrders();
    const alice = await customers.insert({ name: 'Alice' });
    const order = await orders.insert({ customerId: alice.id, product: 'Widget' });

    // Delete the order
    await orders.delete(order.id);

    // Now Alice has no incoming refs — can be deleted
    await customers.delete(alice.id);
    expect(await customers.get(alice.id)).toBeUndefined();
  });
});

describe('Referential integrity — schema validation', () => {
  it('rejects set_null + required combination at definition time', async () => {
    store = await Store.start();
    await expect(
      store.defineBucket('bad', {
        key: 'id',
        schema: {
          id: { type: 'number', generated: 'autoincrement' },
          parentId: { type: 'number', required: true, ref: 'other', onDelete: 'set_null' },
        },
      }),
    ).rejects.toThrow(/set_null.*required/);
  });
});

describe('Referential integrity — bucket without refs', () => {
  it('works normally for buckets with no ref fields', async () => {
    store = await Store.start();
    await store.defineBucket('items', {
      key: 'id',
      schema: {
        id: { type: 'number', generated: 'autoincrement' },
        name: { type: 'string', required: true },
      },
    });
    const items = store.bucket('items');
    const item = await items.insert({ name: 'Foo' });
    await items.update(item.id, { name: 'Bar' });
    await items.delete(item.id);
    expect(await items.count()).toBe(0);
  });
});
