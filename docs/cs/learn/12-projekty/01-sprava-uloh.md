# Správa úloh

Naučili jste se schémata, CRUD, indexy, reaktivní dotazy, transakce a paginaci jako samostatné koncepty. Nyní je všechny spojíte do jediné ucelené aplikace -- systému pro správu úloh s projekty, úlohami a štítky. Tato kapitola provede celým návrhem: od modelování schémat přes stránkované seznamy a živé dashboardy až po atomické operace napříč buckety.

Na konci budete mít spustitelný projekt, který využívá každou klíčovou funkci noex-store v realistickém scénáři.

## Co se naučíte

- Jak modelovat související entity (projekty, úlohy, štítky) pomocí schémat a indexů
- Jak provádět CRUD operace napříč více buckety
- Jak dotazovat a stránkovat seznamy úloh efektivně pomocí sekundárních indexů
- Jak vytvořit živý dashboard s reaktivními dotazy
- Jak používat transakce pro atomické operace napříč buckety
- Jak spojit všechny klíčové funkce do aplikace produkční kvality

## Návrh schémat

Systém správy úloh potřebuje tři typy entit: projekty seskupující úlohy, úlohy patřící do projektů a štítky pro klasifikaci. Začněte návrhem schématu -- to je základ, na kterém stojí vše ostatní.

### Projekty

```typescript
import { Store } from '@hamicek/noex-store';

const store = await Store.start({ name: 'task-management' });

await store.defineBucket('projects', {
  key: 'id',
  schema: {
    id:          { type: 'string', generated: 'uuid' },
    name:        { type: 'string', required: true, minLength: 1, maxLength: 100 },
    description: { type: 'string', default: '' },
    status:      { type: 'string', enum: ['active', 'archived'], default: 'active' },
    taskCount:   { type: 'number', default: 0, min: 0 },
    createdAt:   { type: 'date', generated: 'timestamp' },
  },
  indexes: ['status'],
});
```

Klíčová rozhodnutí:

- **`taskCount`** je denormalizovaný čítač. Jeho údržba uvnitř transakcí zamezuje nutnosti procházet všechny úlohy jen proto, abyste zobrazili počet vedle názvu projektu.
- **Index na `status`** umožňuje rychlé filtrování aktivních vs. archivovaných projektů.
- **`minLength: 1`** brání vytvoření projektů s prázdným názvem přímo na úrovni schématu.

### Úlohy

```typescript
await store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:          { type: 'string', generated: 'cuid' },
    projectId:   { type: 'string', required: true },
    title:       { type: 'string', required: true, minLength: 1, maxLength: 200 },
    description: { type: 'string', default: '' },
    status:      { type: 'string', enum: ['todo', 'in_progress', 'done'], default: 'todo' },
    priority:    { type: 'number', enum: [1, 2, 3, 4], default: 3 },
    tag:         { type: 'string', default: '' },
    dueDate:     { type: 'string', default: '' },
  },
  indexes: ['projectId', 'status', 'priority', 'tag'],
});
```

Klíčová rozhodnutí:

- **Index na `projectId`** je zásadní -- každý dotaz na "úlohy v projektu X" využije tento index místo procházení celého bucketu.
- **`priority` jako čísla** (1 = kritická, 4 = nízká) umožňuje číselné porovnání při řazení na straně aplikace.
- **Čtyři indexy** pokrývají nejčastější vzory dotazů: podle projektu, podle stavu, podle priority a podle štítku.
- **Klíč `cuid`** poskytuje globálně unikátní, seřaditelné identifikátory.

### Štítky

```typescript
await store.defineBucket('tags', {
  key: 'name',
  schema: {
    name:  { type: 'string', required: true, minLength: 1, maxLength: 30 },
    color: { type: 'string', required: true, pattern: '^#[0-9a-fA-F]{6}$' },
  },
});
```

Štítky používají `name` jako přirozený klíč -- není potřeba generované ID. Vzor `color` vynucuje hexadecimální kódy barev přímo na úrovni schématu.

### Vztahy mezi entitami

