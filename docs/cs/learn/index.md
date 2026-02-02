# Naučte se noex-store

Komplexní příručka pro Node.js vývojáře, kteří chtějí zvládnout reaktivní správu dat v paměti. Tento průvodce učí nejen API, ale i **způsob myšlení** v datových vrstvách se schématy, validací a událostmi.

## Pro koho je tento průvodce?

- Node.js / TypeScript vývojáře (středně pokročilé+)
- Znáte async/await a základní událostmi řízené vzory
- Nepotřebujete předchozí zkušenosti s actor modelem ani reaktivním programováním
- Hledáte strukturovaný způsob správy stavu aplikace s validací, indexováním a real-time odběry

## Cesta učením

### Část 1: Úvod

Pochopte, proč reaktivní datová vrstva existuje a jaké problémy řeší.

| Kapitola | Popis |
|----------|-------|
| [1.1 Proč reaktivní datová vrstva?](./01-uvod/01-proc-datova-vrstva.md) | Problémy s roztříštěným stavem, zastaralým UI a duplicitní validací |
| [1.2 Klíčové koncepty](./01-uvod/02-klicove-koncepty.md) | Přehled Store, Bucket, Schema, Events, Reactive Queries a Transactions |

### Část 2: Začínáme

Naučte se základní stavební kameny.

| Kapitola | Popis |
|----------|-------|
| [2.1 Váš první Store](./02-zaciname/01-prvni-store.md) | Instalace, `Store.start()`, životní cyklus a ukončení |
| [2.2 Buckety a Schémata](./02-zaciname/02-buckety-a-schemata.md) | `defineBucket()`, typy polí, definice schémat a strom supervize |
| [2.3 CRUD operace](./02-zaciname/03-crud-operace.md) | Insert, get, update, delete, clear, all a metadata záznamů |

### Část 3: Schema a validace

Zajistěte integritu dat na hranici systému.

| Kapitola | Popis |
|----------|-------|
| [3.1 Omezení polí](./03-schema-validace/01-omezeni-poli.md) | Required, enum, min/max, pattern, format a `ValidationError` |
| [3.2 Automatické generování](./03-schema-validace/02-automaticke-generovani.md) | UUID, CUID, autoincrement, časové značky a výchozí hodnoty |
| [3.3 Unikátní omezení](./03-schema-validace/03-unikatni-omezeni.md) | Unikátní pole, automatické indexy a `UniqueConstraintError` |

### Část 4: Dotazování

Efektivní vyhledávání a agregace dat.

| Kapitola | Popis |
|----------|-------|
| [4.1 Filtrování a vyhledávání](./04-dotazovani/01-filtrovani-a-vyhledavani.md) | `where()`, `findOne()`, `count()`, `first()`, `last()` a logika AND |
| [4.2 Sekundární indexy](./04-dotazovani/02-sekundarni-indexy.md) | Definice indexů, `IndexManager` a porovnání výkonu scan vs index |
| [4.3 Paginace a agregace](./04-dotazovani/03-paginace-a-agregace.md) | Kurzorová paginace, `sum`, `avg`, `min`, `max` |

### Část 5: Reaktivní dotazy

Udržujte UI synchronizované bez pollingu.

| Kapitola | Popis |
|----------|-------|
| [5.1 Co jsou reaktivní dotazy?](./05-reaktivni-dotazy/01-co-jsou-reaktivni-dotazy.md) | Proč polling nestačí, reaktivita ve stylu Convex a model odběrů |
| [5.2 Definice a odběr](./05-reaktivni-dotazy/02-definice-a-odber.md) | `defineQuery()`, `subscribe()`, `runQuery()` a parametrizované dotazy |
| [5.3 Sledování závislostí](./05-reaktivni-dotazy/03-sledovani-zavislosti.md) | Sledování na úrovni Bucket vs záznamů, proxy-based `QueryContext` |

### Část 6: Události

Reagujte na změny dat napříč systémem.

| Kapitola | Popis |
|----------|-------|
| [6.1 Systém událostí](./06-udalosti/01-system-udalosti.md) | `store.on(pattern, handler)`, typy událostí a zástupné vzory |
| [6.2 Vzory událostí](./06-udalosti/02-vzory-udalosti.md) | Auditní logy, notifikace a kaskádové mazání |

