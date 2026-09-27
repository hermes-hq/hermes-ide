// Reads GitHub check runs and says whether a named check (the CI `gate`,
// which includes the real-app scenarios and the acceptance ledger) passed on
// a commit. Pure: the release gate (../release-gate.mjs) fetches the runs and
// decides what to do with the answer.

/**
 * Which run of `name` counts: the newest one, so a re-run replaces an
 * earlier verdict. Returns null when the commit has no run of that name.
 */
export function latestCheckRun(checkRuns, name) {
  const runs = (checkRuns ?? []).filter((r) => r && r.name === name);
  if (runs.length === 0) return null;
  const when = (r) => Date.parse(r.started_at ?? "") || 0;
  return runs.reduce((best, r) => (when(r) > when(best) || (when(r) === when(best) && (r.id ?? 0) > (best.id ?? 0)) ? r : best));
}

/**
 * The state of the named check on a commit:
 *   { state: "success" }                 it completed and passed
 *   { state: "pending", detail }         queued or running — ask again later
 *   { state: "failure", detail }         completed with anything but success
 *   { state: "missing", detail }         the commit has no run of that name
 * Only "success" lets a release go ahead; skipped, cancelled, neutral and
 * stale runs do not count as proof.
 */
export function requiredCheckState(checkRuns, name) {
  const run = latestCheckRun(checkRuns, name);
  if (!run) return { state: "missing", detail: `no check run named "${name}" on this commit` };
  if (run.status !== "completed") {
    return { state: "pending", detail: `"${name}" is ${run.status}${run.html_url ? ` (${run.html_url})` : ""}` };
  }
  if (run.conclusion === "success") return { state: "success", detail: `"${name}" passed${run.html_url ? ` (${run.html_url})` : ""}` };
  return {
    state: "failure",
    detail: `"${name}" finished with conclusion "${run.conclusion}"${run.html_url ? ` (${run.html_url})` : ""}`,
  };
}

/**
 * Poll `fetchCheckRuns()` until the named check is no longer pending or the
 * deadline passes. `sleep` and `now` are injectable for tests.
 */
export async function waitForRequiredCheck(
  fetchCheckRuns,
  name,
  { timeoutMs = 60 * 60_000, intervalMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = () => {} } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = requiredCheckState(await fetchCheckRuns(), name);
    if (result.state !== "pending") return result;
    if (now() >= deadline) return { state: "failure", detail: `${result.detail}; gave up waiting after ${Math.round(timeoutMs / 60_000)} min` };
    log(`waiting: ${result.detail}`);
    await sleep(intervalMs);
  }
}
