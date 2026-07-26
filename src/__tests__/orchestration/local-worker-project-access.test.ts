/**
 * Read-Only Project Enforcement Tests
 *
 * Verifies that HarnessContext.projectWritable actually gates the
 * write-capable harness tools (write_file, patch_file, exec) in both
 * CodingHarness and GeneralHarness — the enforcement point described in
 * STRATEGIC_PLAN.md §4 for the 3 read-only AIP registry entries. Read
 * access (read_file, list_dir) must remain unaffected.
 *
 * Mirrors the existing local-worker-security.test.ts pattern: a manually
 * constructed HarnessContext against a temp directory, no real project
 * paths touched.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodingHarness } from "../../agent/harnesses/coding-harness.js";
import { GeneralHarness } from "../../agent/harnesses/general-harness.js";
import type { HarnessContext } from "../../agent/harness-types.js";
import type { ConwayClient } from "../../types.js";
import { AgentWorkspace } from "../../orchestration/workspace.js";
import { createInMemoryDb } from "./test-db.js";
import { createTestConfig, createTestIdentity, MockConwayClient } from "../mocks.js";

describe("read-only project enforcement (write_file / patch_file / exec)", () => {
  let db: ReturnType<typeof createInMemoryDb>;
  let testRoot: string;

  beforeEach(() => {
    db = createInMemoryDb();
    testRoot = mkdtempSync(path.join(process.cwd(), ".tmp-project-access-"));
  });

  afterEach(() => {
    db.close();
    rmSync(testRoot, { recursive: true, force: true });
  });

  async function createHarness<H extends CodingHarness | GeneralHarness>(
    HarnessCtor: new () => H,
    projectWritable: boolean | undefined,
    conway: ConwayClient = new MockConwayClient(),
  ): Promise<H> {
    const harness = new HarnessCtor();
    const workspace = new AgentWorkspace("goal-test", path.join(testRoot, "workspace"));
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot: testRoot,
      workspace,
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway,
      inference: { chat: async () => ({ content: "done" }) },
      budget: {
        maxTurns: 5,
        maxCostCents: 50,
        timeoutMs: 5_000,
        turnsUsed: 0,
        costUsedCents: 0,
        startedAt: 0,
      },
      wisdom: { conventions: [], successes: [], failures: [], gotchas: [] },
      abortSignal: new AbortController().signal,
      goalId: "goal-test",
      projectWritable,
    };

    await harness.initialize(
      {
        id: "task-1",
        parentId: null,
        goalId: "goal-test",
        title: "Read-only project triage",
        description: "Analyze without writing",
        status: "assigned",
        assignedTo: "local://worker",
        agentRole: "executor",
        priority: 50,
        dependencies: [],
        result: null,
        metadata: {
          estimatedCostCents: 5,
          actualCostCents: 0,
          maxRetries: 0,
          retryCount: 0,
          timeoutMs: 5_000,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
        },
      },
      context,
    );

    return harness;
  }

  async function runTool<H extends CodingHarness | GeneralHarness>(
    HarnessCtor: new () => H,
    projectWritable: boolean | undefined,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const harness = await createHarness(HarnessCtor, projectWritable);
    const tool = harness.getToolDefs().find((entry) => entry.name === toolName);
    if (!tool) throw new Error(`missing tool: ${toolName}`);
    return tool.execute(args);
  }

  describe("CodingHarness", () => {
    it("blocks write_file when the project is read-only", async () => {
      const out = await runTool(CodingHarness, false, "write_file", {
        path: "notes.md",
        content: "should not land",
      });
      expect(out).toContain("Blocked");
      expect(out.toLowerCase()).toContain("read-only");
    });

    it("blocks patch_file when the project is read-only", async () => {
      const out = await runTool(CodingHarness, false, "patch_file", {
        path: "notes.md",
        search: "x",
        replace: "y",
      });
      expect(out).toContain("Blocked");
    });

    it("blocks exec when the project is read-only", async () => {
      const out = await runTool(CodingHarness, false, "exec", { command: "echo hi" });
      expect(out).toContain("Blocked");
    });

    it("still allows read_file and list_dir when the project is read-only", async () => {
      const readOut = await runTool(CodingHarness, false, "read_file", { path: "." });
      expect(readOut).not.toContain("read-only");
      const listOut = await runTool(CodingHarness, false, "list_dir", { path: "." });
      expect(listOut).not.toContain("Blocked");
    });

    it("allows write_file inside its own root when the project is writable", async () => {
      const filePath = path.join(testRoot, "out.txt");
      const conway = new MockConwayClient();
      const harness = await createHarness(CodingHarness, true, conway);
      const tool = harness.getToolDefs().find((entry) => entry.name === "write_file")!;
      const out = await tool.execute({ path: filePath, content: "ok" });
      expect(out).toContain("Wrote 2 bytes");
    });

    it("still blocks writes outside the allowed root even when the project is writable", async () => {
      const out = await runTool(CodingHarness, true, "write_file", {
        path: "../../outside.txt",
        content: "x",
      });
      expect(out).toContain("Blocked: path");
      expect(out).toContain("outside workspace");
    });

    it("defaults to writable when projectWritable is undefined (legacy self-edit mode)", async () => {
      const filePath = path.join(testRoot, "legacy.txt");
      const conway = new MockConwayClient();
      const harness = await createHarness(CodingHarness, undefined, conway);
      const tool = harness.getToolDefs().find((entry) => entry.name === "write_file")!;
      const out = await tool.execute({ path: filePath, content: "ok" });
      expect(out).toContain("Wrote 2 bytes");
    });
  });

  describe("GeneralHarness", () => {
    it("blocks write_file when the project is read-only", async () => {
      const out = await runTool(GeneralHarness, false, "write_file", {
        path: "notes.md",
        content: "should not land",
      });
      expect(out).toContain("Blocked");
      expect(out.toLowerCase()).toContain("read-only");
    });

    it("blocks exec when the project is read-only", async () => {
      const out = await runTool(GeneralHarness, false, "exec", { command: "echo hi" });
      expect(out).toContain("Blocked");
    });

    it("still allows read_file when the project is read-only", async () => {
      const out = await runTool(GeneralHarness, false, "read_file", { path: "." });
      expect(out.toLowerCase()).not.toContain("read-only");
    });

    it("allows write_file inside its own root when the project is writable", async () => {
      const filePath = path.join(testRoot, "general-out.txt");
      const conway = new MockConwayClient();
      const harness = await createHarness(GeneralHarness, true, conway);
      const tool = harness.getToolDefs().find((entry) => entry.name === "write_file")!;
      const out = await tool.execute({ path: filePath, content: "ok" });
      expect(out).toContain("Wrote 2 bytes");
    });
  });
});
