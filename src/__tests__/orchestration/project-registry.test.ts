/**
 * Project Registry Tests
 *
 * Covers:
 * - The 17-entry registry shape (14 writable worktrees, 3 read-only AIP paths)
 * - resolveAllowedEditRoot: fallback for goals with no target project,
 *   resolution of writable/read-only entries, and rejection of unknown keys
 * - isProjectRootWritable reverse lookup
 * - createGoal() rejecting an unregistered target_project at creation time
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROJECT_REGISTRY,
  getProjectRegistryEntry,
  isKnownProjectKey,
  isProjectRootWritable,
  listProjectKeys,
  resolveAllowedEditRoot,
} from "../../orchestration/project-registry.js";
import { createGoal } from "../../orchestration/task-graph.js";
import { getGoalById } from "../../state/database.js";
import { createInMemoryDb } from "./test-db.js";

const WRITABLE_KEYS = [
  "ArchAngel", "Oracle", "FTM", "Norport.Energy", "AIM", "faafo", "SSD",
  "BigIdeas", "ideation", "ClientsSearch", "marketingskills",
  "awesome-llm-apps", "strix", "ProductSearch",
];
const READ_ONLY_KEYS = ["AIP/ABANDONED-OSS", "AIP/EMBEDDED", "AIP/RELIABILITY"];

describe("orchestration/project-registry", () => {
  it("has exactly 17 entries", () => {
    expect(PROJECT_REGISTRY).toHaveLength(17);
  });

  it("marks all 14 worktree entries writable", () => {
    for (const key of WRITABLE_KEYS) {
      expect(getProjectRegistryEntry(key)?.writable).toBe(true);
    }
  });

  it("marks all 3 AIP sub-portfolio entries read-only", () => {
    for (const key of READ_ONLY_KEYS) {
      expect(getProjectRegistryEntry(key)?.writable).toBe(false);
    }
  });

  it("resolves each entry's root to the exact expected absolute path", () => {
    expect(getProjectRegistryEntry("ArchAngel")?.root).toBe(
      path.resolve("/Volumes/DevWorkspace/Automaton/worktrees/ArchAngel"),
    );
    expect(getProjectRegistryEntry("AIP/EMBEDDED")?.root).toBe(
      path.resolve("/Volumes/DevWorkspace/AIP/EMBEDDED"),
    );
  });

  it("isKnownProjectKey is true only for registered keys", () => {
    expect(isKnownProjectKey("ArchAngel")).toBe(true);
    expect(isKnownProjectKey("AIP/EMBEDDED")).toBe(true);
    expect(isKnownProjectKey("not-a-real-project")).toBe(false);
  });

  it("listProjectKeys returns all 17 keys", () => {
    expect(listProjectKeys().sort()).toEqual(
      [...WRITABLE_KEYS, ...READ_ONLY_KEYS].sort(),
    );
  });

  describe("resolveAllowedEditRoot", () => {
    it("falls back to the given root with writable=true when no target project is declared", () => {
      const result = resolveAllowedEditRoot(null, "/tmp/self-edit-root");
      expect(result).toEqual({ root: path.resolve("/tmp/self-edit-root"), writable: true });
    });

    it("falls back for undefined the same as null", () => {
      const result = resolveAllowedEditRoot(undefined, "/tmp/self-edit-root");
      expect(result.writable).toBe(true);
    });

    it("resolves a writable project to its registry root", () => {
      const result = resolveAllowedEditRoot("ArchAngel", "/tmp/unused");
      expect(result).toEqual({
        root: path.resolve("/Volumes/DevWorkspace/Automaton/worktrees/ArchAngel"),
        writable: true,
      });
    });

    it("resolves a read-only project to its real path with writable=false", () => {
      const result = resolveAllowedEditRoot("AIP/RELIABILITY", "/tmp/unused");
      expect(result).toEqual({
        root: path.resolve("/Volumes/DevWorkspace/AIP/RELIABILITY"),
        writable: false,
      });
    });

    it("throws for an unknown target project", () => {
      expect(() => resolveAllowedEditRoot("totally-unregistered", "/tmp/unused")).toThrow(
        /Unknown target project/,
      );
    });
  });

  describe("isProjectRootWritable", () => {
    it("returns true for a writable registered root", () => {
      expect(isProjectRootWritable("/Volumes/DevWorkspace/Automaton/worktrees/Oracle")).toBe(true);
    });

    it("returns false for a read-only registered root", () => {
      expect(isProjectRootWritable("/Volumes/DevWorkspace/AIP/ABANDONED-OSS")).toBe(false);
    });

    it("defaults to true for a root outside the registry (legacy self-edit mode)", () => {
      expect(isProjectRootWritable("/some/unrelated/path")).toBe(true);
    });
  });
});

describe("createGoal target project validation", () => {
  it("rejects an unregistered target_project at goal-creation time", () => {
    const db = createInMemoryDb();
    try {
      expect(() =>
        createGoal(db, "Goal title", "Goal description", undefined, "not-a-real-project"),
      ).toThrow(/Unknown target project/);
    } finally {
      db.close();
    }
  });

  it("persists a valid target_project and round-trips it through getGoalById", () => {
    const db = createInMemoryDb();
    try {
      const goal = createGoal(db, "Assess ArchAngel readiness", "Read-only triage", undefined, "ArchAngel");
      expect(goal.targetProject).toBe("ArchAngel");

      const row = getGoalById(db, goal.id);
      expect(row?.targetProject).toBe("ArchAngel");
    } finally {
      db.close();
    }
  });

  it("leaves target_project null when the goal does not declare one (self-edit mode)", () => {
    const db = createInMemoryDb();
    try {
      const goal = createGoal(db, "Self-edit goal", "No target project declared");
      expect(goal.targetProject).toBeNull();
    } finally {
      db.close();
    }
  });
});