```text
  +-------------+       +-------------+       +--------+
  |  projects   |       |   tasks     |       |  tags  |
  |-------------|       |-------------|       |--------|
  | id (uuid)   |<------| projectId   |       | name   |
  | name        |       | id (cuid)   |------>| color  |
  | description |       | title       |  tag  +--------+
  | status      |       | description |
  | taskCount   |       | status      |
  | createdAt   |       | priority    |
  +-------------+       | tag         |
                        | dueDate     |
                        +-------------+

  One project  ->  many tasks
  One tag      ->  many tasks (via tag field)
```

## Bucket Handle

Po definici všech bucketů si získejte handle pro zbytek aplikace:

```typescript
const projects = store.bucket('projects');
const tasks = store.bucket('tasks');
const tags = store.bucket('tags');
```

## Naplnění daty

Naplňte store výchozími daty, se kterými budete pracovat:

```typescript
// Create tags
await tags.insert({ name: 'backend', color: '#3B82F6' });
await tags.insert({ name: 'frontend', color: '#10B981' });
await tags.insert({ name: 'bug', color: '#EF4444' });
await tags.insert({ name: 'feature', color: '#8B5CF6' });

// Create a project with tasks — atomically
const projectId = await store.transaction(async (tx) => {
  const txProjects = await tx.bucket('projects');
  const txTasks = await tx.bucket('tasks');

  const project = await txProjects.insert({
    name: 'Website Redesign',
    description: 'Complete overhaul of the marketing website',
    taskCount: 5,
  });

  const pid = project.id as string;

  await txTasks.insert({
    projectId: pid, title: 'Design new homepage', status: 'done',
    priority: 1, tag: 'frontend',
  });
  await txTasks.insert({
    projectId: pid, title: 'Implement responsive nav', status: 'in_progress',
    priority: 2, tag: 'frontend',
  });
  await txTasks.insert({
    projectId: pid, title: 'Set up API endpoints', status: 'in_progress',
    priority: 2, tag: 'backend',
  });
  await txTasks.insert({
    projectId: pid, title: 'Fix broken image links', status: 'todo',
    priority: 1, tag: 'bug',
  });
  await txTasks.insert({
    projectId: pid, title: 'Add contact form', status: 'todo',
    priority: 3, tag: 'feature',
  });

  return pid;
});
```

Transakce zaručuje, že projekt a jeho úlohy jsou vytvořeny společně. Pokud jakýkoli insert selže (např. chyba validace), žádný z nich se neuloží.

## CRUD operace

### Vytvoření úlohy

Každé vytvoření úlohy musí aktualizovat `taskCount` projektu. Použijte transakci, aby zůstaly synchronizované:

```typescript
async function createTask(
  data: { projectId: string; title: string; priority?: number; tag?: string },
) {
  return await store.transaction(async (tx) => {
    const txTasks = await tx.bucket('tasks');
    const txProjects = await tx.bucket('projects');

    // Verify project exists
    const project = await txProjects.get(data.projectId);
    if (project === undefined) {
      throw new Error(`Project ${data.projectId} not found`);
    }

    // Insert task
    const task = await txTasks.insert(data);

    // Increment project task count
    await txProjects.update(data.projectId, {
      taskCount: (project.taskCount as number) + 1,
    });

    return task;
  });
}

const newTask = await createTask({
  projectId,
  title: 'Write unit tests',
  priority: 2,
  tag: 'backend',
});
console.log(`Created: ${newTask.title} (${newTask.id})`);
```

### Aktualizace úlohy

Přechody stavů jsou jednoduché aktualizace. Omezení `enum` ve schématu brání neplatným stavům:

```typescript
async function updateTaskStatus(taskId: string, status: string) {
  return await tasks.update(taskId, { status });
}

await updateTaskStatus(newTask.id as string, 'in_progress');
```

Pokud předáte neplatný stav jako `'cancelled'`, validátor schématu vyhodí `ValidationError`.

### Smazání úlohy

Mazání je zrcadlovým obrazem vytvoření -- atomicky snižte čítač projektu:

```typescript
async function deleteTask(taskId: string) {
  await store.transaction(async (tx) => {
    const txTasks = await tx.bucket('tasks');
    const txProjects = await tx.bucket('projects');

    const task = await txTasks.get(taskId);
    if (task === undefined) return;

    const project = await txProjects.get(task.projectId as string);
    if (project !== undefined) {
      await txProjects.update(task.projectId as string, {
        taskCount: Math.max(0, (project.taskCount as number) - 1),
      });
    }

    await txTasks.delete(taskId);
  });
}
```

