# Použití transakcí

Rozumíte, proč transakce existují. Teď je potřebujete použít. API je malé — `store.transaction()` vám dá callback s transakčním kontextem a `tx.bucket()` vrátí handly, které vypadají jako běžné bucket handly, ale bufferují zápisy lokálně. Čtení vidí vaše bufferované zápisy okamžitě (read-your-own-writes) a vše se potvrdí atomicky, když callback skončí.

Tato kapitola pokrývá kompletní transakční API: zápis, čtení, vracení hodnot, ošetření chyb a pravidla, která řídí, co můžete uvnitř transakce dělat.

## Co se naučíte

- Jak `store.transaction()` vytváří a potvrzuje transakci
- Jak `tx.bucket()` poskytuje transakční bucket handly
- Jak jsou operace zápisu (insert, update, delete) bufferovány
- Jak operace čtení vidí bufferované zápisy (read-your-own-writes)
- Jak vracet hodnoty z transakcí
- Co se stane, když callback vyhodí výjimku

## Příprava

Všechny příklady v této kapitole používají následující store:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'transactions-demo' });

await store.defineBucket('customers', {
  key: 'id',
  schema: {
    id:    { type: 'string', generated: 'uuid' },
    name:  { type: 'string', required: true },
    email: { type: 'string', required: true, format: 'email' },
    tier:  { type: 'string', enum: ['basic', 'premium', 'vip'], default: 'basic' },
  },
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:         { type: 'number', generated: 'autoincrement' },
    customerId: { type: 'string', required: true },
    total:      { type: 'number', required: true, min: 0 },
    status:     { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
  },
  indexes: ['customerId', 'status'],
});

await store.defineBucket('loyaltyPoints', {
  key: 'customerId',
  schema: {
    customerId: { type: 'string', required: true },
    points:     { type: 'number', required: true, min: 0 },
  },
});

const customers = store.bucket('customers');
const orders = store.bucket('orders');
const loyaltyPoints = store.bucket('loyaltyPoints');
```

## Životní cyklus transakce

```text
  store.transaction(async (tx) => { ... })
      |
      v
  1. Vytvoření TransactionContext
      |
      v
  2. Spuštění uživatelského callbacku
     - tx.bucket('name') -> TransactionBucketHandle
     - handle.insert/update/delete -> bufferováno lokálně
     - handle.get/all/where -> čtení z overlayu + reálného store
      |
      v
  3. Callback vrátí výsledek
      |
      v
  4. Commit: aplikace všech bufferovaných zápisů atomicky
      |
      v
  5. Publikování událostí (až po úspěchu všech bucketů)
      |
      v
  6. Vrácení výsledku volajícímu
```

## Získání bucket handlů

Uvnitř transakce přistupujete k bucketům přes `tx.bucket()` místo `store.bucket()`. Transakční handle bufferuje zápisy a překrývá je při čtení:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const txOrders = await tx.bucket('orders');

  // txCustomers a txOrders jsou instance TransactionBucketHandle.
  // Mají stejné read/write API jako běžný BucketHandle,
  // ale všechny zápisy jsou bufferovány do commitu.
});
```

Klíčové rozdíly oproti běžnému `store.bucket()`:

| Aspekt | `store.bucket()` | `tx.bucket()` |
|--------|-------------------|---------------|
| Vrací | `BucketHandle` | `TransactionBucketHandle` |
| Zápisy | Aplikovány okamžitě | Bufferovány do commitu |
| Čtení | Vždy z reálného store | Overlay (buffer) + reálný store |
| Styl volání | Synchronní | `await` (asynchronní) |
| Cachování | Handle je znovupoužitelný napříč voláními | Handle je cachován v rámci transakce |

Volání `tx.bucket('customers')` dvakrát vrátí stejný handle — transakce jej cachuje při prvním přístupu.

## Operace zápisu

Všechny tři operace zápisu — `insert`, `update` a `delete` — fungují identicky jako jejich protějšky v `BucketHandle`, s tím rozdílem, že zápisy jsou bufferovány:

