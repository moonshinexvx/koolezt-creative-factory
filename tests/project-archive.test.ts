import { describe, expect, it } from "vitest";

import { PostgresProjectArchiveStore } from "@koolezt/infrastructure";

type Query = { text: string; values?: readonly unknown[] };
const clientFor = (state: string, pending = false) => {
  const queries: Query[] = [];
  return {
    queries,
    connect: async () => ({
      query: async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, ...(values ? { values } : {}) });
        if (text.startsWith("SELECT state")) return { rows: [{ state, archived_at: null }], rowCount: 1 };
        if (text.includes("FROM workflow_jobs")) return { rows: pending ? [{ value: 1 }] : [], rowCount: pending ? 1 : 0 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined
    })
  };
};

describe("project archive store", () => {
  it("archives only a non-published project after active jobs are clear", async () => {
    const pool = clientFor("DRAFT");
    await new PostgresProjectArchiveStore(pool as never).archive("project-1", "owner@example.com");
    expect(pool.queries.some((query) => query.text.startsWith("UPDATE creative_projects") && query.values?.[0] === "project-1")).toBe(true);
    expect(pool.queries.some((query) => query.text === "COMMIT")).toBe(true);
  });

  it("protects READY projects", async () => {
    const pool = clientFor("READY");
    await expect(new PostgresProjectArchiveStore(pool as never).archive("project-1", "owner@example.com")).rejects.toMatchObject({ code: "PROJECT_DELETE_PROTECTED" });
    expect(pool.queries.some((query) => query.text.startsWith("UPDATE creative_projects"))).toBe(false);
  });

  it("does not archive while workflow or render work is active", async () => {
    const pool = clientFor("DRAFT", true);
    await expect(new PostgresProjectArchiveStore(pool as never).archive("project-1", "owner@example.com")).rejects.toMatchObject({ code: "PROJECT_DELETE_IN_PROGRESS" });
    expect(pool.queries.some((query) => query.text.startsWith("UPDATE creative_projects"))).toBe(false);
  });
});