# Referenční dokumentace noex-store API

> Kompletní referenční dokumentace pro `@hamicek/noex-store` — schématem řízený in-memory store postavený na noex actor modelu.

## Jak používat tuto referenci

Tato reference je organizována podle modulů. Každá stránka dokumentuje všechny veřejné metody, typy a volby s přesnými signaturami, tabulkami parametrů a krátkými příklady.

**Chcete se nejprve naučit koncepty?** Začněte s [Výukový průvodce](../learn/index.md), který učí noex-store od základů s postupnými příklady a cvičeními.

**Už noex-store používáte?** Použijte tuto referenci k rychlému vyhledání přesných signatur metod, výchozích hodnot voleb, chybových stavů a definic typů.

## Referenční dokumenty

### Jádro

| Dokument | Popis |
|----------|-------|
| [Store](./store.md) | `Store.start()`, `defineBucket()`, `bucket()`, `defineQuery()`, `subscribe()`, `transaction()`, `on()` a metody životního cyklu |
| [BucketHandle](./bucket-handle.md) | CRUD operace, filtrování, paginace a agregace — fluent API pro práci s daty |
| [Schéma a typy](./schema.md) | `BucketDefinition`, `FieldDefinition`, typy polí, omezení, generované hodnoty, `RecordMeta` a `SchemaValidator` |

### Reaktivita a události

| Dokument | Popis |
|----------|-------|
| [Reaktivní dotazy](./reactive-queries.md) | `defineQuery()`, `subscribe()`, `QueryContext`, sledování závislostí a porovnávání hluboké rovnosti |
| [Události](./events.md) | `store.on()`, typy událostí (`inserted`, `updated`, `deleted`) a porovnávání zástupných vzorů |

### Transakce

| Dokument | Popis |
|----------|-------|
| [Transakce](./transactions.md) | `store.transaction()`, `TransactionBucketHandle`, čtení vlastních zápisů, optimistické zamykání a `WriteBuffer` |

### Persistence a životní cyklus

| Dokument | Popis |
|----------|-------|
| [Persistence](./persistence.md) | `StorePersistenceConfig`, adaptéry, debounced snapshoty, tok obnovy a per-bucket konfigurace |
| [TTL a životní cyklus](./ttl-lifecycle.md) | Syntaxe trvání TTL, `TtlManager`, evikce `maxSize`, metadata záznamu (`_version`, `_createdAt`, `_updatedAt`, `_expiresAt`) |

### Integrace

| Dokument | Popis |
|----------|-------|
| [Rules Bridge](./bridge.md) | `bridgeStoreToRules()`, `EventReceiver`, `BridgeOptions` a obousměrná integrace store-rules |

### Utility funkce a chyby

| Dokument | Popis |
|----------|-------|
| [Utility funkce](./utilities.md) | Generátory ID (`generateUuid`, `generateCuid`), validátory formátu (`isValidEmail`, `isValidUrl`, `isValidIsoDate`), `parseTtl` a `deepEqual` |
| [Chyby](./errors.md) | Kompletní katalog tříd chyb: `ValidationError`, `UniqueConstraintError`, `TransactionConflictError` a další |

## Rychlý průvodce importem

```typescript
// Hlavní import — třída Store a typy
import { Store } from '@hamicek/noex-store';

// Typy pro definice bucketů
import type {
  BucketDefinition,
  FieldDefinition,
  SchemaDefinition,
  StoreRecord,
  RecordMeta,
} from '@hamicek/noex-store';

// Typy dotazů
import type {
  QueryFn,
  QueryContext,
  PaginateOptions,
  PaginatedResult,
} from '@hamicek/noex-store';

// Typy událostí
import type {
  BucketInsertedEvent,
  BucketUpdatedEvent,
  BucketDeletedEvent,
} from '@hamicek/noex-store';

// Třídy chyb
import {
  ValidationError,
  UniqueConstraintError,
  TransactionConflictError,
  BucketNotDefinedError,
  QueryNotDefinedError,
} from '@hamicek/noex-store';

// Utility funkce
import {
  generateUuid,
  generateCuid,
  parseTtl,
} from '@hamicek/noex-store';

// Rules bridge (vlastní vstupní bod)
import { bridgeStoreToRules } from '@hamicek/noex-store/bridge';
```

## Zdrojový kód

- [Zdrojový kód](../../../src/) — TypeScript zdrojový kód v `src/`
- [Testy](../../../tests/) — Unit a integrační testy v `tests/`
- [Balíček na npm](https://www.npmjs.com/package/@hamicek/noex-store) — `@hamicek/noex-store`

## Viz také

- [Výukový průvodce](../learn/index.md) — Tutoriály zaměřené na problémy s cvičeními pro učení noex-store od nuly