### Insert

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  const customer = await txCustomers.insert({
    name: 'Alice',
    email: 'alice@example.com',
  });

  console.log(customer.id);        // Vygenerované UUID
  console.log(customer._version);   // 1
  console.log(customer.tier);       // 'basic' (výchozí)

  // Záznam NENÍ v reálném store.
  // Existuje pouze v transakčním bufferu.
});
// Po skončení callbacku commit aplikuje insert.
// Nyní je záznam v reálném store.
```

### Update

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  // Předpokládáme, že Alice byla vložena v předchozí operaci
  await txCustomers.update(aliceId, { tier: 'premium' });

  // Update je bufferován. Reálný store stále ukazuje tier: 'basic'.
});
// Po commitu reálný store ukazuje tier: 'premium'.
```

Aktualizace záznamu, který neexistuje, vyhodí chybu:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  await txCustomers.update('nonexistent', { tier: 'vip' });
  // Error: Record with key "nonexistent" not found in bucket "customers"
});
```

### Delete

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  await txCustomers.delete(aliceId);

  // Bufferováno. Alice je stále v reálném store.
});
// Po commitu je Alice z reálného store odstraněna.
```

Smazání záznamu, který neexistuje, je no-op — nevyhodí chybu:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  await txCustomers.delete('nonexistent'); // Žádná chyba
});
```

## Čtení vlastních zápisů (Read-Your-Own-Writes)

Definující vlastnost čtení v transakci: vidí vaše bufferované zápisy. Když čtete uvnitř transakce, handle nejprve zkontroluje buffer a do reálného store se obrátí pouze pro nebufferované záznamy.

### Jak overlay funguje

```text
  txCustomers.get(key)
      |
      v
  Kontrola bufferu:
  +----------------------------+
  | Smazáno v této tx?         |  --> vrátí undefined
  | Vloženo/aktualizováno v tx?|  --> vrátí bufferovaný záznam
  | Není v bufferu?            |  --> dotaz na reálný BucketServer
  +----------------------------+
```

### get()

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  // Vložení nového zákazníka (bufferováno)
  const alice = await txCustomers.insert({
    name: 'Alice',
    email: 'alice@example.com',
  });

  // Čtení zpět — vrátí bufferovaný záznam
  const found = await txCustomers.get(alice.id);
  console.log(found?.name); // 'Alice'

  // Aktualizace (bufferováno)
  await txCustomers.update(alice.id, { tier: 'premium' });

  // Čtení znovu — vrátí aktualizovaný bufferovaný záznam
  const updated = await txCustomers.get(alice.id);
  console.log(updated?.tier); // 'premium'

  // Smazání (bufferováno)
  await txCustomers.delete(alice.id);

  // Čtení znovu — vrátí undefined (smazáno v této tx)
  const deleted = await txCustomers.get(alice.id);
  console.log(deleted); // undefined
});
```

### all()

`all()` sloučí reálný store s bufferem: odstraní smazané záznamy, nahradí aktualizované záznamy a připojí vložené záznamy:

```typescript
// Existující záznamy ve store
await customers.insert({ id: 'c1', name: 'Bob', email: 'bob@example.com' });
await customers.insert({ id: 'c2', name: 'Carol', email: 'carol@example.com' });

await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  await txCustomers.insert({ name: 'Dave', email: 'dave@example.com' });
  await txCustomers.update('c1', { tier: 'vip' });
  await txCustomers.delete('c2');

  const all = await txCustomers.all();
  // Obsahuje:
  //   Bob (aktualizován na vip) — overlay nahrazuje reálný záznam
  //   Dave — vložen v bufferu, připojen k výsledkům
  //   Carol NENÍ zahrnuta — smazána v bufferu
  console.log(all.length); // 2
});
```

### where(), findOne(), count()

