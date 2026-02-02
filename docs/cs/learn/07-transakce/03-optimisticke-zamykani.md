# Optimistické zamykání

Vaše transakce přečte produkt se `stock: 10`, odečte 3 a bufferuje `stock: 7`. Mezitím jiná operace aktualizuje zásoby stejného produktu na 5. Když se vaše transakce pokusí o commit, přepsala by reálné zásoby 5 vaším zastaralým výpočtem 7 — a tiše by poškodila data.

noex-store tomu brání pomocí optimistického zamykání. Každý záznam nese pole `_version`, které se inkrementuje při každém updatu. Při commitu store zkontroluje, že verze, které jste přečetli, stále odpovídají aktuálním verzím. Pokud ne, commit selže s `TransactionConflictError` a všechny změny se vrátí zpět.

## Co se naučíte

- Jak `_version` sleduje změny záznamů a umožňuje detekci konfliktů
- Co se děje během procesu dvoufázového commitu
- Jak `TransactionConflictError` hlásí konflikty
- Jak rollback napříč buckety udržuje store konzistentní
- Jak události interagují s commity a rollbacky transakcí
- Jak implementovat logiku opakování pro obnovu po konfliktu

## Příprava

Všechny příklady v této kapitole používají následující store:

```typescript
import { Store, TransactionConflictError } from '@hamicek/noex-store';

const store = await Store.start({ name: 'locking-demo' });

await store.defineBucket('accounts', {
  key: 'id',
  schema: {
    id:      { type: 'string', required: true },
    owner:   { type: 'string', required: true },
    balance: { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('transfers', {
  key: 'id',
  schema: {
    id:     { type: 'number', generated: 'autoincrement' },
    from:   { type: 'string', required: true },
    to:     { type: 'string', required: true },
    amount: { type: 'number', required: true, min: 1 },
  },
});

const accounts = store.bucket('accounts');
const transfers = store.bucket('transfers');

await accounts.insert({ id: 'alice', owner: 'Alice', balance: 1000 });
await accounts.insert({ id: 'bob', owner: 'Bob', balance: 500 });
```

## Sledování verzí

Každý záznam v noex-store má pole `_version`, které začíná na 1 a inkrementuje se při každém updatu:

```typescript
const alice = await accounts.get('alice');
console.log(alice?._version); // 1

await accounts.update('alice', { balance: 900 });
const aliceV2 = await accounts.get('alice');
console.log(aliceV2?._version); // 2

await accounts.update('alice', { balance: 800 });
const aliceV3 = await accounts.get('alice');
console.log(aliceV3?._version); // 3
```

Verze je součástí metadat záznamu spolu s `_createdAt` a `_updatedAt`:

| Pole | Typ | Chování |
|------|-----|---------|
| `_version` | `number` | Začíná na 1, inkrementuje se při každém updatu |
| `_createdAt` | `number` | Unix milisekundový timestamp, nastaven jednou při insertu |
| `_updatedAt` | `number` | Unix milisekundový timestamp, aktualizován při každém zápisu |

## Jak funguje detekce konfliktů

Když přečtete záznam uvnitř transakce a poté jej aktualizujete nebo smažete, transakce zaznamená verzi, kterou jste přečetli, jako `expectedVersion`. Při commitu BucketServer porovná očekávanou verzi s aktuální verzí v reálném store:

```text
  Transakce                              Reálný store
  +-----------------------------------+    +-------------------+
  |                                   |    |                   |
  |  get('alice')                     | -> | alice._version: 1 |
  |    -> přečte verzi 1              |    |                   |
  |                                   |    |                   |
  |  update('alice', { balance: 800 })|    |                   |
  |    -> bufferuje s                 |    |                   |
  |       expectedVersion: 1          |    |                   |
  |                                   |    |                   |
  +-----------------------------------+    +-------------------+

  Commit:
    Očekávaná verze: 1
    Aktuální verze:  1   -> Shoda ✓ -> Aplikuj update

  Ale pokud jiná operace mezitím aktualizovala Alice:

  Transakce                              Reálný store
  +-----------------------------------+    +-------------------+
  |                                   |    |                   |
  |  get('alice')                     | -> | alice._version: 1 |
  |    -> přečte verzi 1              |    |                   |
  |                                   |    | (externí update)  |
  |  update('alice', { balance: 800 })|    | alice._version: 2 |
  |    -> bufferuje s                 |    |                   |
  |       expectedVersion: 1          |    |                   |
  |                                   |    |                   |
  +-----------------------------------+    +-------------------+

  Commit:
    Očekávaná verze: 1
    Aktuální verze:  2   -> Nesoulad ✗ -> TransactionConflictError
```

