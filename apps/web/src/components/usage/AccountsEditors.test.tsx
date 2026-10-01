// @vitest-environment jsdom
import { EnvironmentId } from "@t3tools/contracts";
import type { AccountRow, LedgerEvent } from "@t3tools/client-runtime/accounts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AccountsEditorDialog, type AccountsEditor, type LedgerSave } from "./AccountsEditors";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const environments = [
  { id: local, label: "Local", connected: true },
  { id: remote, label: "Remote", connected: true },
];

function account(label: string, service = "Claude Code", environmentId = local): AccountRow {
  return {
    id: `${service}:${label}`,
    label,
    service,
    environmentId,
    environmentLabel: environmentId === local ? "Local" : "Remote",
    live: false,
    saved: undefined,
    limits: undefined,
    resetAt: undefined,
    resetSource: undefined,
    trigger: null,
  };
}

const accounts = [
  account("first@example.com"),
  account("second@example.com", "Claude Code", remote),
  account("codex@example.com", "Codex"),
  account("cursor@example.com", "Cursor"),
];
let root: Root;
let container: HTMLDivElement;
const onSave = vi.fn<LedgerSave>(async () => {});
const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSave.mockClear();
  onClose.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(editor: AccountsEditor) {
  await act(() =>
    root.render(
      <AccountsEditorDialog
        editor={editor}
        accounts={accounts}
        environments={environments}
        onSave={onSave}
        onClose={onClose}
      />,
    ),
  );
}

function field(name: string) {
  const label = [...document.querySelectorAll("label")].find((item) => item.textContent === name);
  const control = label && document.getElementById(label.htmlFor);
  if (!(control instanceof HTMLInputElement || control instanceof HTMLSelectElement))
    throw new Error(`Missing field: ${name}`);
  return control;
}

async function change(name: string, value: string) {
  const control = field(name);
  const prototype =
    control instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(control, value);
    control.dispatchEvent(
      new Event(control instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}

async function submit() {
  const form = document.querySelector("form");
  if (!form) throw new Error("Missing date form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("section date editing", () => {
  it("keeps saved scheduling details when changing only the visible fields", async () => {
    const event: LedgerEvent = {
      service: "Claude Code",
      account: accounts[0]!.id,
      kind: "bankedReset",
      label: "Banked reset expires",
      date: "2026-10-22",
      time: "09:00",
      timeZone: "America/New_York",
      amount: "2 credits",
      recurrence: "yearly",
    };
    await render({ kind: "event", environmentId: local, id: "saved", event });
    await change("Date", "2026-10-23");
    await change("Time (optional)", "14:30");
    await change("Label", "Use remaining reset");
    await submit();

    expect(onSave).toHaveBeenCalledWith(local, {
      events: {
        saved: {
          ...event,
          date: "2026-10-23",
          time: "14:30",
          label: "Use remaining reset",
        },
      },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses the section's date type and the chosen account's environment", async () => {
    await render({
      kind: "event",
      environmentId: local,
      service: "Claude Code",
      eventKind: "cloudCredit",
    });
    const choices = field("Account") as HTMLSelectElement;
    expect([...choices.options].map((option) => option.value)).toEqual([
      "",
      "first@example.com",
      "second@example.com",
    ]);
    await change("Account", "second@example.com");
    await change("Date", "2026-11-04");
    await submit();

    expect(onSave.mock.calls[0]?.[0]).toBe(remote);
    expect(Object.values(onSave.mock.calls[0]?.[1].events ?? {})).toEqual([
      expect.objectContaining({
        service: "Claude Code",
        account: "second@example.com",
        kind: "cloudCredit",
        label: "Cloud session credit expires",
        date: "2026-11-04",
        recurrence: "none",
      }),
    ]);
  });

  it("keeps an account that is no longer connected, and allows clearing its account and time", async () => {
    await render({
      kind: "event",
      environmentId: local,
      id: "old",
      event: {
        service: "Claude Code",
        account: "old@example.com",
        label: "Credits expire",
        kind: "creditExpiry",
        date: "2026-10-22",
        time: "09:00",
        timeZone: "America/Los_Angeles",
        recurrence: "none",
      },
    });
    expect(field("Account").value).toBe("old@example.com");
    await change("Account", "");
    await change("Time (optional)", "");
    await submit();
    expect(onSave).toHaveBeenCalledWith(local, {
      events: {
        old: {
          service: "Claude Code",
          label: "Credits expire",
          kind: "creditExpiry",
          date: "2026-10-22",
          timeZone: "America/Los_Angeles",
          recurrence: "none",
        },
      },
    });
  });

  it("starts a Cursor billing date on its monthly schedule without more form fields", async () => {
    await render({
      kind: "event",
      environmentId: local,
      service: "Cursor",
      eventKind: "renewal",
    });
    await change("Account", "cursor@example.com");
    await change("Date", "2026-10-19");
    await submit();
    const patch = onSave.mock.calls[0]?.[1];
    expect(Object.values(patch?.events ?? {})).toEqual([
      expect.objectContaining({
        service: "Cursor",
        account: "cursor@example.com",
        kind: "renewal",
        date: "2026-10-19",
        recurrence: "monthly",
      }),
    ]);
  });
});
