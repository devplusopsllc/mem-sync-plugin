import { deleteFromClaudeMem } from "../../shared/src/claudeMemDelete";
import type { GitContext } from "../../shared/src/git";
import { ClaudeMemPartialImportError, ClaudeMemRejectedError, type ClaudeMemApi } from "../../shared/src/claudeMemApi";
import { keyFor, toRecord } from "../../shared/src/keys";
import { stripPrompt, toImportBody, withProject } from "../../shared/src/rename";
import type { ObservationRow, SessionRow, SummaryRow, SyncRecord } from "../../shared/src/types";
import type { ClaudeMemReader, SchemaCheck } from "./claudeMemDb";
import { HubUnreachable, SignInNeeded } from "./cloudflared";
import { HubError, type HubClient, type MappingView } from "./hubClient";
import type { HubLedger } from "./ledger";
import { resetPushState } from "./resend";

export const STALE_SESSION_MS = 60 * 60_000;
const MAX_PENDING_ATTEMPTS = 5;
/** How long a note the hub rejected for a missing parent session is re-sent before giving up on it. */
export const PUSH_RETRY_GIVE_UP_MS = 7 * 24 * 60 * 60_000;
const PARENT_MISSING = "parent session not on hub";
const LOCAL_DOWN_MSG = "local claude-mem isn't running; teammates' notes will be imported when it is back";

/** Local claude-mem could not be reached (not an HTTP error response). Never counts toward quarantine. */
class LocalDown extends Error {}

/** An HTTP error response from claude-mem, as opposed to a network failure or timeout. */
const isHttpFailure = (e: unknown) => /returned \d{3}/.test(e instanceof Error ? e.message : String(e));

export interface SyncDeps {
  hub: Pick<HubClient, "myMappings" | "push" | "pull"> & Partial<Pick<HubClient, "setNeverSync" | "features">>;
  mem: Pick<ClaudeMemApi, "importRecords" | "health">;
  reader: Pick<ClaudeMemReader, "checkSchema" | "readSessions" | "readObservations" | "readQuietSummaries" | "findSessionByMemoryId"
    | "readObservationById" | "readSummaryById">;
  claudeMemDbPath: string;
  ledger: HubLedger;
  /** False when the hub that owns a folder (folder_hubs) no longer links it nor keeps it never shared; without it the owner always keeps it. */
  ownerMaps?: (project: string) => Promise<boolean>;
  summaryQuietMs: number;
  /** The git context to attach to a pushed observation or summary; used only when the hub says git_context. */
  gitFor?: (project: string, payload: ObservationRow | SummaryRow) => GitContext | null;
  now?: () => number;
  batchSize?: number;
}

export interface CycleResult {
  /** "need_key" is never produced by runSyncCycle: AuthFlow.runCycle returns it for a skipped cycle. */
  status: "ok" | "paused" | "error" | "revoked" | "signin" | "unreachable" | "need_key";
  pushed: number;
  pulled: number;
  error?: string;
}