### Část 7: Transakce

Garantujte konzistenci napříč více Buckety.

| Kapitola | Popis |
|----------|-------|
| [7.1 Proč transakce?](./07-transakce/01-proc-transakce.md) | Problém nekonzistentního stavu při operacích napříč Buckety |
| [7.2 Použití transakcí](./07-transakce/02-pouziti-transakci.md) | `store.transaction()`, `tx.bucket()` a čtení vlastních zápisů |
| [7.3 Optimistické zamykání](./07-transakce/03-optimisticke-zamykani.md) | Kontrola verzí, `TransactionConflictError`, rollback a dvoufázový commit |

### Část 8: Persistence

Přežijte restarty a obnovte data elegantně.

| Kapitola | Popis |
|----------|-------|
| [8.1 Ukládání dat](./08-persistence/01-ukladani-dat.md) | `StorePersistenceConfig`, adaptéry, debounced snapshoty a per-bucket opt-out |
| [8.2 Obnova a snapshoty](./08-persistence/02-obnova-a-snapshoty.md) | Obnova po restartu, `BucketSnapshot` a manuální flush |

### Část 9: TTL a životní cyklus

Řiďte expiraci dat a využití paměti.

| Kapitola | Popis |
|----------|-------|
| [9.1 TTL expirace](./09-ttl-zivotni-cyklus/01-ttl-expirace.md) | Syntaxe trvání, `_expiresAt`, `TtlManager` a `purgeTtl()` |
| [9.2 Limity velikosti a evikce](./09-ttl-zivotni-cyklus/02-limity-velikosti-a-evikce.md) | `maxSize`, LRU evikce a paměťově ohraničené Buckety |

### Část 10: Architektura do hloubky

Pochopte vnitřní fungování.

| Kapitola | Popis |
|----------|-------|
| [10.1 Strom supervize](./10-architektura/01-strom-supervize.md) | Store, Supervisor, BucketServer GenServery, registr a strategie one-for-one |
| [10.2 Tok dat](./10-architektura/02-tok-dat.md) | Životní cyklus požadavku: insert přes validaci, indexaci, uložení a publikování |

### Část 11: Propojení s pravidly

Integrace s enginem noex-rules.

| Kapitola | Popis |
|----------|-------|
| [11.1 Nastavení Bridge](./11-propojeni-s-pravidly/01-nastaveni-bridge.md) | `bridgeStoreToRules()`, `EventReceiver` a `BridgeOptions` |
| [11.2 Pravidla řízená Storem](./11-propojeni-s-pravidly/02-pravidla-rizena-storem.md) | Obousměrná integrace mezi Store a pravidlovým enginem |

### Část 12: Projekty

Aplikujte vše na reálných projektech.

| Kapitola | Popis |
|----------|-------|
| [12.1 Správa úloh](./12-projekty/01-sprava-uloh.md) | Schémata, CRUD, indexy, reaktivní dotazy, transakce a paginace |
| [12.2 Real-time analytika](./12-projekty/02-realtime-analytika.md) | Agregace, TTL, maxSize a reaktivní KPI dashboard |
| [12.3 Inventář s pravidly](./12-projekty/03-inventar-s-pravidly.md) | Store + propojení s pravidly, transakce, události a persistence |

## Formát kapitol

Každá kapitola obsahuje:

1. **Úvod** - Co se naučíte a proč je to důležité
2. **Teorie** - Vysvětlení konceptu s ASCII diagramy a srovnávacími tabulkami
3. **Příklad** - Kompletní spustitelný TypeScript kód s postupnými kroky
4. **Cvičení** - Praktický úkol se skrytým řešením
5. **Shrnutí** - Klíčové poznatky
6. **Další kroky** - Odkaz na následující kapitolu

## Potřebujete pomoc?

- [API Reference](../../README.md) - Kompletní dokumentace API

---

Jste připraveni začít? Pokračujte na [Proč reaktivní datová vrstva?](./01-uvod/01-proc-datova-vrstva.md)
