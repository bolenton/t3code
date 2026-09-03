// @effect-diagnostics nodeBuiltinImport:off - the suite seeds a real OpenCode
// SQLite store on disk, outside any Effect FileSystem.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  parseOpencodeMessageRow,
  resolveOpencodeDbPath,
  scanOpencodeDb,
} from "./usageOpencodeDb.ts";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    NodeFS.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "usage-opencode-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Shaped after a real assistant row in OpenCode's message table. */
function assistantData(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    role: "assistant",
    modelID: "muse-spark-1.3-contributor-free",
    providerID: "opencode",
    cost: 0.012,
    tokens: {
      total: 1000,
      input: 700,
      output: 200,
      reasoning: 50,
      cache: { write: 10, read: 90 },
    },
    time: { created: 1788407901907, completed: 1788407904181 },
    ...overrides,
  });
}

function seedDb(
  dbPath: string,
  rows: ReadonlyArray<{
    id: string;
    sessionId: string;
    timeCreated: number;
    timeUpdated?: number;
    data: string;
  }>,
): void {
  NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    const insert = db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.id,
        row.sessionId,
        row.timeCreated,
        row.timeUpdated ?? row.timeCreated,
        row.data,
      );
    }
  } finally {
    db.close();
  }
}

describe("parseOpencodeMessageRow", () => {
  it("extracts token totals, cost, model, and a stable dedupe key", () => {
    const record = parseOpencodeMessageRow({
      id: "msg_abc",
      sessionId: "ses_1",
      data: assistantData(),
    });

    expect(record?.provider).toBe("opencode");
    expect(record?.model).toBe("muse-spark-1.3-contributor-free");
    expect(record?.sessionId).toBe("ses_1");
    expect(record?.timestampMs).toBe(1788407904181);
    expect(record?.totals).toEqual({
      uncachedInputTokens: 700,
      cachedInputTokens: 90,
      cacheCreationTokens: 10,
      outputTokens: 200,
      reasoningTokens: 50,
    });
    expect(record?.reportedCostUsd).toBe(0.012);
    expect(record?.dedupeKey).toBe("msg_abc");
  });

  it("falls back to the creation time when the turn has not completed", () => {
    const record = parseOpencodeMessageRow({
      id: "msg_running",
      sessionId: "ses_1",
      data: assistantData({ time: { created: 1788407901907 } }),
    });

    expect(record?.timestampMs).toBe(1788407901907);
  });

  it("caps reasoning at output tokens", () => {
    const record = parseOpencodeMessageRow({
      id: "msg_1",
      sessionId: "ses_1",
      data: assistantData({ tokens: { input: 5, output: 10, reasoning: 999, cache: {} } }),
    });

    expect(record?.totals.reasoningTokens).toBe(10);
  });

  it("ignores user messages, tokenless rows, and malformed JSON", () => {
    expect(
      parseOpencodeMessageRow({ id: "m", sessionId: "s", data: JSON.stringify({ role: "user" }) }),
    ).toBeNull();
    expect(
      parseOpencodeMessageRow({
        id: "m",
        sessionId: "s",
        data: JSON.stringify({ role: "assistant", modelID: "x", time: { created: 1 } }),
      }),
    ).toBeNull();
    expect(
      parseOpencodeMessageRow({
        id: "m",
        sessionId: "s",
        data: JSON.stringify({
          role: "assistant",
          modelID: "x",
          tokens: { input: 0, output: 0, cache: {} },
          time: { created: 1 },
        }),
      }),
    ).toBeNull();
    expect(parseOpencodeMessageRow({ id: "m", sessionId: "s", data: "not json" })).toBeNull();
    expect(
      parseOpencodeMessageRow({
        id: "m",
        sessionId: "s",
        data: JSON.stringify({ role: "assistant", time: { created: 1 } }),
      }),
    ).toBeNull();
  });
});

describe("resolveOpencodeDbPath", () => {
  const join = (...parts: string[]): string => NodePath.join(...parts);

  it("honours an absolute XDG_DATA_HOME and falls back to the documented default", () => {
    const input = { homedir: "/home/u", join, isAbsolute: NodePath.isAbsolute };
    expect(resolveOpencodeDbPath({ ...input, xdgDataHome: "  /data  " })).toBe(
      "/data/opencode/opencode.db",
    );
    expect(resolveOpencodeDbPath({ ...input, xdgDataHome: "   " })).toBe(
      "/home/u/.local/share/opencode/opencode.db",
    );
    expect(resolveOpencodeDbPath({ ...input, xdgDataHome: undefined })).toBe(
      "/home/u/.local/share/opencode/opencode.db",
    );
  });

  it("ignores a relative XDG_DATA_HOME per the XDG specification", () => {
    expect(
      resolveOpencodeDbPath({
        xdgDataHome: "data",
        homedir: "/home/u",
        join,
        isAbsolute: NodePath.isAbsolute,
      }),
    ).toBe("/home/u/.local/share/opencode/opencode.db");
  });
});

describe("scanOpencodeDb", () => {
  it("returns records inside the window and skips anything else", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, "opencode", "opencode.db");
    seedDb(dbPath, [
      { id: "msg_in", sessionId: "ses_1", timeCreated: 1788407901907, data: assistantData() },
      { id: "msg_old", sessionId: "ses_0", timeCreated: 1000, data: assistantData() },
      {
        id: "msg_user",
        sessionId: "ses_1",
        timeCreated: 1788407901907,
        data: JSON.stringify({ role: "user" }),
      },
    ]);

    const scan = scanOpencodeDb(dbPath, 1788407901900);
    expect(scan.kind).toBe("ok");
    if (scan.kind !== "ok") return;
    expect(scan.records.map((record) => record.dedupeKey)).toEqual(["msg_in"]);
  });

  it("keeps a turn created before the window but completed inside it", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, "opencode", "opencode.db");
    const sinceMs = 1788407901900;
    seedDb(dbPath, [
      {
        id: "msg_slow",
        sessionId: "ses_1",
        timeCreated: sinceMs - 100_000,
        timeUpdated: sinceMs + 1_000,
        data: assistantData({
          time: { created: sinceMs - 100_000, completed: sinceMs + 1_000 },
        }),
      },
    ]);

    const scan = scanOpencodeDb(dbPath, sinceMs);
    expect(scan.kind).toBe("ok");
    if (scan.kind !== "ok") return;
    expect(scan.records.map((record) => record.dedupeKey)).toEqual(["msg_slow"]);
  });

  it("reports missing for an absent database", () => {
    expect(scanOpencodeDb(NodePath.join(makeTempDir(), "opencode.db"), 0)).toEqual({
      kind: "missing",
    });
  });

  it("reports failed for a directory at the database path", () => {
    const dir = makeTempDir();
    const scan = scanOpencodeDb(NodePath.join(dir, "opencode.db"), 0);
    NodeFS.mkdirSync(NodePath.join(dir, "opencode.db"));
    const dirScan = scanOpencodeDb(NodePath.join(dir, "opencode.db"), 0);
    expect(scan.kind).toBe("missing");
    expect(dirScan.kind).toBe("failed");
  });

  it("reports failed for a database without the message table", () => {
    const dir = makeTempDir();
    const dbPath = NodePath.join(dir, "opencode.db");
    const db = new NodeSqlite.DatabaseSync(dbPath);
    try {
      db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
    } finally {
      db.close();
    }
    const scan = scanOpencodeDb(dbPath, 0);
    expect(scan.kind).toBe("failed");
  });
});
