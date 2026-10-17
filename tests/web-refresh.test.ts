import { describe, expect, it, vi } from "vitest";
import { createLatestRequest } from "../apps/web/src/refresh.js";

describe("project refresh controller", () => {
  it("refetches and applies the current project state without a page reload", async () => {
    const apply = vi.fn();
    const fail = vi.fn();
    const loading = vi.fn();
    const refresh = createLatestRequest({
      load: vi.fn(async (id: string) => ({ id, state: "READY" })),
      apply,
      fail,
      loading
    });

    await expect(refresh.run("project-1")).resolves.toBe(true);
    expect(apply).toHaveBeenCalledWith({ id: "project-1", state: "READY" });
    expect(fail).toHaveBeenLastCalledWith(undefined);
    expect(loading.mock.calls).toEqual([[true], [false]]);
  });

  it("reports request failures and always releases the loading state", async () => {
    const fail = vi.fn();
    const loading = vi.fn();
    const refresh = createLatestRequest({
      load: async () => { throw new Error("API unavailable"); },
      apply: vi.fn(),
      fail,
      loading
    });

    await expect(refresh.run("project-1")).resolves.toBe(false);
    expect(fail.mock.calls[0]?.[0]).toEqual(new Error("API unavailable"));
    expect(loading.mock.calls).toEqual([[true], [false]]);
  });

  it("ignores an older response that arrives after a newer refresh", async () => {
    let resolveOld!: (value: string) => void;
    const old = new Promise<string>((resolve) => { resolveOld = resolve; });
    const apply = vi.fn();
    const refresh = createLatestRequest({
      load: (value: string) => value === "old" ? old : Promise.resolve(value),
      apply,
      fail: vi.fn(),
      loading: vi.fn()
    });

    const first = refresh.run("old");
    await refresh.run("new");
    resolveOld("old");
    await first;
    expect(apply.mock.calls).toEqual([["new"]]);
  });
});