## Dvoufázový commit

Když se transakce potvrzuje, každý bucket zpracovává operace ve dvou fázích:

### Fáze 1: Validace

Všechny operace jsou validovány bez mutace stavu:

- **Insert**: Kontrola, že klíč ještě neexistuje; validace unikátních omezení
- **Update**: Kontrola, že záznam existuje; ověření, že `_version` odpovídá `expectedVersion`; validace unikátních omezení
- **Delete**: Pokud záznam existuje, ověření, že `_version` odpovídá `expectedVersion`

Pokud jakákoliv validace selže, fáze vyhodí chybu a žádné mutace nenastanou.

### Fáze 2: Aplikace

Pokud všechny validace projdou, mutace se aplikují a sbírají se undo operace:

- **Insert**: Přidání do indexů a tabulky; generování události `inserted`; zaznamenání `undo_insert`
- **Update**: Aktualizace indexů a tabulky; generování události `updated`; zaznamenání `undo_update` se starým záznamem
- **Delete**: Odebrání z indexů a tabulky; generování události `deleted`; zaznamenání `undo_delete` s odstraněným záznamem

Pokud během aplikace dojde k chybě, undo operace se aplikují v opačném pořadí pro obnovení konzistence.

```text
  Fáze 1: Validace         Fáze 2: Aplikace
  +--------------------+     +--------------------+
  |                    |     |                    |
  |  insert: klíč      |     |  insert: uložit +  |
  |    volný?          |     |    index + undo    |
  |  update: verze?    |     |  update: uložit +  |
  |  delete: verze?    |     |    index + undo    |
  |                    |     |  delete: uložit +  |
  |  VŠE projde?      |     |    index + undo    |
  |    ANO -> Fáze 2   |     |                    |
  |    NE  -> vyhodit  |     |  Vrátit: události  |
  |                    |     |    + undo operace   |
  +--------------------+     +--------------------+
```

## TransactionConflictError

Když je detekován nesoulad verzí, store vyhodí `TransactionConflictError`:

```typescript
import { TransactionConflictError } from '@hamicek/noex-store';

// Reset zůstatku Alice pro tento příklad
await accounts.update('alice', { balance: 1000 });

// Simulace souběžné modifikace
const aliceSnapshot = await accounts.get('alice');

// Jiná operace změní Alice mezi naším čtením a commitem
await accounts.update('alice', { balance: 950 });

try {
  await store.transaction(async (tx) => {
    const txAccounts = await tx.bucket('accounts');

    // Čtení Alice — získá verzi z reálného store
    const alice = await txAccounts.get('alice');
    // alice._version je nyní zastaralá (přečetli jsme starou verzi před externím updatem)

    await txAccounts.update('alice', {
      balance: (alice!.balance as number) - 200,
    });
  });
} catch (err) {
  if (err instanceof TransactionConflictError) {
    console.log(err.message);
    // Transaction conflict in bucket "accounts" for key "alice":
    //   Version mismatch: expected 3, got 4
    console.log(err.bucket); // 'accounts'
    console.log(err.key);    // 'alice'
  }
}
```

Chyba obsahuje:

| Vlastnost | Typ | Popis |
|-----------|-----|-------|
| `message` | `string` | Lidsky čitelný popis včetně bucketu, klíče a důvodu |
| `bucket` | `string` | Název bucketu, kde ke konfliktu došlo |
| `key` | `unknown` | Primární klíč konfliktního záznamu |
| `field` | `string \| undefined` | Konkrétní pole (pro konflikty unikátních omezení) |

## Rollback napříč buckety

Když transakce pokrývá více bucketů, potvrzují se sekvenčně. Pokud pozdější bucket selže, všechny dříve potvrzené buckety se vrátí zpět:

```text
  Transakce se dotýká: accounts, transfers

  Sekvence commitu:
  +--------------------------------------------------+
  |                                                  |
  |  1. Commit accounts   -> ÚSPĚCH                 |
  |     (undo operace uloženy)                       |
  |                                                  |
  |  2. Commit transfers  -> SELHÁNÍ (konflikt!)     |
  |                                                  |
  |  3. Rollback accounts <- aplikace undo operací   |
  |     (v opačném pořadí)                           |
  |                                                  |
  |  4. Vyhodit TransactionConflictError             |
  |                                                  |
  +--------------------------------------------------+
```