`Math.max(0, ...)` je pojistka proti záporným hodnotám -- defenzivní kód pro denormalizovaný čítač.

## Dotazování úloh

### Filtrování podle projektu

Index `projectId` z toho dělá indexované vyhledávání:

```typescript
const projectTasks = await tasks.where({ projectId });
console.log(`Tasks in project: ${projectTasks.length}`);
// Tasks in project: 6
```

### Filtrování podle stavu

```typescript
const todoTasks = await tasks.where({ status: 'todo' });
console.log(`Todo: ${todoTasks.length}`);
// Todo: 2

const inProgress = await tasks.where({ status: 'in_progress' });
console.log(`In progress: ${inProgress.length}`);
// In progress: 3
```

### Kombinované filtry

`where()` přijímá více polí -- všechny podmínky se kombinují operátorem AND:

```typescript
const urgentTodo = await tasks.where({ status: 'todo', priority: 1 });
console.log(`Urgent todo items: ${urgentTodo.length}`);
// Urgent todo items: 1

const frontendInProgress = await tasks.where({
  status: 'in_progress',
  tag: 'frontend',
});
console.log(`Frontend in progress: ${frontendInProgress.length}`);
// Frontend in progress: 1
```

### Počítání

```typescript
const totalTasks = await tasks.count();
const doneTasks = await tasks.count({ status: 'done' });
console.log(`Progress: ${doneTasks}/${totalTasks} completed`);
// Progress: 1/6 completed
```

## Paginace

Pro rozsáhlé seznamy úloh načítejte úlohy stránku po stránce pomocí kurzorové paginace:

```typescript
async function listTasks(pProjectId: string, pageSize: number) {
  let cursor: unknown = undefined;
  let page = 1;

  while (true) {
    const result = await tasks.paginate({
      after: cursor,
      limit: pageSize,
    });

    // Filter client-side for project (paginate scans the full bucket)
    const pageTasks = result.records.filter(
      (r) => r.projectId === pProjectId,
    );

    if (pageTasks.length > 0) {
      console.log(`\n--- Page ${page} ---`);
      for (const task of pageTasks) {
        const statusIcon =
          task.status === 'done' ? '[x]' :
          task.status === 'in_progress' ? '[~]' : '[ ]';
        console.log(`  ${statusIcon} ${task.title} (P${task.priority})`);
      }
    }

    if (!result.hasMore) break;
    cursor = result.nextCursor;
    page++;
  }
}

await listTasks(projectId, 3);
// --- Page 1 ---
//   [x] Design new homepage (P1)
//   [~] Implement responsive nav (P2)
//   [~] Set up API endpoints (P2)
// --- Page 2 ---
//   [ ] Fix broken image links (P1)
//   [ ] Add contact form (P3)
//   [~] Write unit tests (P2)
```

## Reaktivní dashboard

Vytvořte živý dashboard, který se automaticky aktualizuje při změně úloh. Reaktivní dotazy eliminují polling -- callback se spustí vždy, když se podkladová data změní.

### Definice dotazů

```typescript
// Task counts by status for a project
store.defineQuery('projectStats', async (ctx, params: { projectId: string }) => {
  const taskBucket = ctx.bucket('tasks');

  const all = await taskBucket.where({ projectId: params.projectId });
  const todo = all.filter((t) => t.status === 'todo').length;
  const inProg = all.filter((t) => t.status === 'in_progress').length;
  const done = all.filter((t) => t.status === 'done').length;

  return { total: all.length, todo, inProgress: inProg, done };
});

// High-priority tasks across all projects
store.defineQuery('urgentTasks', async (ctx) => {
  const taskBucket = ctx.bucket('tasks');
  const all = await taskBucket.all();
  return all
    .filter((t) => (t.priority as number) <= 2 && t.status !== 'done')
    .map((t) => ({ id: t.id, title: t.title, priority: t.priority }));
});
```

### Odběr živých aktualizací

