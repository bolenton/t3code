// @effect-diagnostics nodeBuiltinImport:off
/**
 * OpenCode usage source: the `message` table in OpenCode's SQLite store.
 *
 * Unlike the other providers OpenCode writes no JSONL transcripts. Recent
 * OpenCode versions persist every message as a row in
 * `~/.local/share/opencode/opencode.db`, with per-assistant-message token
 * totals and cost inside the row's `data` JSON. Each scan queries that table
 * directly (read-only, so a concurrently writing OpenCode is undisturbed) and
 * maps the rows onto the shared {@link UsageRecord} shape.
 *
 * Message rows are updated in place while a turn runs, but every scan builds
 * its buckets from a single query, so a row is counted exactly once per scan
 * and the next scan self-corrects a mid-turn read.
 *
 * @module usageOpencodeDb
 */
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

export interface OpencodeMessageRow {
  readonly id: string;
  readonly sessionId: string;
  readonly data: string;
}

export type OpencodeDbScan =
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "ok"; readonly records: readonly UsageRecord[] };

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Resolves OpenCode's SQLite store, honouring `XDG_DATA_HOME` the way
 * XDG-based tools do and falling back to the documented default.
 */
export function resolveOpencodeDbPath(input: {
  readonly xdgDataHome: string | undefined;
  readonly homedir: string;
  readonly join: (...parts: string[]) => string;
  readonly isAbsolute: (path: string) => boolean;
}): string {
  const dataHome = input.xdgDataHome?.trim() ?? "";
  // Per the XDG specification a relative XDG_DATA_HOME is invalid and must be
  // ignored, otherwise the lookup silently resolves against the server's cwd.
  const base =
    dataHome.length > 0 && input.isAbsolute(dataHome)
      ? dataHome
      : input.join(input.homedir, ".local", "share");
  return input.join(base, "opencode", "opencode.db");
}

/**
 * Maps one `message` row onto a usage record.
 *
 * Returns `null` for user messages, rows without recognisable token payloads,
 * and zero-token rows, mirroring how the JSONL parsers drop lines that carry
 * no usage. The message id is a stable primary key, so it doubles as the
 * cross-scan dedupe key.
 */
export function parseOpencodeMessageRow(row: OpencodeMessageRow): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["role"] !== "assistant") return null;

  const tokens = record["tokens"];
  if (typeof tokens !== "object" || tokens === null) return null;
  const tokensRecord = tokens as Record<string, unknown>;

  const modelId = record["modelID"];
  if (typeof modelId !== "string" || modelId.length === 0) return null;

  const time = record["time"];
  let timestampMs: number | null = null;
  if (typeof time === "object" && time !== null) {
    const timeRecord = time as Record<string, unknown>;
    timestampMs = finiteNumber(timeRecord["completed"]) ?? finiteNumber(timeRecord["created"]);
  }
  if (timestampMs === null || timestampMs <= 0) return null;

  const cache = tokensRecord["cache"];
  const cacheRecord =
    typeof cache === "object" && cache !== null ? (cache as Record<string, unknown>) : null;

  // OpenCode reports input disjoint from cache reads/writes (cache traffic
  // dwarfs input on real sessions), so no Codex-style inclusive adjustment.
  const outputTokens = int(tokensRecord["output"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: int(tokensRecord["input"]),
    cachedInputTokens: cacheRecord === null ? 0 : int(cacheRecord["read"]),
    cacheCreationTokens: cacheRecord === null ? 0 : int(cacheRecord["write"]),
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(tokensRecord["reasoning"])),
  };
  if (totalTokens(totals) === 0) return null;

  const cost = finiteNumber(record["cost"]);

  return {
    provider: "opencode",
    timestampMs: Math.trunc(timestampMs),
    model: modelId,
    sessionId: row.sessionId,
    totals,
    reportedCostUsd: cost,
    dedupeKey: row.id.length > 0 ? row.id : null,
  };
}

/**
 * Reads assistant-message usage from OpenCode's store.
 *
 * This is a single synchronous query by design: a real 30-day window scans in
 * tens of milliseconds (667 rows / ~4 MB measured), a fraction of the scan's
 * existing multi-second budget, so a worker thread would be machinery without
 * a problem. Revisit if message volumes grow by orders of magnitude.
 *
 * `missing` means there is no database at `dbPath`. Anything else that goes
 * wrong is `failed` with a bounded message; the caller reports it as a source
 * status rather than failing the whole page.
 */
export function scanOpencodeDb(dbPath: string, sinceMs: number): OpencodeDbScan {
  // Existence decides missing vs failed before SQLite is involved: its open
  // errors conflate "absent path" with "present but unreadable" (wrong
  // permissions, a directory at the path), and only the former may read as
  // missing. Anything present-but-unreadable is a failed source carrying the
  // real error, never a silent "no database here".
  try {
    NodeFS.statSync(dbPath);
  } catch {
    return { kind: "missing" };
  }

  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { open: true, readOnly: true });
  } catch (error) {
    return {
      kind: "failed",
      message: errorMessage(error) ?? "OpenCode database could not be read.",
    };
  }

  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'")
      .all() as Array<{ name: string }>;
    if (tables.length === 0) {
      return {
        kind: "failed",
        message: "OpenCode database has no message table (unsupported storage version).",
      };
    }
    const rows = db
      .prepare(
        // Turns are bucketed by completion time, which can lag creation well
        // past the prefilter: a turn created before the window but completed
        // inside it updates its row, so time_updated catches it. The
        // aggregator still drops anything outside the window after parsing.
        "SELECT id, session_id AS sessionId, data FROM message WHERE time_created >= ? OR time_updated >= ? ORDER BY time_created",
      )
      .all(sinceMs, sinceMs) as Array<{ id: unknown; sessionId: unknown; data: unknown }>;
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.data !== "string") continue;
      const record = parseOpencodeMessageRow({
        id: row.id,
        sessionId: typeof row.sessionId === "string" ? row.sessionId : "",
        data: row.data,
      });
      if (record !== null) records.push(record);
    }
    return { kind: "ok", records };
  } catch (error) {
    const detail = errorMessage(error) ?? "OpenCode database could not be read.";
    return { kind: "failed", message: detail };
  } finally {
    try {
      db.close();
    } catch {
      // Closing a read-only handle cannot fail the scan.
    }
  }
}

function errorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim().slice(0, 200);
  }
  return null;
}
