/**
 * Project Write-Access Guard
 *
 * Parallels path-protection.ts: harness-local tools (write_file, patch_file,
 * exec in coding-harness.ts / general-harness.ts) call this directly, the
 * same way they already call isProtectedFile()/isSensitiveFile() — these
 * tools execute outside PolicyEngine.evaluate(), so enforcement happens
 * inline at the harness layer rather than as a registered PolicyRule.
 *
 * `projectWritable` on HarnessContext is resolved once per worker by
 * LocalWorkerPool from the goal's declared target project (see
 * orchestration/project-registry.ts). `undefined` means no project registry
 * was involved (e.g. the automaton editing its own repo) and defaults to
 * writable, preserving pre-registry behavior.
 */

export function isProjectReadOnly(projectWritable: boolean | undefined): boolean {
  return projectWritable === false;
}
