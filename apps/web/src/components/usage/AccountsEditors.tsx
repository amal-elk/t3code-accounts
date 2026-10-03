import { useId, useState, type ReactNode } from "react";
import type { AccountLedgerPatch, EnvironmentId } from "@t3tools/contracts";
import {
  accountDateTimestamp,
  accountService,
  type AccountRow,
  type LedgerEvent,
  type LedgerNote,
} from "@t3tools/client-runtime/accounts";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { randomUUID } from "../../lib/utils";

export type LedgerSave = (environmentId: EnvironmentId, patch: AccountLedgerPatch) => Promise<void>;
export type LedgerEnvironment = {
  readonly id: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
};
export type AccountsEditor =
  | {
      readonly kind: "account";
      readonly environmentId: EnvironmentId;
      readonly account?: AccountRow;
    }
  | {
      readonly kind: "event";
      readonly environmentId: EnvironmentId;
      readonly service?: string;
      readonly eventKind?: LedgerEvent["kind"];
      readonly id?: string;
      readonly event?: LedgerEvent;
    }
  | {
      readonly kind: "note";
      readonly environmentId: EnvironmentId;
      readonly service?: string;
      readonly id?: string;
      readonly note?: LedgerNote;
    };

export const ACCOUNT_EVENT_LABELS = {
  bankedReset: "Banked reset expires",
  cloudCredit: "Cloud session credit expires",
  creditExpiry: "Credits expire",
  renewal: "Refresh + billing",
  refresh: "Allowance refresh",
  reminder: "Reminder",
} satisfies Record<LedgerEvent["kind"], string>;

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}

const selectStyle =
  "h-8.5 w-full min-w-0 rounded-lg border border-input bg-background px-2.5 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-7.5 sm:text-sm";

function ZoneField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (zone: string) => void;
}) {
  return (
    <Field label="Time zone">
      {(id) => (
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="America/Los_Angeles"
        />
      )}
    </Field>
  );
}