```typescript
// Demonstrace rollbacku napříč buckety
await accounts.update('alice', { balance: 1000 });
await accounts.update('bob', { balance: 500 });

// Vložení převodu, na kterém vytvoříme konflikt
const existingTransfer = await transfers.insert({
  from: 'alice', to: 'bob', amount: 50,
});

// Externí modifikace převodu pro vytvoření konfliktu verzí
await transfers.update(existingTransfer.id, { amount: 75 });

try {
  await store.transaction(async (tx) => {
    const txAccounts = await tx.bucket('accounts');
    const txTransfers = await tx.bucket('transfers');

    // Aktualizace účtů (izolovaně by uspěla)
    const alice = await txAccounts.get('alice');
    await txAccounts.update('alice', {
      balance: (alice!.balance as number) - 100,
    });

    // Aktualizace záznamu převodu (při commitu dojde ke konfliktu)
    const transfer = await txTransfers.get(existingTransfer.id);
    await txTransfers.update(existingTransfer.id, { amount: 100 });
  });
} catch (err) {
  if (err instanceof TransactionConflictError) {
    console.log('Detekován konflikt — všechny změny vráceny zpět');
  }
}

// Ověření: zůstatek Alice je nezměněn (rollback uspěl)
const alice = await accounts.get('alice');
console.log(`Zůstatek Alice: ${alice?.balance}`); // 1000 (nezměněn)
```

### Rollback je best-effort

Pokud samotný rollback selže (např. BucketServer není dostupný), store selhání zaloguje a pokračuje ve vracení zbývajících bucketů. V praxi je to vzácné, protože noex-store běží v paměti v rámci stejného procesu.

## Události a transakce

Události se publikují až po úspěšném commitu všech bucketů:

```typescript
import type { BucketEvent } from '@hamicek/noex-store';

const events: BucketEvent[] = [];
await store.on<BucketEvent>('bucket.*.*', (event) => {
  events.push(event);
});

// Úspěšná transakce — události publikovány po commitu
await store.transaction(async (tx) => {
  const txAccounts = await tx.bucket('accounts');
  await txAccounts.update('alice', { balance: 900 });
  await txAccounts.update('bob', { balance: 600 });
});

// Čekání na asynchronní doručení událostí
await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`Události po úspěšné tx: ${events.length}`); // 2

// Neúspěšná transakce — žádné události publikovány
events.length = 0;

try {
  await store.transaction(async (tx) => {
    const txAccounts = await tx.bucket('accounts');
    await txAccounts.update('alice', { balance: 800 });
    throw new Error('Business logic failure');
  });
} catch {
  // Očekáváno
}

await new Promise((resolve) => setTimeout(resolve, 50));
console.log(`Události po neúspěšné tx: ${events.length}`); // 0
```

| Scénář | Události publikovány? |
|--------|----------------------|
| Úspěšný commit | Ano — všechny události publikovány po úspěchu všech bucketů |
| Callback vyhodí výjimku | Ne — buffer zahozen, commit se nikdy nespustí |
| Konflikt při commitu | Ne — rollback zruší všechny změny |
| Částečný commit + rollback | Ne — události se sbírají, ale publikují se až po úspěchu všech bucketů |

## Vzor opakování (Retry)

Když nastane `TransactionConflictError`, standardní obnova je zopakovat transakci s čerstvými daty. Protože transakce při každém pokusu znovu čtou záznamy, retry přirozeně získá nejnovější verze:

```typescript
async function transferWithRetry(
  from: string,
  to: string,
  amount: number,
  maxRetries = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await store.transaction(async (tx) => {
        const txAccounts = await tx.bucket('accounts');

        const sender = await txAccounts.get(from);
        const receiver = await txAccounts.get(to);

        if (sender === undefined || receiver === undefined) {
          throw new Error('Account not found');
        }

        const senderBalance = sender.balance as number;
        if (senderBalance < amount) {
          throw new Error(`Insufficient funds: ${senderBalance} < ${amount}`);
        }

        await txAccounts.update(from, { balance: senderBalance - amount });
        await txAccounts.update(to, {
          balance: (receiver.balance as number) + amount,
        });
      });

      return; // Úspěch
    } catch (err) {
      if (err instanceof TransactionConflictError && attempt < maxRetries) {
        console.log(`Konflikt při pokusu ${attempt}, opakuji...`);
        continue;
      }
      throw err; // Chyba jiná než konflikt nebo překročen maximální počet pokusů
    }
  }
}

await transferWithRetry('alice', 'bob', 200);
```

### Zásady pro opakování