```typescript
// Get the initial state
const initialStats = await store.runQuery<{
  total: number; todo: number; inProgress: number; done: number;
}>('projectStats', { projectId });

console.log('Initial stats:', initialStats);
// Initial stats: { total: 6, todo: 2, inProgress: 3, done: 1 }

// Subscribe — callback fires on every change after subscription
const unsubStats = await store.subscribe<{
  total: number; todo: number; inProgress: number; done: number;
}>('projectStats', { projectId }, (stats) => {
  console.log('Dashboard update:', stats);
});

const unsubUrgent = await store.subscribe<
  { id: unknown; title: unknown; priority: unknown }[]
>('urgentTasks', (urgent) => {
  console.log(`Urgent tasks: ${urgent.length}`);
});
```

### Spuštění aktualizací

Jakákoli mutace nyní automaticky předá čerstvá data odběratelům:

```typescript
// Complete a task — the dashboard callback fires
await tasks.update(newTask.id as string, { status: 'done' });
await store.settle();
// Dashboard update: { total: 6, todo: 2, inProgress: 2, done: 2 }
// Urgent tasks: 2

// Add a critical task
const critical = await createTask({
  projectId,
  title: 'Fix production crash',
  priority: 1,
  tag: 'bug',
});
await store.settle();
// Dashboard update: { total: 7, todo: 3, inProgress: 2, done: 2 }
// Urgent tasks: 3

// Clean up subscriptions
await unsubStats();
await unsubUrgent();
```

`store.settle()` zajistí, že všechny callbacky reaktivních dotazů byly spuštěny před dalším `console.log` -- nezbytné pro deterministický výstup v příkladech.

## Transakce: Přesun úloh mezi projekty

Přesun úlohy z jednoho projektu do druhého vyžaduje atomickou aktualizaci tří věcí: `projectId` úlohy, `taskCount` zdrojového projektu a `taskCount` cílového projektu. Bez transakce může selhání uprostřed operace zanechat čítače v nekonzistentním stavu.

```typescript
async function moveTask(taskId: string, targetProjectId: string) {
  return await store.transaction(async (tx) => {
    const txTasks = await tx.bucket('tasks');
    const txProjects = await tx.bucket('projects');

    // 1. Read the task
    const task = await txTasks.get(taskId);
    if (task === undefined) {
      throw new Error(`Task ${taskId} not found`);
    }

    const sourceProjectId = task.projectId as string;
    if (sourceProjectId === targetProjectId) {
      return task; // No-op: already in the target project
    }

    // 2. Verify target project exists
    const targetProject = await txProjects.get(targetProjectId);
    if (targetProject === undefined) {
      throw new Error(`Project ${targetProjectId} not found`);
    }

    // 3. Read source project
    const sourceProject = await txProjects.get(sourceProjectId);

    // 4. Update task
    await txTasks.update(taskId, { projectId: targetProjectId });

    // 5. Decrement source count
    if (sourceProject !== undefined) {
      await txProjects.update(sourceProjectId, {
        taskCount: Math.max(0, (sourceProject.taskCount as number) - 1),
      });
    }

    // 6. Increment target count
    await txProjects.update(targetProjectId, {
      taskCount: (targetProject.taskCount as number) + 1,
    });

    // 7. Return updated task (read-your-own-writes)
    return await txTasks.get(taskId);
  });
}
```

Všech šest operací uspěje, nebo neuspěje žádná. Denormalizované čítače zůstávají konzistentní bez ohledu na pády, chyby validace či souběžný přístup.

### Otestujte to

```typescript
// Create a second project
const project2 = await projects.insert({
  name: 'Mobile App',
  description: 'iOS and Android companion app',
});

const moved = await moveTask(critical.id as string, project2.id as string);
console.log(`Moved "${moved?.title}" to project ${moved?.projectId}`);

// Verify counts
const p1 = await projects.get(projectId);
const p2 = await projects.get(project2.id as string);
console.log(`Website Redesign: ${p1?.taskCount} tasks`);
// Website Redesign: 6 tasks
console.log(`Mobile App: ${p2?.taskCount} tasks`);
// Mobile App: 1 tasks
```

## Kompletní funkční příklad