Tyto metody staví na `all()` s aplikovaným overlayem:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');

  await txCustomers.insert({ name: 'Eve', email: 'eve@example.com', tier: 'premium' });

  // where() vidí bufferovaný insert
  const premiums = await txCustomers.where({ tier: 'premium' });
  console.log(premiums.length); // Zahrnuje Eve

  // findOne() vidí bufferovaný insert
  const eve = await txCustomers.findOne({ name: 'Eve' });
  console.log(eve?.email); // 'eve@example.com'

  // count() vidí bufferovaný insert
  const total = await txCustomers.count();
  console.log(total); // Zahrnuje Eve v počtu
});
```

## Vracení hodnot

`store.transaction()` vrací cokoliv, co vrátí callback:

```typescript
const customerId = await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const txPoints = await tx.bucket('loyaltyPoints');

  const customer = await txCustomers.insert({
    name: 'Frank',
    email: 'frank@example.com',
  });

  await txPoints.insert({
    customerId: customer.id,
    points: 100,
  });

  return customer.id;
});

console.log(customerId); // UUID vygenerované uvnitř transakce
```

Návratový typ se odvodí z callbacku:

```typescript
// TypeScript odvodí: Promise<{ customerId: string; orderId: number }>
const result = await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const txOrders = await tx.bucket('orders');

  const customer = await txCustomers.insert({
    name: 'Grace',
    email: 'grace@example.com',
  });

  const order = await txOrders.insert({
    customerId: customer.id as string,
    total: 99.99,
  });

  return {
    customerId: customer.id as string,
    orderId: order.id as number,
  };
});
```

## Ošetření chyb

### Callback vyhodí výjimku — žádné zápisy se neaplikují

Pokud váš callback vyhodí chybu, transakce se nikdy nepotvrdí. Buffer se zahodí a store zůstane nezměněn:

```typescript
try {
  await store.transaction(async (tx) => {
    const txCustomers = await tx.bucket('customers');

    await txCustomers.insert({
      name: 'Hank',
      email: 'hank@example.com',
    });

    // Chyba business logiky
    throw new Error('Something went wrong');
  });
} catch (err) {
  console.log(err.message); // 'Something went wrong'
}

// Hank nebyl nikdy vložen — buffer byl zahozen
const hank = await customers.findOne({ name: 'Hank' });
console.log(hank); // undefined
```

```text
  Callback transakce
  +------------------------------------+
  |                                    |
  |  insert(Hank)  -> bufferováno     |
  |                                    |
  |  throw Error   -> callback končí  |
  |                                    |
  +------------------------------------+
      |
      v
  commit() nikdy nezavolán
  Buffer zahozen
  Store nezměněn
```

### Nedefinovaný bucket

Požadavek na bucket, který nebyl definován, vyhodí chybu okamžitě:

```typescript
await store.transaction(async (tx) => {
  await tx.bucket('nonexistent');
  // Error: Bucket "nonexistent" is not defined
});
```

## Transakce napříč více buckety

Skutečná síla transakcí spočívá v koordinaci zápisů napříč více buckety:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const txOrders = await tx.bucket('orders');
  const txPoints = await tx.bucket('loyaltyPoints');

  // Vytvoření zákazníka
  const customer = await txCustomers.insert({
    name: 'Iris',
    email: 'iris@example.com',
    tier: 'premium',
  });

  // Vytvoření objednávky propojené se zákazníkem
  const order = await txOrders.insert({
    customerId: customer.id as string,
    total: 500,
  });

  // Inicializace věrnostních bodů
  await txPoints.insert({
    customerId: customer.id as string,
    points: Math.floor((order.total as number) * 0.1), // 10 % z celkové částky objednávky
  });
});

// Všechny tři záznamy existují, nebo žádný z nich.
```

Pokud insert věrnostních bodů selže (např. validační chyba), zákazník ani objednávka se nevytvoří. Store se postará o rollback automaticky.

## Prázdné transakce

Transakce bez zápisů je no-op — potvrdí se okamžitě bez doteku jakéhokoliv bucketu:

```typescript
await store.transaction(async (tx) => {
  const txCustomers = await tx.bucket('customers');
  const all = await txCustomers.all();
  // Pouze čtení — žádné zápisy bufferovány
  console.log(`Nalezeno ${all.length} zákazníků`);
});
// Žádný commit odeslán do žádného bucketu. Žádné události publikovány.
```

To je bezpečné, ale zbytečné — pokud potřebujete pouze čtení, použijte běžné `store.bucket()` handly.