| Zásada | Důvod |
|--------|-------|
| **Udržujte callback čistý** | Vedlejší efekty (HTTP volání, logování) by se spouštěly při každém opakování |
| **Omezte počet pokusů** | Nekonečné opakování při vysoké souběžnosti může způsobit livelock |
| **Čtěte znovu uvnitř callbacku** | Opakování musí použít čerstvá data; nezachytávejte proměnné zvenku |
| **Nechytejte chyby jiné než konflikty** | Validační chyby a chyby business logiky by se neměly opakovat |

## Kompletní funkční příklad

Bankovní systém se souběžnými převody a zpracováním konfliktů:

```typescript
import { Store, TransactionConflictError } from '@hamicek/noex-store';
import type { BucketEvent } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'optimistic-locking-demo' });

  await store.defineBucket('accounts', {
    key: 'id',
    schema: {
      id:      { type: 'string', required: true },
      owner:   { type: 'string', required: true },
      balance: { type: 'number', required: true, min: 0 },
    },
  });

  await store.defineBucket('transfers', {
    key: 'id',
    schema: {
      id:        { type: 'number', generated: 'autoincrement' },
      from:      { type: 'string', required: true },
      to:        { type: 'string', required: true },
      amount:    { type: 'number', required: true, min: 1 },
      timestamp: { type: 'number', required: true },
    },
  });

  const accounts = store.bucket('accounts');
  const transfersBucket = store.bucket('transfers');

  await accounts.insert({ id: 'alice', owner: 'Alice', balance: 1000 });
  await accounts.insert({ id: 'bob', owner: 'Bob', balance: 500 });
  await accounts.insert({ id: 'carol', owner: 'Carol', balance: 750 });

  // Sledování událostí
  const events: string[] = [];
  await store.on<BucketEvent>('bucket.*.*', (event) => {
    events.push(`${event.bucket}.${event.type}(${String(event.key)})`);
  });

  // --- Převod s opakováním ---

  async function transfer(
    from: string,
    to: string,
    amount: number,
    maxRetries = 3,
  ): Promise<number> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await store.transaction(async (tx) => {
          const txAccounts = await tx.bucket('accounts');
          const txTransfers = await tx.bucket('transfers');

          const sender = await txAccounts.get(from);
          const receiver = await txAccounts.get(to);

          if (sender === undefined) throw new Error(`Account ${from} not found`);
          if (receiver === undefined) throw new Error(`Account ${to} not found`);

          const senderBalance = sender.balance as number;
          if (senderBalance < amount) {
            throw new Error(
              `Insufficient funds: ${sender.owner} has $${senderBalance}, needs $${amount}`,
            );
          }

          await txAccounts.update(from, { balance: senderBalance - amount });
          await txAccounts.update(to, {
            balance: (receiver.balance as number) + amount,
          });

          const record = await txTransfers.insert({
            from,
            to,
            amount,
            timestamp: Date.now(),
          });

          return record.id as number;
        });
      } catch (err) {
        if (err instanceof TransactionConflictError && attempt < maxRetries) {
          console.log(`  [retry] Konflikt při pokusu ${attempt}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unreachable');
  }

  // --- Provedení převodů ---

  console.log('--- Převod 1: Alice -> Bob $200 ---');
  const t1 = await transfer('alice', 'bob', 200);
  console.log(`Převod #${t1} dokončen`);

  console.log('\n--- Převod 2: Bob -> Carol $100 ---');
  const t2 = await transfer('bob', 'carol', 100);
  console.log(`Převod #${t2} dokončen`);

  console.log('\n--- Převod 3: Nedostatek prostředků ---');
  try {
    await transfer('carol', 'alice', 5000);
  } catch (err) {
    console.log(`Selhání: ${(err as Error).message}`);
  }

  // --- Konečné zůstatky ---

  console.log('\n--- Konečné zůstatky ---');
  for (const id of ['alice', 'bob', 'carol']) {
    const acc = await accounts.get(id);
    console.log(`  ${acc?.owner}: $${acc?.balance}`);
  }
  // Alice: $800, Bob: $600, Carol: $850

  // --- Log převodů ---

  const allTransfers = await transfersBucket.all();
  console.log(`\n--- Log převodů (${allTransfers.length} záznamů) ---`);
  for (const t of allTransfers) {
    console.log(`  #${t.id}: ${t.from} -> ${t.to} $${t.amount}`);
  }

  // --- Události ---

  await new Promise((resolve) => setTimeout(resolve, 50));
  console.log(`\n--- Události (${events.length}) ---`);
  for (const e of events) {
    console.log(`  ${e}`);
  }

  await store.stop();
}