```typescript
import { Store } from '@hamicek/noex-store';

async function main() {
  const store = await Store.start({ name: 'task-mgmt' });

  // --- Schema definitions ---

  await store.defineBucket('projects', {
    key: 'id',
    schema: {
      id:          { type: 'string', generated: 'uuid' },
      name:        { type: 'string', required: true, minLength: 1, maxLength: 100 },
      description: { type: 'string', default: '' },
      status:      { type: 'string', enum: ['active', 'archived'], default: 'active' },
      taskCount:   { type: 'number', default: 0, min: 0 },
      createdAt:   { type: 'date', generated: 'timestamp' },
    },
    indexes: ['status'],
  });

  await store.defineBucket('tasks', {
    key: 'id',
    schema: {
      id:          { type: 'string', generated: 'cuid' },
      projectId:   { type: 'string', required: true },
      title:       { type: 'string', required: true, minLength: 1, maxLength: 200 },
      description: { type: 'string', default: '' },
      status:      { type: 'string', enum: ['todo', 'in_progress', 'done'], default: 'todo' },
      priority:    { type: 'number', enum: [1, 2, 3, 4], default: 3 },
      tag:         { type: 'string', default: '' },
      dueDate:     { type: 'string', default: '' },
    },
    indexes: ['projectId', 'status', 'priority', 'tag'],
  });

  await store.defineBucket('tags', {
    key: 'name',
    schema: {
      name:  { type: 'string', required: true, minLength: 1, maxLength: 30 },
      color: { type: 'string', required: true, pattern: '^#[0-9a-fA-F]{6}$' },
    },
  });

  const projectsBucket = store.bucket('projects');
  const tasksBucket = store.bucket('tasks');
  const tagsBucket = store.bucket('tags');

  // --- Helper functions ---

  async function createTask(
    data: { projectId: string; title: string; priority?: number; tag?: string },
  ) {
    return await store.transaction(async (tx) => {
      const txTasks = await tx.bucket('tasks');
      const txProjects = await tx.bucket('projects');

      const project = await txProjects.get(data.projectId);
      if (project === undefined) {
        throw new Error(`Project ${data.projectId} not found`);
      }

      const task = await txTasks.insert(data);
      await txProjects.update(data.projectId, {
        taskCount: (project.taskCount as number) + 1,
      });

      return task;
    });
  }

  async function deleteTask(taskId: string) {
    await store.transaction(async (tx) => {
      const txTasks = await tx.bucket('tasks');
      const txProjects = await tx.bucket('projects');

      const task = await txTasks.get(taskId);
      if (task === undefined) return;

      const project = await txProjects.get(task.projectId as string);
      if (project !== undefined) {
        await txProjects.update(task.projectId as string, {
          taskCount: Math.max(0, (project.taskCount as number) - 1),
        });
      }

      await txTasks.delete(taskId);
    });
  }

  async function moveTask(taskId: string, targetProjectId: string) {
    return await store.transaction(async (tx) => {
      const txTasks = await tx.bucket('tasks');
      const txProjects = await tx.bucket('projects');

      const task = await txTasks.get(taskId);
      if (task === undefined) {
        throw new Error(`Task ${taskId} not found`);
      }

      const sourceProjectId = task.projectId as string;
      if (sourceProjectId === targetProjectId) return task;

      const targetProject = await txProjects.get(targetProjectId);
      if (targetProject === undefined) {
        throw new Error(`Project ${targetProjectId} not found`);
      }

      const sourceProject = await txProjects.get(sourceProjectId);

      await txTasks.update(taskId, { projectId: targetProjectId });

      if (sourceProject !== undefined) {
        await txProjects.update(sourceProjectId, {
          taskCount: Math.max(0, (sourceProject.taskCount as number) - 1),
        });
      }

      await txProjects.update(targetProjectId, {
        taskCount: (targetProject.taskCount as number) + 1,
      });

      return await txTasks.get(taskId);
    });
  }

  // --- Seed data ---

  await tagsBucket.insert({ name: 'backend', color: '#3B82F6' });
  await tagsBucket.insert({ name: 'frontend', color: '#10B981' });
  await tagsBucket.insert({ name: 'bug', color: '#EF4444' });

  const project = await projectsBucket.insert({
    name: 'Website Redesign',
    description: 'Complete overhaul of the marketing website',
  });
  const pid = project.id as string;

  // Seed tasks using createTask (keeps taskCount in sync)
  await createTask({ projectId: pid, title: 'Design homepage', priority: 1, tag: 'frontend' });
  await createTask({ projectId: pid, title: 'Build API', priority: 2, tag: 'backend' });
  await createTask({ projectId: pid, title: 'Fix nav bug', priority: 1, tag: 'bug' });
  const taskToMove = await createTask({
    projectId: pid, title: 'Write docs', priority: 3,
  });

  // --- Querying ---

  const allTasks = await tasksBucket.where({ projectId: pid });
  console.log(`Project has ${allTasks.length} tasks`);
  // Project has 4 tasks

  const highPriority = await tasksBucket.where({ priority: 1 });
  console.log(`High priority: ${highPriority.length}`);
  // High priority: 2

  const bugTasks = await tasksBucket.where({ tag: 'bug' });
  console.log(`Bugs: ${bugTasks.length}`);
  // Bugs: 1

  // --- Pagination ---

  console.log('\n--- Paginated list ---');
  let cursor: unknown = undefined;
  let page = 1;

  while (true) {
    const result = await tasksBucket.paginate({ after: cursor, limit: 2 });
    console.log(`Page ${page}:`);
    for (const t of result.records) {
      console.log(`  [P${t.priority}] ${t.title}`);
    }
    if (!result.hasMore) break;
    cursor = result.nextCursor;
    page++;
  }

  // --- Reactive query ---

  store.defineQuery('stats', async (ctx, params: { projectId: string }) => {
    const tb = ctx.bucket('tasks');
    const all = await tb.where({ projectId: params.projectId });
    return {
      total: all.length,
      todo: all.filter((t) => t.status === 'todo').length,
      done: all.filter((t) => t.status === 'done').length,
    };
  });

  const stats = await store.runQuery<{ total: number; todo: number; done: number }>(
    'stats', { projectId: pid },
  );
  console.log(`\nStats: ${stats.todo} todo, ${stats.done} done, ${stats.total} total`);
  // Stats: 4 todo, 0 done, 4 total

  const unsub = await store.subscribe<{ total: number; todo: number; done: number }>(
    'stats', { projectId: pid }, (s) => {
      console.log(`Live: ${s.todo} todo, ${s.done} done, ${s.total} total`);
    },
  );

  // Complete a task — triggers reactive update
  const firstTask = allTasks[0]!;
  await tasksBucket.update(firstTask.id as string, { status: 'done' });
  await store.settle();
  // Live: 3 todo, 1 done, 4 total

  await unsub();

  // --- Move task to another project ---

  const project2 = await projectsBucket.insert({ name: 'Mobile App' });

  await moveTask(taskToMove.id as string, project2.id as string);

  const p1 = await projectsBucket.get(pid);
  const p2 = await projectsBucket.get(project2.id as string);
  console.log(`\nWebsite Redesign: ${p1?.taskCount} tasks`);
  // Website Redesign: 3 tasks
  console.log(`Mobile App: ${p2?.taskCount} tasks`);
  // Mobile App: 1 tasks

  // --- Delete a task ---

  const bugTask = bugTasks[0]!;
  await deleteTask(bugTask.id as string);

  const p1After = await projectsBucket.get(pid);
  console.log(`Website Redesign after delete: ${p1After?.taskCount} tasks`);
  // Website Redesign after delete: 2 tasks

  await store.stop();
}

main();
```

