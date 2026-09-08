// SPDX-License-Identifier: MPL-2.0
/** Stop at the first failed command; never count an unstarted check as passed. */
export function runChecks(checks, execute, save) {
  const results = checks.map((check) => ({ ...check, status: "not-run" }));
  save(results);
  for (const result of results) {
    result.status = "running";
    const started = Date.now();
    save(results);
    let outcome;
    try {
      outcome = execute(result);
    } catch (error) {
      outcome = { error };
    }
    result.durationMs = Date.now() - started;
    result.exitCode = outcome.status ?? null;
    result.signal = outcome.signal ?? null;
    result.error = outcome.error ? String(outcome.error) : null;
    result.status =
      result.exitCode === 0 && !result.signal && !result.error
        ? "passed"
        : "failed";
    save(results);
    if (result.status === "failed") break;
  }
  return results.every((result) => result.status === "passed");
}
