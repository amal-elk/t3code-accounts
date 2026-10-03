import { useRef, useState } from "react";
import {
  accountPillPatch,
  accountPillRowKey,
  moveAccountPill,
  type AccountPillRow,
} from "@t3tools/client-runtime/accounts";
import type { AccountLedgerPatch } from "@t3tools/contracts";
import type { LedgerSave } from "./AccountsEditors";

export function pillRowKey(row: AccountPillRow) {
  return JSON.stringify([row.environmentId, accountPillRowKey(row)]);
}

export function useAccountPills(rows: readonly AccountPillRow[], save: LedgerSave) {
  const [pending, setPending] = useState<{
    readonly updates: readonly AccountPillRow[];
    readonly before: readonly AccountPillRow[];
    readonly confirmed: boolean;
  } | null>(null);
  const busy = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  // Keep the optimistic rows until both the RPC and subscription confirm them.
  // Extra pills added by another client must not keep this preview locked forever.
  if (
    pending?.confirmed &&
    pending.updates.every((update, index) => {
      const current = rows.find((row) => pillRowKey(row) === pillRowKey(update));
      if (!current) return true;
      const removed =
        pending.before[index]?.pills.filter((text) => !update.pills.includes(text)) ?? [];
      return (
        update.pills.every((text) => current.pills.includes(text)) &&
        removed.every((text) => !current.pills.includes(text))
      );
    })
  )
    setPending(null);

  const write = async (updates: readonly AccountPillRow[], patch: AccountLedgerPatch) => {
    if (busy.current || pending) throw new Error("Wait for the current pill to save.");
    const first = updates[0];
    if (!first) return;
    busy.current = true;
    setPending({
      updates,
      before: updates.map(
        (update) => rows.find((row) => pillRowKey(row) === pillRowKey(update)) ?? update,
      ),
      confirmed: false,
    });
    setError(null);
    setStatus("Saving pill…");
    try {
      await save(first.environmentId, patch);
      busy.current = false;
      setPending((previous) => previous && { ...previous, confirmed: true });
      setStatus("Pill saved.");
    } catch (cause) {
      busy.current = false;
      setPending(null);
      setStatus("");
      const message = cause instanceof Error ? cause.message : "Could not save this pill.";
      setError(message);
      throw new Error(message, { cause });
    }
  };
  const setPills = (row: AccountPillRow, pills: readonly string[]) => {
    const update = { ...row, pills };
    return write([update], accountPillPatch([update]));
  };
  const movePill = async (source: AccountPillRow, target: AccountPillRow, text: string) => {
    const patch = moveAccountPill(source, target, text);
    if (!patch) return;
    await write(
      [
        { ...source, pills: source.pills.filter((pill) => pill !== text) },
        { ...target, pills: [...new Set([...target.pills, text])] },
      ],
      patch,
    );
  };
  const pillRows = pending
    ? rows.map(
        (row) => pending.updates.find((update) => pillRowKey(update) === pillRowKey(row)) ?? row,
      )
    : rows;
  return {
    pillRows,
    savingPill: pending !== null,
    error,
    status,
    setError,
    setPills,
    movePill,
    clearFeedback: () => {
      setError(null);
      setStatus("");
    },
  };
}