## Cvičení

Vytvořte funkci "hromadné aktualizace stavu". Máte následující store:

```typescript
const store = await Store.start({ name: 'exercise' });

await store.defineBucket('projects', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'uuid' },
    name:      { type: 'string', required: true },
    taskCount: { type: 'number', default: 0, min: 0 },
  },
});

await store.defineBucket('tasks', {
  key: 'id',
  schema: {
    id:        { type: 'string', generated: 'cuid' },
    projectId: { type: 'string', required: true },
    title:     { type: 'string', required: true },
    status:    { type: 'string', enum: ['todo', 'in_progress', 'done'], default: 'todo' },
    priority:  { type: 'number', enum: [1, 2, 3, 4], default: 3 },
  },
  indexes: ['projectId', 'status'],
});

const projectsBucket = store.bucket('projects');
const tasksBucket = store.bucket('tasks');

// Seed
const project = await projectsBucket.insert({ name: 'Demo', taskCount: 4 });
const pid = project.id as string;
await tasksBucket.insert({ projectId: pid, title: 'Task A', status: 'todo', priority: 1 });
await tasksBucket.insert({ projectId: pid, title: 'Task B', status: 'todo', priority: 2 });
await tasksBucket.insert({ projectId: pid, title: 'Task C', status: 'in_progress', priority: 1 });
await tasksBucket.insert({ projectId: pid, title: 'Task D', status: 'in_progress', priority: 3 });
```