export function AccountsEditorDialog({
  editor,
  accounts,
  environments,
  onSave,
  onClose,
}: {
  readonly editor: AccountsEditor;
  readonly accounts: readonly AccountRow[];
  readonly environments: readonly LedgerEnvironment[];
  readonly onSave: LedgerSave;
  readonly onClose: () => void;
}) {
  const [environmentId, setEnvironmentId] = useState(editor.environmentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formId = useId();
  const existing = editor.kind === "account" ? Boolean(editor.account?.saved) : Boolean(editor.id);
  const save = async (patch: AccountLedgerPatch) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await onSave(environmentId, patch);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save. Try again.");
    } finally {
      setPending(false);
    }
  };
  const remove = async () => {
    const id = editor.kind === "account" ? editor.account?.id : editor.id;
    if (!id) return;
    await save(
      editor.kind === "account"
        ? { accounts: { [id]: null } }
        : editor.kind === "event"
          ? { events: { [id]: null } }
          : { notes: { [id]: null } },
    );
  };
  const title =
    editor.kind === "account"
      ? editor.account
        ? "Edit account details"
        : "Add an account"
      : editor.kind === "event"
        ? existing
          ? "Edit a date"
          : "Add a date"
        : existing
          ? "Edit a note"
          : "Add a note";
  const environment = environments.find((item) => item.id === environmentId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {editor.kind === "event"
              ? `${accountService(editor.event?.service ?? editor.service ?? "Codex")} · ${ACCOUNT_EVENT_LABELS[editor.event?.kind ?? editor.eventKind ?? "creditExpiry"]}`
              : `Saved on ${environment?.label ?? "this environment"}, and shared with its connected clients.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            {!existing &&
            editor.kind !== "event" &&
            !(editor.kind === "account" && editor.account) &&
            environments.length > 1 ? (
              <Field label="Save on environment">
                {(id) => (
                  <select
                    id={id}
                    className={selectStyle}
                    value={environmentId}
                    onChange={(event) => {
                      const target = environments.find((item) => item.id === event.target.value);
                      if (target) setEnvironmentId(target.id);
                    }}
                  >
                    {environments.map((item) => (
                      <option key={item.id} value={item.id} disabled={!item.connected}>
                        {item.label}
                        {item.connected ? "" : " · offline"}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
            {editor.kind === "account" ? (
              <AccountForm
                account={editor.account}
                formId={formId}
                onSave={save}
                onError={setError}
              />
            ) : editor.kind === "event" ? (
              <EventForm
                event={editor.event}
                service={editor.service}
                eventKind={editor.eventKind}
                accounts={accounts.filter(
                  (account) =>
                    account.service ===
                      accountService(editor.event?.service ?? editor.service ?? "Codex") &&
                    (!existing || account.environmentId === environmentId),
                )}
                environments={environments}
                onEnvironmentChange={setEnvironmentId}
                id={editor.id}
                formId={formId}
                onSave={save}
                onError={setError}
              />
            ) : (
              <NoteForm
                note={editor.note}
                service={editor.service}
                id={editor.id}
                formId={formId}
                onSave={save}
              />
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {existing ? (
            <Button
              variant="destructive"
              disabled={pending || !environment?.connected}
              onClick={() => void remove()}
            >
              {editor.kind === "account" && editor.account?.limits
                ? "Clear saved details"
                : "Delete"}
            </Button>
          ) : null}
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={pending || !environment?.connected}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function AccountForm({
  account,
  formId,
  onSave,
  onError,
}: {
  readonly account: AccountRow | undefined;
  readonly formId: string;
  readonly onSave: (patch: AccountLedgerPatch) => Promise<void>;
  readonly onError: (error: string | null) => void;
}) {
  const [service, setService] = useState(account?.service ?? "Codex");
  const [label, setLabel] = useState(account?.label ?? "");
  const [zone, setZone] = useState(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [reset, setReset] = useState(() => {
    if (!account?.saved?.resetAt) return "";
    const parts = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(account.saved.resetAt));
    return parts.replace(" ", "T");
  });
  const [resetNotTriggered, setResetNotTriggered] = useState(
    account?.saved?.resetNotTriggered ?? false,
  );
  const live = account?.live === true;
  return (
    <form
      id={formId}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onError(null);
        try {
          if (!service.trim() || !label.trim())
            throw new Error("Enter a service and account name.");
          const resetAt = reset
            ? new Date(
                accountDateTimestamp(reset.slice(0, 10), reset.slice(11, 16), zone),
              ).toISOString()
            : undefined;
          void onSave({
            accounts: {
              [account?.id ?? randomUUID()]: {
                service: accountService(service),
                label: label.trim(),
                ...(account?.saved?.assignees !== undefined
                  ? { assignees: account.saved.assignees }
                  : {}),
                ...(resetAt ? { resetAt } : {}),
                ...(resetNotTriggered ? { resetNotTriggered: true } : {}),
                ...(account?.saved?.billingDay ? { billingDay: account.saved.billingDay } : {}),
              },
            },
          });
        } catch (cause) {
          onError(cause instanceof Error ? cause.message : "Check the account details.");
        }
      }}
    >
      <Field label="Service">
        {(id) => (
          <Input
            id={id}
            value={service}
            disabled={live}
            required
            onChange={(event) => setService(event.target.value)}
          />
        )}
      </Field>
      <Field label="Account or workspace">
        {(id) => (
          <Input
            id={id}
            value={label}
            disabled={live}
            required
            autoComplete="off"
            onChange={(event) => setLabel(event.target.value)}
          />
        )}
      </Field>
      <Field label="Saved reset date and time (optional)">
        {(id) => (
          <Input
            id={id}
            type="datetime-local"
            nativeInput
            value={reset}
            onChange={(event) => setReset(event.target.value)}
          />
        )}
      </Field>
      {reset ? <ZoneField value={zone} onChange={setZone} /> : null}
      {live ? (
        <p className="text-xs text-muted-foreground">
          A reported reset time takes precedence over the saved date.
        </p>
      ) : null}
      {accountService(service) === "Codex" || accountService(service) === "Claude Code" ? (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={resetNotTriggered}
            onCheckedChange={(checked) => setResetNotTriggered(Boolean(checked))}
          />
          <span>
            I confirmed this account reset, but its timer has not started.
            <span className="mt-1 block text-xs text-muted-foreground">
              This enables the “Reset, not triggered” pill. A full allowance alone does not confirm
              it.
            </span>
          </span>
        </label>
      ) : null}
    </form>
  );
}

function EventForm({
  event,
  service: initialService,
  eventKind,
  accounts,
  environments,
  onEnvironmentChange,
  id,
  formId,
  onSave,
  onError,
}: {
  readonly event: LedgerEvent | undefined;
  readonly service: string | undefined;
  readonly eventKind: LedgerEvent["kind"] | undefined;
  readonly accounts: readonly AccountRow[];
  readonly environments: readonly LedgerEnvironment[];
  readonly onEnvironmentChange: (environmentId: EnvironmentId) => void;
  readonly id: string | undefined;
  readonly formId: string;
  readonly onSave: (patch: AccountLedgerPatch) => Promise<void>;
  readonly onError: (error: string | null) => void;
}) {
  const service = accountService(event?.service ?? initialService ?? "Codex");
  const kind = event?.kind ?? eventKind ?? "creditExpiry";
  const originalAccountLabel =
    accounts.find((row) => row.id === event?.account)?.label ?? event?.account;
  const [account, setAccount] = useState(originalAccountLabel ?? "");
  const [label, setLabel] = useState(event?.label ?? ACCOUNT_EVENT_LABELS[kind]);
  const [date, setDate] = useState(event?.date ?? "");
  const [time, setTime] = useState(event?.time ?? "");
  const [timeZone] = useState(
    event?.timeZone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const recurrence = event?.recurrence ?? (kind === "renewal" ? "monthly" : "none");
  const choices = [...accounts].sort((a, b) => a.label.localeCompare(b.label));
  return (
    <form
      id={formId}
      className="grid gap-4"
      onSubmit={(submission) => {
        submission.preventDefault();
        onError(null);
        try {
          if (!date) throw new Error("Choose a date.");
          accountDateTimestamp(date, time || undefined, timeZone);
          void onSave({
            events: {
              [id ?? randomUUID()]: {
                service,
                label: label.trim() || ACCOUNT_EVENT_LABELS[kind],
                ...(account.trim()
                  ? {
                      account:
                        event?.account && account === originalAccountLabel
                          ? event.account
                          : account.trim(),
                    }
                  : {}),
                kind,
                date,
                ...(time ? { time } : {}),
                timeZone,
                ...(event?.amount ? { amount: event.amount } : {}),
                recurrence,
              },
            },
          });
        } catch (cause) {
          onError(cause instanceof Error ? cause.message : "Check the date details.");
        }
      }}
    >
      <Field label="Account">
        {(fieldId) => (
          <select
            id={fieldId}
            className={selectStyle}
            value={account}
            onChange={(event) => {
              setAccount(event.target.value);
              const row = choices.find((choice) => choice.label === event.target.value);
              if (row) onEnvironmentChange(row.environmentId);
            }}
          >
            <option value="">Whole section</option>
            {account && !choices.some((choice) => choice.label === account) ? (
              <option value={account}>{account}</option>
            ) : null}
            {choices.map((choice) => (
              <option
                key={choice.id}
                value={choice.label}
                disabled={!environments.find((item) => item.id === choice.environmentId)?.connected}
              >
                {choice.label}
                {environments.length > 1 ? ` · ${choice.environmentLabel}` : ""}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date">
          {(fieldId) => (
            <Input
              id={fieldId}
              type="date"
              nativeInput
              required
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          )}
        </Field>
        <Field label="Time (optional)">
          {(fieldId) => (
            <Input
              id={fieldId}
              type="time"
              nativeInput
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Label">
        {(fieldId) => (
          <Input
            id={fieldId}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={ACCOUNT_EVENT_LABELS[kind]}
          />
        )}
      </Field>
    </form>
  );
}

function NoteForm({
  note,
  service: initialService,
  id,
  formId,
  onSave,
}: {
  readonly note: LedgerNote | undefined;
  readonly service: string | undefined;
  readonly id: string | undefined;
  readonly formId: string;
  readonly onSave: (patch: AccountLedgerPatch) => Promise<void>;
}) {
  const [service, setService] = useState(note?.service ?? initialService ?? "Claude Code");
  const [text, setText] = useState(note?.text ?? "");
  return (
    <form
      id={formId}
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (service.trim() && text.trim())
          void onSave({
            notes: {
              [id ?? randomUUID()]: { service: accountService(service), text: text.trim() },
            },
          });
      }}
    >
      <Field label="Service">
        {(fieldId) => (
          <Input
            id={fieldId}
            value={service}
            required
            onChange={(event) => setService(event.target.value)}
          />
        )}
      </Field>
      <Field label="Note">
        {(fieldId) => (
          <textarea
            id={fieldId}
            value={text}
            required
            maxLength={8000}
            rows={3}
            className="w-full rounded-lg border border-input bg-background p-2.5 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            onChange={(event) => setText(event.target.value)}
            placeholder="Set up cloud credits after updating the GitHub name"
          />
        )}
      </Field>
    </form>
  );
}
