// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import type { AccountPillRow } from "@t3tools/client-runtime/accounts";
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LedgerSave } from "./AccountsEditors";
import { useAccountPills } from "./useAccountPills";

const local = EnvironmentId.make("local");
const source: AccountPillRow = {
  id: "source",
  kind: "account",
  environmentId: local,
  label: "Source",
  pills: ["Amal using", "Needs review"],
};
const target: AccountPillRow = {
  id: "target",
  kind: "date",
  environmentId: local,
  label: "Expires Friday",
  pills: ["Alex using"],
};
const initial = [source, target];
let container: HTMLDivElement;
let root: Root;
let state: ReturnType<typeof useAccountPills>;

function Harness({
  accounts,
  save,
}: {
  readonly accounts: ReadonlyArray<AccountPillRow>;
  readonly save: LedgerSave;
}) {
  const assignment = useAccountPills(accounts, save);
  useLayoutEffect(() => {
    state = assignment;
  }, [assignment]);
  return (
    <>
      {assignment.pillRows.map((account) => (
        <output key={account.id} data-account={account.id}>
          {account.pills.join(", ")}
        </output>
      ))}
      <button
        onClick={() => void assignment.movePill(source, target, "Amal using").catch(() => {})}
      >
        Move Amal
      </button>
      {assignment.error ? <p role="alert">{assignment.error}</p> : null}
    </>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = (accounts: ReadonlyArray<AccountPillRow>, save: LedgerSave) =>
  act(() => root.render(<Harness accounts={accounts} save={save} />));
const drop = () => act(() => container.querySelector("button")!.click());
const people = (id: string) => container.querySelector(`[data-account="${id}"]`)?.textContent;

function deferredReply() {
  let resolve!: () => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

describe("Assignment drop preview", () => {
  it("moves immediately and stays at the destination until both save and config stream confirm it", async () => {
    const reply = deferredReply();
    const save = vi.fn<LedgerSave>(() => reply.promise);
    await render(initial, save);
    await drop();
    expect(people("source")).toBe("Needs review");
    expect(people("target")).toBe("Alex using, Amal using");
    expect(state.savingPill).toBe(true);

    // A fast RPC reply must not expose the old row while its subscription catches up.
    await act(async () => {
      reply.resolve();
      await reply.promise;
    });
    await render([...initial], save);
    expect(people("target")).toBe("Alex using, Amal using");
    expect(state.savingPill).toBe(true);

    const synchronized = [
      { ...source, pills: ["Needs review"] },
      { ...target, pills: ["Alex using", "Amal using", "Taylor"] },
    ];
    await render(synchronized, save);
    expect(people("source")).toBe("Needs review");
    expect(people("target")).toBe("Alex using, Amal using, Taylor");
    expect(state.savingPill).toBe(false);
    expect(state.status).toBe("Pill saved.");
  });

  it("keeps the preview when a subscription arrives before the save reply", async () => {
    const reply = deferredReply();
    const save = vi.fn<LedgerSave>(() => reply.promise);
    await render(initial, save);
    await drop();
    await render(
      [
        { ...source, pills: ["Needs review"] },
        { ...target, pills: ["Alex using", "Amal using"] },
      ],
      save,
    );
    expect(state.savingPill).toBe(true);
    expect(people("target")).toBe("Alex using, Amal using");
    await act(async () => {
      reply.resolve();
      await reply.promise;
    });
    expect(state.savingPill).toBe(false);
    expect(people("target")).toBe("Alex using, Amal using");
  });

  it("rolls back a failed save and blocks a second move while the first is pending", async () => {
    const reply = deferredReply();
    const save = vi.fn<LedgerSave>(() => reply.promise);
    await render(initial, save);
    await drop();
    await drop();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => {
      reply.reject(new Error("Could not save"));
      await reply.promise.catch(() => {});
    });
    expect(people("source")).toBe("Amal using, Needs review");
    expect(people("target")).toBe("Alex using");
    expect(state.savingPill).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not save");
  });
});
