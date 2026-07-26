/**
 * Project Registry
 *
 * Maps a project key a goal can declare as its target to the real
 * filesystem root a worker's HarnessContext.allowedEditRoot should be
 * confined to, and whether that root is writable.
 *
 * 14 entries are dedicated git worktrees (branch `automaton/companion`) —
 * writable. The 3 `AIP/*` sub-portfolio entries point at their real path
 * directly and have no worktree yet (see STRATEGIC_PLAN.md §4's "Stage 1
 * build-log correction": AIP is not one repo, and the sub-portfolio folders
 * themselves have no git history) — goals may read and analyze them, but
 * write-capable harness tools must refuse to mutate them. Enforcement lives
 * in agent/policy-rules/project-access.ts, parallel to how path-protection.ts
 * enforces per-file rules.
 */

import path from "node:path";

export interface ProjectRegistryEntry {
  readonly key: string;
  readonly root: string;
  readonly writable: boolean;
}

const RAW_ENTRIES: ReadonlyArray<{ key: string; root: string; writable: boolean }> = [
  { key: "ArchAngel", root: "/Volumes/DevWorkspace/Automaton/worktrees/ArchAngel", writable: true },
  { key: "Oracle", root: "/Volumes/DevWorkspace/Automaton/worktrees/Oracle", writable: true },
  { key: "FTM", root: "/Volumes/DevWorkspace/Automaton/worktrees/FTM", writable: true },
  { key: "Norport.Energy", root: "/Volumes/DevWorkspace/Automaton/worktrees/Norport.Energy", writable: true },
  { key: "AIM", root: "/Volumes/DevWorkspace/Automaton/worktrees/AIM", writable: true },
  { key: "faafo", root: "/Volumes/DevWorkspace/Automaton/worktrees/faafo", writable: true },
  { key: "SSD", root: "/Volumes/DevWorkspace/Automaton/worktrees/SSD", writable: true },
  { key: "BigIdeas", root: "/Volumes/DevWorkspace/Automaton/worktrees/BigIdeas", writable: true },
  { key: "ideation", root: "/Volumes/DevWorkspace/Automaton/worktrees/ideation", writable: true },
  { key: "ClientsSearch", root: "/Volumes/DevWorkspace/Automaton/worktrees/ClientsSearch", writable: true },
  { key: "marketingskills", root: "/Volumes/DevWorkspace/Automaton/worktrees/marketingskills", writable: true },
  { key: "awesome-llm-apps", root: "/Volumes/DevWorkspace/Automaton/worktrees/awesome-llm-apps", writable: true },
  { key: "strix", root: "/Volumes/DevWorkspace/Automaton/worktrees/strix", writable: true },
  { key: "ProductSearch", root: "/Volumes/DevWorkspace/Automaton/worktrees/ProductSearch", writable: true },
  { key: "AIP/ABANDONED-OSS", root: "/Volumes/DevWorkspace/AIP/ABANDONED-OSS", writable: false },
  { key: "AIP/EMBEDDED", root: "/Volumes/DevWorkspace/AIP/EMBEDDED", writable: false },
  { key: "AIP/RELIABILITY", root: "/Volumes/DevWorkspace/AIP/RELIABILITY", writable: false },
];

export const PROJECT_REGISTRY: ReadonlyArray<ProjectRegistryEntry> = RAW_ENTRIES.map((entry) => ({
  key: entry.key,
  root: path.resolve(entry.root),
  writable: entry.writable,
}));

const BY_KEY = new Map<string, ProjectRegistryEntry>(PROJECT_REGISTRY.map((entry) => [entry.key, entry]));
const BY_ROOT = new Map<string, ProjectRegistryEntry>(PROJECT_REGISTRY.map((entry) => [entry.root, entry]));

export function getProjectRegistryEntry(key: string): ProjectRegistryEntry | undefined {
  return BY_KEY.get(key);
}

export function isKnownProjectKey(key: string): boolean {
  return BY_KEY.has(key);
}

export function listProjectKeys(): string[] {
  return PROJECT_REGISTRY.map((entry) => entry.key);
}

/**
 * True when `root` is a registered project that is writable, OR when `root`
 * is not in the registry at all (legacy/self-edit mode — e.g. the automaton
 * editing its own repo — which this registry does not govern). Only a root
 * that is explicitly registered read-only returns false.
 */
export function isProjectRootWritable(root: string): boolean {
  const entry = BY_ROOT.get(path.resolve(root));
  return entry ? entry.writable : true;
}

/**
 * Resolve a goal's declared target project to a worker's confinement root.
 *
 * `targetProject` null/undefined falls back to `fallbackRoot` (the
 * automaton's own repo, preserving pre-registry self-edit behavior) and is
 * always writable. A non-null value must be a registered key — goal
 * creation is expected to validate this up front (see task-graph.ts's
 * createGoal), so an unknown key reaching here throws rather than silently
 * falling back: silently widening or narrowing a goal's confinement root
 * would be a security bug, not a usability nicety.
 */
export function resolveAllowedEditRoot(
  targetProject: string | null | undefined,
  fallbackRoot: string,
): { root: string; writable: boolean } {
  if (!targetProject) {
    return { root: path.resolve(fallbackRoot), writable: true };
  }

  const entry = getProjectRegistryEntry(targetProject);
  if (!entry) {
    throw new Error(`Unknown target project "${targetProject}" — not in the project registry`);
  }

  return { root: entry.root, writable: entry.writable };
}