## Kompletní funkční příklad

Systém zpracování objednávek, který atomicky vytvoří zákazníka, zadá objednávku a přidělí věrnostní body:

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'tx-example' });

  await store.defineBucket('customers', {
    key: 'id',
    schema: {
      id:    { type: 'string', generated: 'uuid' },
      name:  { type: 'string', required: true },
      email: { type: 'string', required: true, format: 'email' },
      tier:  { type: 'string', enum: ['basic', 'premium', 'vip'], default: 'basic' },
    },
  });

  await store.defineBucket('orders', {
    key: 'id',
    schema: {
      id:         { type: 'number', generated: 'autoincrement' },
      customerId: { type: 'string', required: true },
      total:      { type: 'number', required: true, min: 0 },
      status:     { type: 'string', enum: ['pending', 'paid', 'shipped'], default: 'pending' },
    },
    indexes: ['customerId', 'status'],
  });

  await store.defineBucket('loyaltyPoints', {
    key: 'customerId',
    schema: {
      customerId: { type: 'string', required: true },
      points:     { type: 'number', required: true, min: 0 },
    },
  });

  const customers = store.bucket('customers');
  const ordersBucket = store.bucket('orders');
  const points = store.bucket('loyaltyPoints');

  // --- Atomické zpracování objednávky ---

  const result = await store.transaction(async (tx) => {
    const txCustomers = await tx.bucket('customers');
    const txOrders = await tx.bucket('orders');
    const txPoints = await tx.bucket('loyaltyPoints');

    // 1. Vytvoření zákazníka
    const customer = await txCustomers.insert({
      name: 'Alice',
      email: 'alice@example.com',
      tier: 'premium',
    });
    console.log(`Vytvořen zákazník: ${customer.name} (${customer.id})`);

    // 2. Zadání objednávky
    const order = await txOrders.insert({
      customerId: customer.id as string,
      total: 250,
    });
    console.log(`Vytvořena objednávka #${order.id}: $${order.total}`);

    // 3. Přidělení věrnostních bodů (10 % z celkové částky objednávky)
    const earned = Math.floor((order.total as number) * 0.1);
    await txPoints.insert({
      customerId: customer.id as string,
      points: earned,
    });
    console.log(`Přiděleno ${earned} věrnostních bodů`);

    // 4. Čtení zpět v rámci transakce (read-your-own-writes)
    const customerOrders = await txOrders.where({
      customerId: customer.id as string,
    });
    console.log(`Zákazník má ${customerOrders.length} objednávku/ky v této tx`);

    return { customerId: customer.id as string, orderId: order.id as number };
  });

  console.log(`\nTransakce potvrzena:`);
  console.log(`  Zákazník: ${result.customerId}`);
  console.log(`  Objednávka: #${result.orderId}`);

  // --- Ověření zvenku transakce ---

  const customer = await customers.get(result.customerId);
  console.log(`\nOvěření:`);
  console.log(`  Zákazník: ${customer?.name} (${customer?.tier})`);

  const customerOrders = await ordersBucket.where({
    customerId: result.customerId,
  });
  console.log(`  Objednávky: ${customerOrders.length}`);

  const customerPoints = await points.get(result.customerId);
  console.log(`  Body: ${customerPoints?.points}`);

  // --- Neúspěšná transakce — nic se nezapisuje ---

  try {
    await store.transaction(async (tx) => {
      const txOrders = await tx.bucket('orders');

      await txOrders.insert({
        customerId: result.customerId,
        total: 1000,
      });

      throw new Error('Payment declined');
    });
  } catch (err) {
    console.log(`\nTransakce selhala: ${(err as Error).message}`);
  }

  // Počet objednávek se nezměnil
  const ordersAfter = await ordersBucket.where({
    customerId: result.customerId,
  });
  console.log(`Objednávky po neúspěšné tx: ${ordersAfter.length}`); // Stále 1

  await store.stop();
}