Napište následující:

1. Funkci `bulkUpdateStatus(projectId: string, fromStatus: string, toStatus: string)`, která pomocí **transakce** atomicky aktualizuje všechny úlohy v projektu z jednoho stavu do druhého. Vraťte počet aktualizovaných úloh.
2. Reaktivní dotaz `'statusCounts'`, který přijímá `{ projectId: string }` a vrací `{ todo: number, inProgress: number, done: number }`.
3. Přihlaste se k odběru dotazu, zavolejte `bulkUpdateStatus` pro přesun všech `todo` úloh do `in_progress` a ověřte, že se reaktivní callback spustí se správnými počty.

<details>
<summary>Řešení</summary>

```typescript
// 1. Bulk update function
async function bulkUpdateStatus(
  pId: string,
  fromStatus: string,
  toStatus: string,
): Promise<number> {
  return await store.transaction(async (tx) => {
    const txTasks = await tx.bucket('tasks');

    const matching = await txTasks.where({ projectId: pId, status: fromStatus });

    for (const task of matching) {
      await txTasks.update(task.id as string, { status: toStatus });
    }

    return matching.length;
  });
}

// 2. Reactive query
store.defineQuery('statusCounts', async (ctx, params: { projectId: string }) => {
  const tb = ctx.bucket('tasks');
  const all = await tb.where({ projectId: params.projectId });

  return {
    todo: all.filter((t) => t.status === 'todo').length,
    inProgress: all.filter((t) => t.status === 'in_progress').length,
    done: all.filter((t) => t.status === 'done').length,
  };
});

// 3. Subscribe and test
const initial = await store.runQuery<{
  todo: number; inProgress: number; done: number;
}>('statusCounts', { projectId: pid });

console.log('Before:', initial);
// Before: { todo: 2, inProgress: 2, done: 0 }

const unsub = await store.subscribe<{
  todo: number; inProgress: number; done: number;
}>('statusCounts', { projectId: pid }, (counts) => {
  console.log('Live update:', counts);
});

const updated = await bulkUpdateStatus(pid, 'todo', 'in_progress');
console.log(`Updated ${updated} tasks`);
// Updated 2 tasks

await store.settle();
// Live update: { todo: 0, inProgress: 4, done: 0 }

await unsub();
await store.stop();
```

</details>

## Shrnutí

- **Návrh schémat** s denormalizovanými čítači (`taskCount`) zamezuje nákladným průchodům pro jednoduché agregace
- **Indexy** na polích s vysokou kardinalitou (`projectId`, `status`, `priority`, `tag`) udržují dotazy rychlé
- **Transakce** zajišťují konzistenci, když operace zasahují více bucketů -- vytváření/mazání úloh s aktualizací čítačů, přesuny úloh mezi projekty
- **`where()`** s více poli provádí filtrování pomocí AND nad indexovanými poli
- **`paginate()`** s kurzorovou paginací načítá data postupně pro rozsáhlé seznamy
- **`defineQuery()` + `subscribe()`** tvoří živé dashboardy, které se automaticky aktualizují při jakékoli změně dat
- **`store.settle()`** zajišťuje, že reaktivní callbacky byly spuštěny před čtením výsledků -- nezbytné pro deterministické chování
- **`Math.max(0, count - 1)`** je defenzivní vzor pro denormalizované čítače zabraňující záporným hodnotám
- **Přirozené klíče** (jako `name` štítku) eliminují potřebu generovaných identifikátorů, když doména poskytuje unikátní hodnotu

---

Další: [Real-time analytika](./02-realtime-analytika.md)
