# Proč transakce?

Váš e-shop zpracovává objednávku: odečte zásoby z bucketu `products`, vytvoří záznam v `orders` a přičte věrnostní body v `accounts`. První dvě operace uspějí, ale třetí selže — validační chyba v poli bodů. Teď máte objednávku bez věrnostních bodů a zásoby už jsou pryč. Ruční rollback znamená psát kompenzační logiku na každém místě volání a jeden vynechaný okrajový případ znamená poškozená data.

Transakce v noex-store obalují více operací nad buckety do atomické jednotky. Buď se potvrdí vše, nebo nic. Store se postará o bufferování, validaci, detekci konfliktů a rollback automaticky.

## Co se naučíte

- Proč jednotlivé operace nad buckety mohou nechat vaše data v nekonzistentním stavu
- Jak manuální ošetření chyb nedokáže zaručit konzistenci
- Co znamená atomicita v kontextu zápisů napříč buckety
- Kdy použít transakce a kdy jsou zbytečné
- Jak se transakce v noex-store liší od tradičních databázových transakcí

## Problém: Neatomické zápisy napříč buckety

Představte si jednoduchý převod prostředků mezi dvěma účty:

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'transfer-demo' });

await store.defineBucket('accounts', {
  key: 'id',
  schema: {
    id:      { type: 'string', required: true },
    owner:   { type: 'string', required: true },
    balance: { type: 'number', required: true, min: 0 },
  },
});

const accounts = store.bucket('accounts');

await accounts.insert({ id: 'alice', owner: 'Alice', balance: 1000 });
await accounts.insert({ id: 'bob', owner: 'Bob', balance: 500 });
```

### Pokus 1: Sekvenční operace

Nejjednodušší přístup — odečtěte z jednoho účtu, přičtěte na druhý:

```typescript
// Převod $200 od Alice k Bobovi
const alice = await accounts.get('alice');
const bob = await accounts.get('bob');

await accounts.update('alice', { balance: (alice!.balance as number) - 200 });
// Alice: $800 ✓

await accounts.update('bob', { balance: (bob!.balance as number) + 200 });
// Bob: $700 ✓
```

Funguje to, když se nic nepokazí. Ale co když druhý update selže?

```typescript
await accounts.update('alice', { balance: (alice!.balance as number) - 200 });
// Alice: $800 — peníze odečteny

await accounts.update('bob', { balance: (bob!.balance as number) + 99999 });
// Selhání: zůstatek překračuje limit nebo validace selže
// Bob: $500 — nezměněn

// Výsledek: $200 zmizelo. Alice přišla o peníze, Bob nic nezískal.
```

### Pokus 2: Manuální Try/Catch

Obalte operace do try/catch a při selhání proveďte rollback:

```typescript
const aliceBefore = await accounts.get('alice');

await accounts.update('alice', { balance: (aliceBefore!.balance as number) - 200 });

try {
  await accounts.update('bob', { balance: (bob!.balance as number) + 200 });
} catch (err) {
  // Vrátit odečtení u Alice
  await accounts.update('alice', { balance: aliceBefore!.balance });
  throw err;
}
```

Lepší, ale křehké:

| Problém | Co se pokazí |
|---------|-------------|
| Race condition | Jiná operace změní zůstatek Alice mezi odečtením a rollbackem a undo ji přepíše |
| Zapomenutý rollback | K logice převodu se přidá nový bucket, ale catch blok se neaktualizuje |
| Částečná viditelnost | Ostatní části systému vidí odečtený zůstatek Alice předtím, než je Bobovi přičteno — okno nekonzistence |
| Chyba v rollbacku | Samotná undo operace může selhat a nechat data trvale nekonzistentní |

### Pokus 3: Transakce

S transakcí store bufferuje všechny zápisy a aplikuje je atomicky:

```typescript
await store.transaction(async (tx) => {
  const txAccounts = await tx.bucket('accounts');

  const alice = await txAccounts.get('alice');
  const bob = await txAccounts.get('bob');

  await txAccounts.update('alice', { balance: (alice!.balance as number) - 200 });
  await txAccounts.update('bob', { balance: (bob!.balance as number) + 200 });
});
// Obě aktualizace uspějí atomicky, nebo se žádná neaplikuje.
```

Žádné zápisy se nedostanou do store, dokud se transakce nepotvrdí. Pokud jakákoliv operace selže, buffer se zahodí a store zůstane nezměněn.

## Co transakce garantují

```text
  Bez transakcí                     S transakcemi
  +-----------------------+         +-----------------------+
  |                       |         |                       |
  |  update(alice, -200)  |         |  buffer(alice, -200)  |
  |     |                 |         |     |                 |
  |     v  (zapsáno)      |         |     v  (bufferováno)  |
  |                       |         |                       |
  |  update(bob, +200)    |         |  buffer(bob, +200)    |
  |     |                 |         |     |                 |
  |     x  (selhání!)     |         |     v  (bufferováno)  |
  |                       |         |                       |
  |  Alice: $800 (špatně) |         |  commit() — atomicky  |
  |  Bob:   $500 (špatně) |         |     |                 |
  |                       |         |     v                 |
  |  Nekonzistentní stav  |         |  Alice: $800          |
  |                       |         |  Bob:   $700          |
  +-----------------------+         |                       |
                                    |  Konzistentní stav    |
                                    +-----------------------+
