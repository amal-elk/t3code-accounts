// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import type { AccountRow } from "@t3tools/client-runtime/accounts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useAccountUsage } from "./useAccountUsage";

const account: AccountRow = {
  id: "codex:person@example.test",
  environmentId: EnvironmentId.make("local"),
  environmentLabel: "Local",
  service: "Codex",
  label: "person@example.test",
  saved: undefined,
  live: true,
  limits: {
    checkedAt: "2026-10-01T12:00:00Z",
    windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 100 }],
    resetCredits: { availableCount: 2 },
  },
  resetAt: undefined,
  resetSource: undefined,
  trigger: null,
};
let container: HTMLDivElement;
let root: Root;

function Harness({ rows }: { readonly rows: readonly AccountRow[] }) {
  const usageFor = useAccountUsage(rows);
  return rows.map((row) => {
    const usage = usageFor(row);
    return (
      <output key={row.id}>
        {usage.main ? `${remainingPercent(usage.main)}%` : usage.missingLabel}
        {usage.lastKnown ? " · Last known" : ""}
      </output>
    );
  });
}
const render = (rows: readonly AccountRow[]) => act(() => root.render(<Harness rows={rows} />));
const text = () => container.textContent;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Account usage history", () => {
  it("keeps a confirmed zero after a failed read and across remounts, then accepts fresh usage", async () => {
    await render([account]);
    expect(text()).toBe("0%");
    const failed: AccountRow = {
      ...account,
      limits: {
        checkedAt: "2026-10-01T12:05:00Z",
        windows: [],
        unavailable: { reason: "probeFailed" },
      },
    };
    await render([failed]);
    expect(text()).toBe("0% · Last known");
    await act(() => root.unmount());
    root = createRoot(container);
    await render([{ ...failed, live: false, limits: undefined }]);
    expect(text()).toBe("0% · Last known");
    await render([
      {
        ...account,
        limits: {
          checkedAt: "2026-10-01T12:10:00Z",
          windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 22 }],
        },
      },
    ]);
    expect(text()).toBe("78%");
  });

  it("distinguishes an unknown balance from zero", async () => {
    await render([{ ...account, limits: undefined }]);
    expect(text()).toBe("Unavailable");
    await render([{ ...account, limits: undefined, live: false }]);
    expect(text()).toBe("Not connected");
  });

  it("does not reuse one account's usage for another email, service, or environment", async () => {
    await render([account]);
    for (const change of [
      { label: "other@example.test" },
      { service: "Claude Code" },
      { environmentId: EnvironmentId.make("remote") },
    ]) {
      await render([{ ...account, ...change, limits: undefined }]);
      expect(text()).toBe("Unavailable");
    }
  });

  it("clears historical subscription usage when a provider reports it is unsupported", async () => {
    await render([account]);
    await render([
      {
        ...account,
        limits: {
          checkedAt: "2026-10-01T12:05:00Z",
          windows: [],
          unavailable: { reason: "unsupported" },
        },
      },
    ]);
    expect(text()).toBe("Unavailable");
    await render([{ ...account, limits: undefined }]);
    expect(text()).toBe("Unavailable");
  });

  it("stores only display readings, without restoring reset credits or authentication", async () => {
    await render([account]);
    const stored = JSON.parse(window.localStorage.getItem("t3accounts:usage-history:v1")!);
    expect(Object.keys(Object.values(stored)[0] as object).sort()).toEqual([
      "checkedAt",
      "windows",
    ]);
    await render([{ ...account, live: false, limits: undefined }]);
    expect(text()).toBe("0% · Last known");
  });
});
