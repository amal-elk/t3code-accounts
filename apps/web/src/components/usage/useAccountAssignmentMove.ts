import { useRef, useState } from "react";
import { moveAccountAssignment, type AccountRow } from "@t3tools/client-runtime/accounts";
import type { LedgerSave } from "./AccountsEditors";

export function useAccountAssignmentMove(accounts: ReadonlyArray<AccountRow>, save: LedgerSave) {
  const [pending, setPending] = useState<{
    readonly source: AccountRow;
    readonly target: AccountRow;
    readonly assignee: string;
    readonly confirmed: boolean;
  } | null>(null);
  const busy = useRef(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [assignmentStatus, setAssignmentStatus] = useState("");

  // RPC replies and the config stream can arrive separately. Keep the preview until
  // the stream catches up, so the pill never flashes back to its old account.
  if (pending?.confirmed) {
    const source = accounts.find(
      (account) =>
        account.environmentId === pending.source.environmentId && account.id === pending.source.id,
    );
    const target = accounts.find(
      (account) =>
        account.environmentId === pending.target.environmentId && account.id === pending.target.id,
    );
    if (
      !source ||
      !target ||
      (!source.saved?.assignees?.includes(pending.assignee) &&
        target.saved?.assignees?.includes(pending.assignee))
    ) {
      setPending(null);
    }
  }

  const moveAssignment = async (source: AccountRow, target: AccountRow, assignee: string) => {
    if (busy.current || pending !== null) return;
    const patch = moveAccountAssignment(source, target, assignee);
    if (!patch) return;
    busy.current = true;
    setPending({ source, target, assignee, confirmed: false });
    setAssignmentError(null);
    setAssignmentStatus("Moving assignment…");
    try {
      await save(source.environmentId, patch);
      busy.current = false;
      setPending((previous) => previous && { ...previous, confirmed: true });
      setAssignmentStatus("Assignment saved.");
    } catch (cause) {
      busy.current = false;
      setPending(null);
      setAssignmentStatus("");
      setAssignmentError(
        cause instanceof Error ? cause.message : "Could not move this assignment.",
      );
    }
  };

  const assignmentAccounts = pending
    ? accounts.map((account) => {
        if (account.environmentId !== pending.source.environmentId) return account;
        const people = account.saved?.assignees ?? [];
        const assignees =
          account.id === pending.source.id
            ? people.filter((person) => person !== pending.assignee)
            : account.id === pending.target.id
              ? [...new Set([...people, pending.assignee])]
              : null;
        return assignees === null
          ? account
          : {
              ...account,
              saved: {
                ...(account.saved ?? { service: account.service, label: account.label }),
                assignees,
              },
            };
      })
    : accounts;

  return {
    assignmentAccounts,
    movingAssignment: pending !== null,
    assignmentError,
    assignmentStatus,
    moveAssignment,
    setAssignmentError,
    clearAssignmentFeedback: () => {
      setAssignmentError(null);
      setAssignmentStatus("");
    },
  };
}
