# Task Management

You have learned schemas, CRUD, indexes, reactive queries, transactions, and pagination as separate concepts. Now you will combine them into a single cohesive application — a task management system with projects, tasks, and tags. This chapter walks through the full design: from schema modeling to paginated lists, live dashboards, and atomic cross-bucket operations.

By the end, you will have a runnable project that exercises every core feature of noex-store in a realistic scenario.

## What You'll Learn

- How to model related entities (projects, tasks, tags) with schemas and indexes
- How to perform CRUD operations across multiple buckets
- How to query and paginate task lists efficiently with secondary indexes
- How to build a live dashboard with reactive queries
- How to use transactions for atomic cross-bucket operations
- How to combine all core features into a production-style application

## Schema Design

A task management system needs three entity types: projects that group tasks, tasks that belong to projects, and tags for classification. Start with the schema design — the foundation everything else builds on.

### Projects

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

Key decisions:

- **`taskCount`** is a denormalized counter. Maintaining it inside transactions avoids scanning all tasks just to display a count next to each project name.
- **`status` index** enables fast filtering of active vs archived projects.
- **`minLength: 1`** prevents empty project names at the schema level.

### Tasks

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

Key decisions:

- **`projectId` index** is critical — every query for "tasks in project X" hits this index instead of scanning.
- **`priority` as numbers** (1 = critical, 4 = low) enables numeric comparisons when sorting application-side.
- **Four indexes** cover the most common query patterns: by project, by status, by priority, and by tag.
- **`cuid` key** provides globally unique, sortable identifiers.

### Tags

```typescript
await store.defineBucket('tags', {
  key: 'name',
  schema: {
    name:  { type: 'string', required: true, minLength: 1, maxLength: 30 },
    color: { type: 'string', required: true, pattern: '^#[0-9a-fA-F]{6}$' },
  },
});
```

Tags use the `name` as the natural key — no generated ID needed. The `color` pattern enforces hex color codes at the schema level.

### Entity Relationship

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

## Bucket Handles

After defining all buckets, grab handles for the rest of the application:

```typescript
const projects = store.bucket('projects');
const tasks = store.bucket('tasks');
const tags = store.bucket('tags');
```

## Seeding Data

Populate the store with initial data to work with:

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

The transaction guarantees the project and its tasks are created together. If any insert fails (e.g., validation error), none of them persist.

## CRUD Operations

### Creating a Task

Every task creation must update the project's `taskCount`. Use a transaction to keep them in sync:

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

### Updating a Task

Status transitions are simple updates. The schema's `enum` constraint prevents invalid statuses:

```typescript
async function updateTaskStatus(taskId: string, status: string) {
  return await tasks.update(taskId, { status });
}

await updateTaskStatus(newTask.id as string, 'in_progress');
```

If you pass an invalid status like `'cancelled'`, the schema validator throws a `ValidationError`.

### Deleting a Task

Deletion mirrors creation — decrement the project counter atomically:

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

`Math.max(0, ...)` is a safety net against negative counts — defensive code for a denormalized counter.

## Querying Tasks

### Filter by Project

The `projectId` index makes this an indexed lookup:

```typescript
const projectTasks = await tasks.where({ projectId });
console.log(`Tasks in project: ${projectTasks.length}`);
// Tasks in project: 6
```

### Filter by Status

```typescript
const todoTasks = await tasks.where({ status: 'todo' });
console.log(`Todo: ${todoTasks.length}`);
// Todo: 2

const inProgress = await tasks.where({ status: 'in_progress' });
console.log(`In progress: ${inProgress.length}`);
// In progress: 3
```

### Combined Filters

`where()` accepts multiple fields — all conditions are AND-ed:

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

### Counting

```typescript
const totalTasks = await tasks.count();
const doneTasks = await tasks.count({ status: 'done' });
console.log(`Progress: ${doneTasks}/${totalTasks} completed`);
// Progress: 1/6 completed
```

## Pagination

For large task lists, load tasks page by page using cursor-based pagination:

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

## Reactive Dashboard

Build a live dashboard that updates automatically when tasks change. Reactive queries eliminate polling — the callback fires whenever the underlying data changes.

### Define Queries

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

### Subscribe to Live Updates

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

### Trigger Updates

Now any mutation automatically pushes fresh data to subscribers:

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

`store.settle()` ensures all reactive query callbacks have fired before the next `console.log` — essential for deterministic output in examples.

## Transactions: Moving Tasks Between Projects

Moving a task from one project to another requires updating three things atomically: the task's `projectId`, the source project's `taskCount`, and the target project's `taskCount`. Without a transaction, a failure partway through leaves the counts inconsistent.

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

All six operations succeed or none do. The denormalized counters stay consistent regardless of crashes, validation errors, or concurrent access.

### Test It

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

## Complete Working Example

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

## Exercise

Build a "bulk status update" feature. Given the following store:

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

Write the following:

1. A function `bulkUpdateStatus(projectId: string, fromStatus: string, toStatus: string)` that uses a **transaction** to atomically update all tasks in a project from one status to another. Return the number of tasks updated.
2. A reactive query `'statusCounts'` that takes `{ projectId: string }` and returns `{ todo: number, inProgress: number, done: number }`.
3. Subscribe to the query, call `bulkUpdateStatus` to move all `todo` tasks to `in_progress`, and verify the reactive callback fires with the correct counts.

<details>
<summary>Solution</summary>

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

## Summary

- **Schema design** with denormalized counters (`taskCount`) avoids expensive scans for simple aggregates
- **Indexes** on high-cardinality filter fields (`projectId`, `status`, `priority`, `tag`) keep queries fast
- **Transactions** maintain consistency when operations span multiple buckets — create/delete tasks with counter updates, move tasks between projects
- **`where()`** with multiple fields performs AND-ed filtering against indexed fields
- **`paginate()`** with cursor-based pagination loads data incrementally for large lists
- **`defineQuery()` + `subscribe()`** build live dashboards that update automatically on any data change
- **`store.settle()`** ensures reactive callbacks have fired before reading results — essential for deterministic behavior
- **`Math.max(0, count - 1)`** is a defensive pattern for denormalized counters to prevent negative values
- **Natural keys** (like tag `name`) eliminate the need for generated identifiers when the domain provides a unique value

## API Reference

- [Store API](../../reference/store.md) — store setup and lifecycle
- [BucketHandle API](../../reference/bucket-handle.md) — CRUD, filtering, pagination
- [Reactive Queries](../../reference/reactive-queries.md) — `defineQuery()` and `subscribe()`

---

Next: [Real-Time Analytics](./02-realtime-analytics.md)