main();
```

## Cvičení

Máte následující store se systémem rezervace vstupenek:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('events', {
  key: 'id',
  schema: {
    id:             { type: 'string', required: true },
    name:           { type: 'string', required: true },
    availableSeats: { type: 'number', required: true, min: 0 },
    price:          { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('bookings', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    eventId:  { type: 'string', required: true },
    userId:   { type: 'string', required: true },
    seats:    { type: 'number', required: true, min: 1 },
    total:    { type: 'number', required: true, min: 0 },
  },
  indexes: ['eventId', 'userId'],
});

const eventsBucket = store.bucket('events');
const bookings = store.bucket('bookings');

await eventsBucket.insert({ id: 'concert-1', name: 'Jazz Night', availableSeats: 50, price: 75 });
```

Napište funkci `bookSeats(userId, eventId, seats)`, která:

1. Použije transakci s logikou opakování (max 3 pokusy)
2. Přečte událost pro kontrolu dostupných míst
3. Vyhodí business chybu, pokud není dostatek míst (neopakovat)
4. Atomicky odečte místa a vytvoří rezervaci
5. Vrátí záznam rezervace
6. Zachytí `TransactionConflictError` a zopakuje

<details>
<summary>Řešení</summary>

```typescript
import { TransactionConflictError } from '@hamicek/noex-store';

async function bookSeats(
  userId: string,
  eventId: string,
  seats: number,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await store.transaction(async (tx) => {
        const txEvents = await tx.bucket('events');
        const txBookings = await tx.bucket('bookings');

        const event = await txEvents.get(eventId);
        if (event === undefined) {
          throw new Error(`Event ${eventId} not found`);
        }

        const available = event.availableSeats as number;
        if (available < seats) {
          // Business chyba — neopakovat
          throw new Error(
            `Not enough seats for ${event.name}: requested ${seats}, available ${available}`,
          );
        }

        // Odečtení míst
        await txEvents.update(eventId, { availableSeats: available - seats });

        // Vytvoření rezervace
        const booking = await txBookings.insert({
          eventId,
          userId,
          seats,
          total: seats * (event.price as number),
        });

        return booking;
      });
    } catch (err) {
      if (err instanceof TransactionConflictError && attempt < 3) {
        console.log(`Konflikt rezervace (pokus ${attempt}), opakuji...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

// Test: úspěšná rezervace
const booking = await bookSeats('user-1', 'concert-1', 2);
console.log(`Rezervace #${booking.id}: ${booking.seats} míst, $${booking.total}`);
// Rezervace #1: 2 míst, $150

// Ověření odečtení míst
const event = await eventsBucket.get('concert-1');
console.log(`Dostupná místa: ${event?.availableSeats}`); // 48

// Test: nedostatek míst
try {
  await bookSeats('user-2', 'concert-1', 100);
} catch (err) {
  console.log((err as Error).message);
  // Not enough seats for Jazz Night: requested 100, available 48
}

// Místa nezměněna po business chybě
const eventAfter = await eventsBucket.get('concert-1');
console.log(`Místa (nezměněno): ${eventAfter?.availableSeats}`); // 48
```

</details>

## Shrnutí

- Každý záznam má pole **`_version`**, které začíná na 1 a inkrementuje se při každém updatu — je základem detekce konfliktů
- noex-store používá **optimistické zamykání**: transakce nedrží zámky; místo toho zaznamenávají očekávané verze a ověřují je při commitu
- Proces commitu je **dvoufázový protokol**: Fáze 1 validuje všechny operace bez mutací, Fáze 2 je aplikuje a sbírá undo operace
- **`TransactionConflictError`** se vyhodí při detekci nesouladu verzí — obsahuje název bucketu, klíč záznamu a popis konfliktu
- **Rollback napříč buckety**: pokud commit bucketu B selže poté, co bucket A uspěl, změny bucketu A se vrátí zpět pomocí zaznamenaných undo operací
- **Události jsou transakční**: publikují se až po úspěšném commitu všech bucketů — neúspěšná nebo vrácená transakce nepublikuje žádné události
- **Logika opakování** je standardní vzor obnovy — čtěte čerstvá data při každém pokusu, omezte počet opakování a neopakujte chyby business logiky
- Udržujte callbacky transakcí **čisté** — vyhněte se vedlejším efektům, které by se neměly opakovat
- Rollback je **best-effort**: ve vzácném případě, že undo selže, store pokračuje ve vracení zbývajících bucketů

---

Další: [Ukládání dat](../08-persistence/01-ukladani-dat.md)