export async function runSyncCycle(d: SyncDeps): Promise<CycleResult> {
  const now = d.now ?? Date.now;
  const res: CycleResult = { status: "ok", pushed: 0, pulled: 0 };
  let schema: SchemaCheck;
  try {
    schema = d.reader.checkSchema();
  } catch (e) {
    res.status = "error";
    res.error = `cannot read claude-mem database: ${e instanceof Error ? e.message : String(e)}`;
    return record(d, res, now);
  }
  if (schema.missing.length) {
    res.status = "paused";
    res.error = `claude-mem database is missing ${schema.missing.join(", ")} (schema version ${schema.version ?? "unknown"}); ` +
      "sync paused until mem-sync supports this claude-mem version";
    return record(d, res, now);
  }
  try {
    // "Never share" this hub missed (it was down): apply it first; its folders sync nowhere here until it lands.
    for (const [project, on] of Object.entries(d.ledger.neverPending())) {
      try {
        if (!d.hub.setNeverSync) continue;
        await d.hub.setNeverSync(project, on);
        // Only this entry, and only if no request changed it during the call.
        d.ledger.clearNeverPending(project, on);
      } catch {
        // Kept for the next cycle.
      }
    }
    const pending = d.ledger.neverPending();
    const { mappings } = await d.hub.myMappings();
    const errors: string[] = [];
    const acc: PushAcc = { rejected: [], orphans: 0, gaveUp: 0, quarantined: 0, pulledBeforeError: 0 };
    let gitAsked = !d.gitFor;
    let memDown = false;
    try {
      memDown = !(await d.mem.health());
    } catch {
      memDown = true;
    }
    for (const m of mappings) {
      if (!m.enabled || m.space_archived || m.space_access === false || m.local_project in pending) continue;
      // One folder, one hub: a folder another hub owns is neither pushed nor pulled here.
      if (!d.ledger.claimFolder(m.local_project)) {
        // An owner we can't ask keeps the folder.
        if (!d.ownerMaps || (await d.ownerMaps(m.local_project).catch(() => true))) {
          errors.push(`${m.local_project}: linked on another hub too; unlink it on one`);
          continue;
        }
        // Unlinked on its owner (hub admin, another laptop): the folder moves here and is sent here from the start.
        resetPushState(d.ledger, d.reader, m.local_project);
        d.ledger.claimFolder(m.local_project);
      }
      if (!gitAsked) {
        gitAsked = true;
        // Older hubs would pass git into claude-mem; an error counts as "not supported".
        const ok = (await d.hub.features?.().catch(() => null))?.git_context === true;
        if (!ok) d = { ...d, gitFor: undefined };
      }
      try {
        res.pushed += await retryMapping(d, m, now(), acc);
        res.pushed += await pushMapping(d, m, now(), acc);
        if (!memDown) res.pulled += await pullMapping(d, m, acc);
      } catch (e) {
        // These end the whole cycle: no other mapping can reach the hub either.
        if ((e instanceof HubError && e.status === 401) || e instanceof SignInNeeded || e instanceof HubUnreachable) throw e;
        if (e instanceof LocalDown) {
          memDown = true; // stop pulling for the rest of this cycle; push still runs
          continue;
        }
        errors.push(`${m.local_project}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    res.pulled += acc.pulledBeforeError;
    if (acc.orphans) {
      const prev = Number(d.ledger.status().skipped_orphans ?? 0);
      d.ledger.setStatus("skipped_orphans", String(prev + acc.orphans));
    }
    if (acc.gaveUp) {
      const prev = Number(d.ledger.status().skipped_rejected ?? 0);
      d.ledger.setStatus("skipped_rejected", String(prev + acc.gaveUp));
    }
    if (memDown) errors.unshift(LOCAL_DOWN_MSG);
    if (acc.quarantined) {
      errors.push(`${acc.quarantined} teammate notes could not be imported and were set aside (quarantined_pulls)`);
    }
    if (acc.rejected.length) {
      errors.push(`${acc.rejected.length} records rejected by hub: ${acc.rejected.slice(0, 3).join(", ")}`);
    }
    if (errors.length) {
      res.status = "error";
      res.error = errors.join("; ");
    }
  } catch (e) {
    if (e instanceof SignInNeeded) {
      res.status = "signin";
      res.error = "sign in to the hub again";
    } else if (e instanceof HubUnreachable) {
      res.status = "unreachable";
      res.error = "hub unreachable";
    } else if (e instanceof HubError && e.status === 401) {
      res.status = "revoked";
      res.error = /user is disabled/i.test(e.message)
        ? "your account on the hub is disabled; ask an admin"
        : "the hub rejected this API key (revoked or wrong)";
    } else {
      res.status = "error";
      res.error = e instanceof Error ? e.message : String(e);
    }
  }
  return record(d, res, now);
}

function record(d: SyncDeps, res: CycleResult, now: () => number): CycleResult {
  const t = String(now());
  d.ledger.setStatus("last_cycle_at", t);
  d.ledger.recordStatus(res.status, res.error ?? "", Number(t));
  d.ledger.setStatus("last_pushed", String(res.pushed));
  d.ledger.setStatus("last_pulled", String(res.pulled));
  if (res.status === "ok") d.ledger.setStatus("last_success_at", t);
  return res;
}

interface PushAcc {
  rejected: string[];
  orphans: number;
  /** Held notes the hub still rejected PUSH_RETRY_GIVE_UP_MS after it first rejected them. */
  gaveUp: number;
  quarantined: number;
  /** Pulled records that landed in an import that then failed for other records. */
  pulledBeforeError: number;
}

/** Mappings without space access are skipped before any push or pull, so a name is always present here. */
function spaceName(m: MappingView): string {
  if (m.space_name === null) throw new Error(`mapping for ${m.local_project} has no space name`);
  return m.space_name;
}

/**
 * Pushes records and returns how many the hub accepted or skipped, plus each rejected record's
 * reason by key. With localIds (aligned with records), an observation or summary rejected because
 * its parent session is not on the hub is held in push_retries and re-sent on later cycles.
 */
async function send(
  d: SyncDeps,
  m: MappingView,
  records: SyncRecord[],
  acc: PushAcc,
  localIds?: number[],
): Promise<{ count: number; reasons: Map<string, string> }> {
  for (const rec of records) {
    if (rec.kind === "session" || !d.gitFor) continue;
    let git: GitContext | null = null;
    try {
      git = d.gitFor(m.local_project, rec.payload);
    } catch {
      // Git is optional: a ledger error pushes the note without it.
    }
    if (git) (rec.payload as typeof rec.payload & { git?: GitContext }).git = git;
  }
  const r = await d.hub.push(m.space_id, records);
  acc.rejected.push(...r.rejected);
  const reasons = new Map<string, string>();
  for (const rec of records) {
    const line = r.rejected.find((x) => x.startsWith(`${rec.key}: `));
    if (line !== undefined) reasons.set(rec.key, line.slice(rec.key.length + 2));
  }
  if (localIds) {
    records.forEach((rec, i) => {
      const reason = reasons.get(rec.key);
      if (rec.kind !== "session" && reason?.includes(PARENT_MISSING)) {
        d.ledger.addPushRetry(m.local_project, rec.kind, rec.key, localIds[i], reason, (d.now ?? Date.now)());
      }
    });
  }
  return { count: r.accepted + r.skipped, reasons };
}

/**
 * Sends the local session with this memory id when the session cursor already passed it: it was
 * stale-skipped, or claude-mem gave it a new memory id after it was pushed (the hub then records
 * the new id as an alias of the first). "ok" when the parent is on the hub or on its way, "wait"
 * when the session loop has not reached it yet, "orphan" when no session in this project has the id.
 */
async function ensureParent(
  d: SyncDeps,
  m: MappingView,
  memId: string,
  acc: PushAcc,
): Promise<{ state: "ok" | "wait" | "orphan"; count: number }> {
  const L = d.ledger;
  if (L.isPushed("session_mem", memId)) return { state: "ok", count: 0 };
  const parent = d.reader.findSessionByMemoryId(m.local_project, memId);
  if (!parent) return { state: "orphan", count: 0 };
  if (!parent.row.memory_session_id || parent.id > L.getPushCursor(m.local_project, "sessions")) return { state: "wait", count: 0 };
  let count = 0;
  const srec = toRecord("session", parent.row as SessionRow);
  if (!L.isImported("session", srec.key)) {
    count = (await send(d, m, [stripPrompt(withProject(srec, spaceName(m)))], acc)).count;
    L.markPushed("session", [srec.key]);
  }
  L.markPushed("session_mem", [memId]);
  return { state: "ok", count };
}

/**
 * Re-sends notes the hub rejected for a missing parent session. Each is re-read from claude-mem by
 * local id (it may carry a new memory id by now) and sent after its parent session, so the hub can
 * learn the session's new id first. A note leaves the list once the hub accepts or skips it, when
 * its row is gone, when the hub rejects it for another reason (reported like any rejection), or
 * when the hub still rejects it PUSH_RETRY_GIVE_UP_MS after the first rejection (counted in
 * skipped_rejected). Only answered pushes count: if the hub is unreachable or answers 5xx, send
 * throws, the cycle ends with an error and nothing here changes.
 */
async function retryMapping(d: SyncDeps, m: MappingView, nowMs: number, acc: PushAcc): Promise<number> {
  const L = d.ledger;
  const B = d.batchSize ?? 200;
  const held = L.pushRetries(m.local_project);
  if (held.length === 0) return 0;
  const parents = new Map<string, SyncRecord>();
  const out: SyncRecord[] = [];
  const entries: typeof held = [];
  for (const h of held) {
    const row = h.kind === "observation"
      ? d.reader.readObservationById(m.local_project, h.local_id)
      : d.reader.readSummaryById(m.local_project, h.local_id);
    if (!row) {
      L.deletePushRetry(m.local_project, h.kind, h.global_key);
      continue;
    }
    const parent = d.reader.findSessionByMemoryId(m.local_project, row.memory_session_id);
    if (parent?.row.memory_session_id) {
      const srec = toRecord("session", parent.row as SessionRow);
      if (!L.isImported("session", srec.key)) parents.set(srec.key, stripPrompt(withProject(srec, spaceName(m))));
    }
    const rec = h.kind === "observation" ? toRecord("observation", row as ObservationRow) : toRecord("summary", row as SummaryRow);
    out.push(withProject(rec, spaceName(m)));
    entries.push(h);
  }
  let count = 0;
  const sessions = [...parents.values()];
  for (let i = 0; i < sessions.length; i += B) {
    const batch = sessions.slice(i, i + B);
    count += (await send(d, m, batch, acc)).count;
    L.markPushed("session", batch.map((r) => r.key));
    L.markPushed("session_mem", batch.map((r) => (r.payload as SessionRow).memory_session_id));
  }
  for (let i = 0; i < out.length; i += B) {
    const batch = out.slice(i, i + B);
    const { count: n, reasons } = await send(d, m, batch, acc);
    count += n;
    batch.forEach((rec, j) => {
      const h = entries[i + j];
      const reason = reasons.get(rec.key);
      if (reason === undefined || !reason.includes(PARENT_MISSING)) {
        L.deletePushRetry(m.local_project, h.kind, h.global_key);
        return;
      }
      L.bumpPushRetry(m.local_project, h.kind, h.global_key, reason);
      if (nowMs - h.first_failed_at > PUSH_RETRY_GIVE_UP_MS) {
        L.deletePushRetry(m.local_project, h.kind, h.global_key);
        acc.gaveUp++;
      }
    });
  }
  return count;
}

async function pushMapping(d: SyncDeps, m: MappingView, nowMs: number, acc: PushAcc): Promise<number> {
  const B = d.batchSize ?? 200;
  const L = d.ledger;
  let count = 0;

  // Sessions, in id order. A session without memory_session_id holds the cursor unless it is stale.
  for (;;) {
    const cur = L.getPushCursor(m.local_project, "sessions");
    const rows = d.reader.readSessions(m.local_project, cur, B);
    if (rows.length === 0) break;
    const out: SyncRecord[] = [];
    let next = cur;
    let blocked = false;
    for (const { id, row } of rows) {
      if (!row.memory_session_id) {
        if (nowMs - row.started_at_epoch > STALE_SESSION_MS) {
          next = id;
          continue;
        }
        blocked = true;
        break;
      }
      next = id;
      const rec = toRecord("session", row as SessionRow);
      if (L.isImported("session", rec.key)) continue;
      out.push(stripPrompt(withProject(rec, spaceName(m))));
    }
    if (out.length) {
      const { count: n } = await send(d, m, out, acc);
      L.markPushed("session", out.map((r) => r.key));
      L.markPushed("session_mem", out.map((r) => (r.payload as SessionRow).memory_session_id));
      count += n;
    }
    L.setPushCursor(m.local_project, "sessions", next);
    if (blocked || rows.length < B) break;
  }

  // Observations, in id order. Wait for the parent session to be pushed first.
  for (;;) {
    const cur = L.getPushCursor(m.local_project, "observations");
    const rows = d.reader.readObservations(m.local_project, cur, B);
    if (rows.length === 0) break;
    const out: SyncRecord[] = [];
    const ids: number[] = [];
    let next = cur;
    let blocked = false;
    for (const { id, row } of rows) {
      const rec = toRecord("observation", row);
      if (L.isImported("observation", rec.key)) {
        next = id;
        continue;
      }
      const parent = await ensureParent(d, m, row.memory_session_id, acc);
      count += parent.count;
      if (parent.state === "orphan") {
        // Orphan: no parent session in this project, it can never be pushed.
        next = id;
        acc.orphans++;
        continue;
      }
      if (parent.state === "wait") {
        blocked = true;
        break;
      }
      next = id;
      out.push(withProject(rec, spaceName(m)));
      ids.push(id);
    }
    if (out.length) {
      count += (await send(d, m, out, acc, ids)).count;
    }
    L.setPushCursor(m.local_project, "observations", next);
    if (blocked || rows.length < B) break;
  }

  // Summaries: the latest per session, once quiet, once only, after their session (re-sent like
  // an observation's when the session cursor passed it, e.g. a session renamed after its push).
  const summaries: { id: number; row: SummaryRow }[] = [];
  for (const s of d.reader.readQuietSummaries(m.local_project, nowMs - d.summaryQuietMs)) {
    const memId = s.row.memory_session_id;
    if (L.isImported("summary", memId) || L.isPushed("summary", memId)) continue;
    const parent = await ensureParent(d, m, memId, acc);
    count += parent.count;
    if (parent.state === "ok") summaries.push(s);
    else if (parent.state === "orphan") {
      // No session in this project has this id, so the summary can never be pushed. Count it once
      // and mark it so it is not checked again every cycle.
      acc.orphans++;
      L.markPushed("summary", [memId]);
    }
  }
  for (let i = 0; i < summaries.length; i += B) {
    const batch = summaries.slice(i, i + B);
    const out = batch.map((s) => withProject(toRecord("summary", s.row), spaceName(m)));
    const { count: n } = await send(d, m, out, acc, batch.map((s) => s.id));
    L.markPushed("summary", out.map((r) => r.key));
    count += n;
  }
  return count;
}

/**
 * Marks pulled records imported under the hub's key and, when it differs, under the key their
 * payload gives, which is the key this laptop reads the imported row back under. Hubs from 0.2.4
 * store records under their payload's key, so the two match; the second key is a safety net so
 * a mismatched record is never pushed back as new.
 */
function markImported(L: HubLedger, records: SyncRecord[]): void {
  L.markImported(records.flatMap((r) => {
    const own = keyFor(r.kind, r.payload);
    return own === r.key ? [r] : [r, { kind: r.kind, key: own }];
  }));
}

/**
 * Splits records sent as toImportBody(records) by what a partly failed import says about them. The
 * body keeps record order within each kind, so (kind, index) is the index-th record of that kind.
 * - accepted: landed.
 * - uncertain: in a request that failed; it may have committed them.
 * - rest: everything that did not surely land (refused, uncertain, never sent), in record order.
 */
function splitImport(records: SyncRecord[], e: ClaudeMemRejectedError) {
  const tag = new Map<string, "refused" | "uncertain">();
  for (const r of e.rejected) tag.set(`${r.kind}:${r.index}`, "refused");
  if (e instanceof ClaudeMemPartialImportError) {
    for (const r of e.notSent) tag.set(`${r.kind}:${r.index}`, "refused");
    for (const r of e.uncertain) tag.set(`${r.kind}:${r.index}`, "uncertain");
  }
  const seen = { session: 0, observation: 0, summary: 0 };
  const accepted: SyncRecord[] = [];
  const uncertain: SyncRecord[] = [];
  const rest: SyncRecord[] = [];
  for (const r of records) {
    const t = tag.get(`${r.kind}:${seen[r.kind]++}`);
    if (t === undefined) accepted.push(r);
    else rest.push(r);
    if (t === "uncertain") uncertain.push(r);
  }
  return { accepted, uncertain, rest };
}

const DELETIONS_PAGE = 500;

/** Applies the hub's deletions in order; the cursor moves only past ones that were applied, so a locked claude-mem retries next cycle. */
function applyDeletions(d: SyncDeps, spaceId: number, page: { deletions?: { id: number; kind: "observation" | "summary"; keys: string[] }[] }): void {
  for (const del of page.deletions ?? []) {
    try {
      deleteFromClaudeMem(d.claudeMemDbPath, del.kind, del.keys);
    } catch (e) {
      throw new Error(`could not delete a note from claude-mem: ${e instanceof Error ? e.message : String(e)}`);
    }
    d.ledger.forgetImported(del.kind, del.keys);
    d.ledger.setDeletionCursor(spaceId, del.id);
  }
}

async function pullMapping(d: SyncDeps, m: MappingView, acc: PushAcc): Promise<number> {
  const L = d.ledger;
  let count = 0;
  for (const p of L.pendingPulls(m.space_id)) {
    try {
      await d.mem.importRecords(toImportBody(p.records));
    } catch (e) {
      let failed = p.records.length;
      if (e instanceof ClaudeMemRejectedError) {
        // Part of the batch landed; only the rows that did not surely land stay pending.
        const { accepted, rest } = splitImport(p.records, e);
        markImported(L, accepted);
        L.replacePendingPull(p.id, rest);
        acc.pulledBeforeError += accepted.length;
        failed = rest.length;
      }
      if (!isHttpFailure(e)) throw new LocalDown(LOCAL_DOWN_MSG);
      if (L.bumpPendingAttempts(p.id) >= MAX_PENDING_ATTEMPTS) {
        L.deletePendingPull(p.id);
        acc.quarantined += failed;
        const prev = Number(L.status().quarantined_pulls ?? 0);
        L.setStatus("quarantined_pulls", String(prev + failed));
        continue;
      }
      throw e;
    }
    markImported(L, p.records);
    L.deletePendingPull(p.id);
    count += p.records.length;
  }
  for (;;) {
    const page = await d.hub.pull(m.space_id, L.getPullCursor(m.space_id), 500, L.getDeletionCursor(m.space_id));
    const local = page.records.map((r) => withProject(r, m.local_project));
    if (local.length) {
      try {
        await d.mem.importRecords(toImportBody(local));
      } catch (e) {
        if (e instanceof ClaudeMemRejectedError) {
          // Part of the page landed. Refused and never-sent rows are not imported; rows of a failed
          // request may have committed, so they are marked (never echo them back) but stay pending.
          const { accepted, uncertain, rest } = splitImport(local, e);
          markImported(L, [...accepted, ...uncertain]);
          L.addPendingPull(m.space_id, rest);
          acc.pulledBeforeError += accepted.length;
        } else {
          markImported(L, local); // a timed-out import may have committed; never echo these back
          L.addPendingPull(m.space_id, local);
        }
        L.setPullCursor(m.space_id, page.next_after);
        if (!isHttpFailure(e)) throw new LocalDown(LOCAL_DOWN_MSG);
        throw e;
      }
      markImported(L, local);
      count += local.length;
    }
    L.setPullCursor(m.space_id, page.next_after);
    applyDeletions(d, m.space_id, page);
    if (!page.has_more && (page.deletions?.length ?? 0) < DELETIONS_PAGE) break;
  }
  return count;
}