main();
```

## Cvičení

Máte následující store:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('products', {
  key: 'sku',
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true },
    stock: { type: 'number', required: true, min: 0 },
    price: { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('cart', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    sku:      { type: 'string', required: true },
    quantity: { type: 'number', required: true, min: 1 },
    userId:   { type: 'string', required: true },
  },
  indexes: ['userId', 'sku'],
});

const products = store.bucket('products');
const cart = store.bucket('cart');

await products.insert({ sku: 'LAPTOP', name: 'Laptop', stock: 5, price: 999 });
await products.insert({ sku: 'MOUSE', name: 'Mouse', stock: 20, price: 29 });
```

Napište funkci `addToCart(userId: string, sku: string, quantity: number)`, která:

1. Použije transakci k atomickému odečtení zásob a přidání položky do košíku
2. Přečte produkt uvnitř transakce pro kontrolu zásob
3. Vyhodí chybu, pokud není dostatek zásob (bez modifikace čehokoliv)
4. Vrátí vytvořenou položku košíku
5. Po transakci ověřte, že zásoby byly odečteny čtením zvenku

<details>
<summary>Řešení</summary>

```typescript
async function addToCart(userId: string, sku: string, quantity: number) {
  return await store.transaction(async (tx) => {
    const txProducts = await tx.bucket('products');
    const txCart = await tx.bucket('cart');

    // 1. Čtení produktu (z reálného store, protože jsme ho nebufferovali)
    const product = await txProducts.get(sku);
    if (product === undefined) {
      throw new Error(`Product ${sku} not found`);
    }

    // 2. Kontrola zásob
    const currentStock = product.stock as number;
    if (currentStock < quantity) {
      throw new Error(
        `Insufficient stock for ${product.name}: requested ${quantity}, available ${currentStock}`,
      );
    }

    // 3. Odečtení zásob (bufferováno)
    await txProducts.update(sku, { stock: currentStock - quantity });

    // 4. Přidání položky do košíku (bufferováno)
    const cartItem = await txCart.insert({ sku, quantity, userId });

    // 5. Ověření v rámci tx (read-your-own-writes)
    const updatedProduct = await txProducts.get(sku);
    console.log(`Zásoby po odečtení (v tx): ${updatedProduct?.stock}`);

    return cartItem;
  });
}

// Testování
const item = await addToCart('user-1', 'LAPTOP', 2);
console.log(`Položka košíku #${item.id}: ${item.quantity}x ${item.sku}`);

// Ověření mimo transakci
const laptop = await products.get('LAPTOP');
console.log(`Zásoby laptopů: ${laptop?.stock}`); // 3

// Pokus o nákup více než je dostupné
try {
  await addToCart('user-2', 'LAPTOP', 10);
} catch (err) {
  console.log((err as Error).message);
  // Insufficient stock for Laptop: requested 10, available 3
}

// Zásoby nezměněny po neúspěšné transakci
const laptopAfter = await products.get('LAPTOP');
console.log(`Zásoby laptopů (nezměněno): ${laptopAfter?.stock}`); // Stále 3
```

</details>

## Shrnutí

- **`store.transaction(fn)`** vytvoří transakci, spustí callback a potvrdí atomicky, když callback skončí
- **`tx.bucket(name)`** vrátí `TransactionBucketHandle` — stejné API jako `BucketHandle`, ale zápisy jsou bufferovány
- **Insert, update a delete** jsou bufferovány lokálně — žádné zápisy se nedostanou do store do commitu
- **Čtení vlastních zápisů**: `get()`, `all()`, `where()`, `findOne()` a `count()` nejprve zkontrolují buffer, pak se obrátí na reálný store
- Transakce **vrací cokoliv, co vrátí callback** — TypeScript odvodí typ automaticky
- Pokud callback **vyhodí výjimku**, buffer se zahodí a žádné zápisy se neaplikují
- **Transakce napříč buckety** koordinují zápisy napříč libovolným počtem bucketů atomicky
- **Prázdné transakce** (bez zápisů) jsou no-op — pro práci pouze pro čtení použijte běžné bucket handly
- `tx.bucket()` je asynchronní a cachovaný — volání dvakrát se stejným názvem vrátí stejný handle

---

Další: [Optimistické zamykání](./03-optimisticke-zamykani.md)
