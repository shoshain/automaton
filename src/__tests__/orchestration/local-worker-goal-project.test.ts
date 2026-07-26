/**
 * LocalWorkerPool per-goal allowedEditRoot resolution
 *
 * Verifies runWorker() resolves HarnessContext.allowedEditRoot and
 * .projectWritable from the goal's declared target_project (via the
 * project registry) rather than always using the pool-wide default —
 * the core fix for STRATEGIC_PLAN.md §4 ("allowedEditRoot ... hardcoded
 * to process.cwd() ... needs real engineering").
 *
 * Uses MockConwayClient, so even though real registry paths are used for
 * ArchAngel / AIP entries below, no file I/O ever touches them — writeFile
 * and readFile are fully in-memory stubs (see mocks.ts).
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HarnessRegistry } from "../../agent/harness-registry.js";
import type { AgentHarness, HarnessContext, HarnessTool } from "../../agent/harness-types.js";
import { LocalWorkerPool } from "../../orchestration/local-worker.js";
import { createGoal } from "../../orchestration/task-graph.js";
import type { TaskNode, TaskResult } from "../../orchestration/task-graph.js";
import { getTaskById } from "../../state/database.js";
import { createInMemoryDb } from "./test-db.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";

class CapturingHarness implements AgentHarness {
  readonly id = "capturing";
  readonly description = "captures the resolved HarnessContext";
  static capturedContext: HarnessContext | null = null;

  async initialize(_task: TaskNode, context: HarnessContext): Promise<void> {
    CapturingHarness.capturedContext = context;
  }

  async execute(): Promise<TaskResult> {
    return { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };
  }

  getToolDefs(): HarnessTool[] {
    return [];
  }

  buildSystemPrompt(): string {
    return "";
  }

  buildTaskPrompt(): string {
    return "";
  }
}

/**
 * Inserts a task_graph row and returns it as a full TaskNode, mirroring the
 * row -> TaskNode mapping local to task-graph.ts (not exported from there,
 * so replicated here — same approach as local-worker-harness.test.ts).
 */
function insertCapturingTask(db: ReturnType<typeof createInMemoryDb>, goalId: string, id: string): TaskNode {
  db.prepare(
    `INSERT INTO task_graph (
      id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, max_retries, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    goalId,
    "Task",
    "Task description",
    "assigned",
    "local://worker-test",
    "capturing-role",
    50,
    JSON.stringify([]),
    0,
    new Date().toISOString(),
  );

  const row = getTaskById(db, id);
  if (!row) {
    throw new Error(`Failed to load task ${id}`);
  }

  return {
    id: row.id,
    parentId: row.parentId,
    goalId: row.goalId,
    title: row.title,
    description: row.description,
    status: row.status,
    assignedTo: row.assignedTo,
    agentRole: row.agentRole,
    priority: row.priority,
    dependencies: row.dependencies,
    result: row.result as TaskResult | null,
    metadata: {
      estimatedCostCents: row.estimatedCostCents,
      actualCostCents: row.actualCostCents,
      maxRetries: row.maxRetries,
      retryCount: row.retryCount,
      timeoutMs: row.timeoutMs,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
    },
  };
}

describe("orchestration/LocalWorkerPool per-goal target project resolution", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let registry: HarnessRegistry;

  beforeEach(() => {
    db = createInMemoryDb();
    registry = new HarnessRegistry();
    registry.register("capturing-role", CapturingHarness);
    CapturingHarness.capturedContext = null;
  });

  afterEach(() => {
    db.close();
  });

  function createPool(): LocalWorkerPool {
    return new LocalWorkerPool({
      db,
      conway: new MockConwayClient(),
      inference: { chat: async () => ({ content: "done" }) },
      harnessRegistry: registry,
      identity: createTestIdentity(),
      config: createTestConfig(),
      allowedEditRoot: process.cwd(),
    });
  }

  it("resolves allowedEditRoot to the automaton's own repo when the goal has no target project", async () => {
    const goal = createGoal(db, "Self-edit goal", "No target project declared");
    const task = insertCapturingTask(db, goal.id, "task-self-edit");

    const pool = createPool();
    await (pool as any).runWorker("worker-test", task, new AbortController().signal);

    expect(CapturingHarness.capturedContext?.allowedEditRoot).toBe(path.resolve(process.cwd()));
    expect(CapturingHarness.capturedContext?.projectWritable).toBe(true);
  });

  it("confines a goal targeting a writable project to that project's registry root", async () => {
    const goal = createGoal(db, "ArchAngel readiness", "Assess launch readiness", undefined, "ArchAngel");
    const task = insertCapturingTask(db, goal.id, "task-archangel");

    const pool = createPool();
    await (pool as any).runWorker("worker-test", task, new AbortController().signal);

    expect(CapturingHarness.capturedContext?.allowedEditRoot).toBe(
      path.resolve("/Volumes/DevWorkspace/Automaton/worktrees/ArchAngel"),
    );
    expect(CapturingHarness.capturedContext?.projectWritable).toBe(true);
  });

  it("confines a goal targeting a read-only AIP project and marks it non-writable", async () => {
    const goal = createGoal(db, "EMBEDDED triage", "Build-readiness assessment", undefined, "AIP/EMBEDDED");
    const task = insertCapturingTask(db, goal.id, "task-embedded");

    const pool = createPool();
    await (pool as any).runWorker("worker-test", task, new AbortController().signal);

    expect(CapturingHarness.capturedContext?.allowedEditRoot).toBe(
      path.resolve("/Volumes/DevWorkspace/AIP/EMBEDDED"),
    );
    expect(CapturingHarness.capturedContext?.projectWritable).toBe(false);
  });
});