```

| Vlastnost | Garance |
|-----------|---------|
| **Atomicita** | Všechny zápisy uspějí společně, nebo se žádný neaplikuje |
| **Bufferované zápisy** | Žádné mutace nejsou viditelné do commitu |
| **Automatický rollback** | Pokud callback vyhodí výjimku nebo commit selže, všechny změny se zahodí |
| **Napříč buckety** | Jedna transakce může pokrývat více bucketů |
| **Detekce konfliktů** | Optimistické zamykání založené na verzích detekuje souběžné modifikace |

## Kdy použít transakce

**Používejte transakce když:**

- Operace pokrývá více bucketů, které musí zůstat konzistentní (např. převod prostředků, vytvoření objednávky + odečtení zásob)
- Potřebujete přečíst hodnotu z jednoho bucketu a zapsat odvozenou hodnotu do jiného ve stejné atomické jednotce
- Více záznamů musí být aktualizováno společně, nebo vůbec
- Chcete zabránit ostatním operacím vidět mezistav

**Vynechte transakce když:**

- Pracujete s jedním záznamem v jednom bucketu — jednotlivé operace jsou již atomické
- Operace jsou nezávislé a nepotřebují být vzájemně konzistentní
- Pouze čtete data — transakce přidávají režii pro práci pouze pro čtení

## Jak se transakce noex-store liší

Transakce noex-store nejsou tradiční ACID databázové transakce. Co očekávat:

| Aspekt | noex-store | Tradiční DB |
|--------|-----------|-------------|
| **Úložiště** | V paměti | Na disku |
| **Izolace** | Read-committed s optimistickým zamykáním | Konfigurovatelná (READ_COMMITTED, SERIALIZABLE, atd.) |
| **Souběžnost** | Optimistická — konflikty detekovány při commitu | Pesimistické zámky nebo MVCC |
| **Trvanlivost** | Pouze s povoleným adaptérem persistence | Write-ahead log, garantováno |
| **Rozsah** | Napříč buckety v rámci jednoho store | Napříč tabulkami, někdy napříč databázemi |

Klíčový poznatek: noex-store používá **optimistické řízení souběžnosti**. Transakce nezamykají žádná data. Místo toho zaznamenávají, které verze záznamů byly přečteny, a při commitu store zkontroluje, zda tyto záznamy nebyly mezitím někým jiným změněny. Pokud ano, transakce selže s `TransactionConflictError`.

## Cvičení

Zvažte následující scénář:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('inventory', {
  key: 'sku',
  schema: {
    sku:   { type: 'string', required: true },
    name:  { type: 'string', required: true },
    stock: { type: 'number', required: true, min: 0 },
  },
});

await store.defineBucket('orders', {
  key: 'id',
  schema: {
    id:       { type: 'number', generated: 'autoincrement' },
    sku:      { type: 'string', required: true },
    quantity: { type: 'number', required: true, min: 1 },
  },
});

const inventory = store.bucket('inventory');
const ordersBucket = store.bucket('orders');

await inventory.insert({ sku: 'WIDGET-1', name: 'Widget', stock: 10 });
```

1. Co se stane, když zavoláte `inventory.update('WIDGET-1', { stock: 5 })` a poté `ordersBucket.insert({ sku: 'WIDGET-1', quantity: 5 })`, a druhá operace selže?
2. Jak byste obalili tyto dvě operace do transakce?
3. Jakou garanci poskytuje transakce, kterou sekvenční verze nemá?
4. Pokud jiná část systému aktualizuje zásoby widgetu mezi čtením a commitem vaší transakce, co se stane?

<details>
<summary>Řešení</summary>

1. Inventář by ukazoval `stock: 5`, ale žádná objednávka by neexistovala — zásoby byly odečteny bez odpovídající objednávky. Data jsou nekonzistentní.

2. Obalte obě operace do `store.transaction()`:

```typescript
await store.transaction(async (tx) => {
  const txInventory = await tx.bucket('inventory');
  const txOrders = await tx.bucket('orders');

  const widget = await txInventory.get('WIDGET-1');
  const currentStock = widget!.stock as number;

  if (currentStock < 5) {
    throw new Error('Insufficient stock');
  }

  await txInventory.update('WIDGET-1', { stock: currentStock - 5 });
  await txOrders.insert({ sku: 'WIDGET-1', quantity: 5 });
});
```

3. Transakce garantuje, že buď se odečtení zásob i vytvoření objednávky provede, nebo ani jedno. Pokud insert objednávky selže (např. validační chyba), aktualizace zásob se nikdy neaplikuje. Vnější pozorovatelé nikdy nevidí mezistav, kdy jsou zásoby odečteny, ale objednávka neexistuje.

4. Transakce při commitu detekuje nesoulad verzí a vyhodí `TransactionConflictError`. Ani aktualizace zásob, ani vytvoření objednávky se neaplikuje. Tuto chybu můžete zachytit a transakci zopakovat s čerstvými daty.

</details>

## Shrnutí

- Jednotlivé operace nad buckety jsou atomické, ale **operace napříč buckety nejsou** — selhání mezi dvěma operacemi nechá data nekonzistentní
- Manuální try/catch rollback je křehký: je zranitelný vůči race conditions, vynechaným okrajovým případům a selhání rollbacku
- **`store.transaction()`** obaluje více operací do atomické jednotky — všechny zápisy uspějí společně, nebo se žádný neaplikuje
- Zápisy uvnitř transakce jsou **lokálně bufferovány** a aplikují se až při commitu
- Pokud callback vyhodí výjimku, buffer se zahodí a žádné zápisy se nedostanou do store
- noex-store používá **optimistické řízení souběžnosti** — během transakce se nedrží žádné zámky, konflikty se detekují při commitu
- Používejte transakce pro konzistenci napříč buckety; vynechte je pro operace s jedním záznamem

---

Další: [Použití transakcí](./02-pouziti-transakci.md)
