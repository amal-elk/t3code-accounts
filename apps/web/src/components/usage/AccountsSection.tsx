import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  accountDateIsPast,
  accountLedgerContainsPatch,
  accountService,
  accountResetNotTriggered,
  collectAccounts,
  collectAccountDates,
  primaryAccountWindow,
  type AccountDate,
  type AccountRow,
} from "@t3tools/client-runtime/accounts";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { EyeIcon, EyeOffIcon, PlusIcon, PencilIcon } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AccountsEditorDialog,
  ACCOUNT_EVENT_LABELS,
  type AccountsEditor,
  type LedgerSave,
} from "./AccountsEditors";

const SERVICE_ORDER = ["Codex", "Claude Code", "Cursor", "Linear"];
const SERVICE_ACCENTS = new Map([
  [
    "Codex",
    "[--account-accent:var(--color-blue-600)] dark:[--account-accent:var(--color-blue-400)]",
  ],
  [
    "Claude Code",
    "[--account-accent:var(--color-orange-700)] dark:[--account-accent:var(--color-orange-400)]",
  ],
  [
    "Cursor",
    "[--account-accent:var(--color-teal-700)] dark:[--account-accent:var(--color-teal-400)]",
  ],
]);

function SensitiveLabel({ value, reveal }: { readonly value: string; readonly reveal: boolean }) {
  return !reveal && value.includes("@") ? (
    <RedactedSensitiveText
      value={value}
      ariaLabel="Toggle account email visibility"
      revealTooltip="Click to reveal email"
      hideTooltip="Click to hide email"
    />
  ) : (
    <span className="break-all">{value}</span>
  );
}

function exactTimestamp(value: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function calendarLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

function twelveHourTime(time: string) {
  const [hours, minutes] = time.split(":");
  const hour = Number(hours);
  return `${hour % 12 || 12}:${minutes} ${hour < 12 ? "AM" : "PM"}`;
}

function Quota({
  window,
  label,
}: {
  readonly window: ServerProviderUsageWindow | undefined;
  readonly label: string;
}) {
  const percent = window ? remainingPercent(window) : null;
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
      <span className="text-base leading-none font-semibold text-(--account-accent) tabular-nums">
        {percent === null ? "—" : `${percent}%`}
      </span>
      <span className="text-3xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** Server-owned annotations sit beside provider-owned quota, never replacing it. */
export function AccountsSection({
  selectedEnvironmentIds,
  now,
  onRefresh,
  cursorPrompt,
}: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly now: number;
  readonly onRefresh: () => Promise<void>;
  readonly cursorPrompt?: ReactNode;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const selected = useMemo(
    () =>
      selectedEnvironmentIds === null
        ? presentations
        : new Map([...presentations].filter(([id]) => selectedEnvironmentIds.has(id))),
    [presentations, selectedEnvironmentIds],
  );
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const accounts = useMemo(() => collectAccounts(selected, now), [selected, now]);
  const dates = useMemo(
    () => collectAccountDates(selected, accounts, timeZone, now),
    [selected, accounts, timeZone, now],
  );
  const environments = [...selected].map(([id, presentation]) => ({
    id,
    label: presentation.entry.target.label,
    connected:
      presentation.connection.phase === "connected" &&
      presentation.serverConfig?.accountsVersion === 1,
  }));
  const defaultEnvironment = environments.find((environment) => environment.connected);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const triggerTimer = useAtomCommand(serverEnvironment.triggerResetTimer, {
    reportFailure: false,
  });
  const [editor, setEditor] = useState<AccountsEditor | null>(null);
  const [revealEmails, setRevealEmails] = useState(true);
  const [triggering, setTriggering] = useState<string | null>(null);
  const triggeringRef = useRef(false);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const save: LedgerSave = async (environmentId, patch) => {
    const presentation = selected.get(environmentId);
    if (
      presentation?.connection.phase !== "connected" ||
      presentation.serverConfig?.accountsVersion !== 1
    )
      throw new Error("Connect this environment to the Accounts fork before saving details.");
    const result = await update({ environmentId, input: { patch: { accountLedger: patch } } });
    if (result._tag !== "Success")
      throw new Error("Could not save these details on the selected environment. Try again.");
    if (!accountLedgerContainsPatch(result.value.accountLedger, patch))
      throw new Error(
        "This server did not retain the change. Update it to a matching Accounts build before saving.",
      );
  };
  const trigger = async (account: AccountRow) => {
    if (!account.trigger || !accountResetNotTriggered(account, now) || triggeringRef.current)
      return;
    triggeringRef.current = true;
    setTriggering(account.id);
    setStatuses((previous) => ({ ...previous, [account.id]: "" }));
    try {
      const result = await triggerTimer({
        environmentId: account.trigger.environmentId,
        input: {
          ...account.trigger.input,
          ledgerAccountId: account.id,
          ...(account.label.includes("@") ? { expectedAccountEmail: account.label } : {}),
          ...(account.limits?.credentialFingerprint
            ? { expectedCredentialFingerprint: account.limits.credentialFingerprint }
            : {}),
        },
      });
      await onRefresh();
      if (result._tag === "Success") {
        setStatuses((previous) => ({
          ...previous,
          [account.id]:
            result.value.warning ??
            (result.value.limits?.windows.some(
              (window) => window.resetsAt && Date.parse(window.resetsAt) > Date.now(),
            )
              ? `Timer confirmed · ${result.value.model}`
              : "Request sent. Refresh to confirm the timer."),
        }));
      } else {
        const detail =
          "error" in result.cause && result.cause.error instanceof Error
            ? result.cause.error.message
            : "The trigger could not be confirmed. Refresh this account before retrying.";
        setStatuses((previous) => ({ ...previous, [account.id]: detail }));
      }
    } catch (cause) {
      setStatuses((previous) => ({
        ...previous,
        [account.id]:
          cause instanceof Error
            ? cause.message
            : "The trigger could not be confirmed. Refresh before retrying.",
      }));
    } finally {
      triggeringRef.current = false;
      setTriggering(null);
    }
  };
  const notes = [...selected].flatMap(([environmentId, presentation]) =>
    Object.entries(presentation.serverConfig?.settings.accountLedger.notes ?? {}).map(
      ([id, note]) => ({ id, environmentId, note }),
    ),
  );
  const services = [
    ...new Set([
      ...SERVICE_ORDER,
      ...accounts.map((account) => account.service),
      ...dates.map((date) => date.service),
      ...notes.map((note) => accountService(note.note.service)),
    ]),
  ];
  const unsupported = [...selected].some(
    ([, presentation]) =>
      presentation.serverConfig && presentation.serverConfig.accountsVersion !== 1,
  );
  return (
    <div className="min-w-0 space-y-5 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Accounts</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Current allowance, upcoming resets, and credit deadlines · {timeZone}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setRevealEmails((value) => !value)}>
            {revealEmails ? <EyeOffIcon /> : <EyeIcon />}
            {revealEmails ? "Hide emails" : "Show emails"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!defaultEnvironment}
            onClick={() => {
              if (defaultEnvironment)
                setEditor({ kind: "account", environmentId: defaultEnvironment.id });
            }}
          >
            Add account
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!defaultEnvironment}
            onClick={() => {
              if (defaultEnvironment)
                setEditor({ kind: "note", environmentId: defaultEnvironment.id });
            }}
          >
            Add note
          </Button>
          <Button
            size="sm"
            disabled={!defaultEnvironment}
            onClick={() => {
              if (defaultEnvironment)
                setEditor({ kind: "event", environmentId: defaultEnvironment.id });
            }}
          >
            <PlusIcon />
            Add date
          </Button>
        </div>
      </div>
      {unsupported ? (
        <p className="text-xs text-muted-foreground">
          Live usage is available from other T3 environments. Connect an Accounts fork server to
          save dates, assignments, and use Trigger.
        </p>
      ) : null}
      {services.map((service) => {
        const serviceAccounts = accounts.filter((account) => account.service === service);
        const serviceDates = dates.filter((date) => date.service === service);
        const serviceNotes = notes.filter(
          (entry) => accountService(entry.note.service) === service,
        );
        return (
          <section
            key={service}
            aria-label={`${service} accounts`}
            className={`min-w-0 ${SERVICE_ACCENTS.has(service) ? "border-s-2 border-s-(--account-accent) ps-3" : ""} ${SERVICE_ACCENTS.get(service) ?? "[--account-accent:var(--foreground)]"}`}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-base font-semibold text-(--account-accent)">{service}</h3>
              {serviceAccounts.length > 0 ? (
                <span className="text-xs text-muted-foreground">
                  {serviceAccounts.length} {serviceAccounts.length === 1 ? "account" : "accounts"}
                </span>
              ) : null}
              {defaultEnvironment ? (
                <div className="ms-auto">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Add ${service} date`}
                    onClick={() =>
                      setEditor({ kind: "event", environmentId: defaultEnvironment.id, service })
                    }
                  >
                    <PlusIcon />
                  </Button>
                </div>
              ) : null}
            </div>
            {serviceAccounts.length > 0 ? (
              <div className="min-w-0 border-t border-border/60">
                <div
                  aria-hidden
                  className="hidden grid-cols-[5.5rem_minmax(0,1fr)_minmax(13rem,auto)] gap-3 py-1.5 text-xs text-muted-foreground sm:grid"
                >
                  <span>Remaining</span>
                  <span>Account</span>
                  <span className="text-right">
                    {service === "Cursor" ? "Refresh + billing" : "Next reset"}
                  </span>
                </div>
                {serviceAccounts.map((account) => {
                  const main = primaryAccountWindow(account.limits);
                  const weeklyLabel =
                    main?.kind === "monthly"
                      ? "monthly"
                      : main?.kind === "session"
                        ? "session"
                        : "weekly";
                  const session = account.limits?.windows.find(
                    (window) => window.kind === "session",
                  );
                  const enabled =
                    environments.find((environment) => environment.id === account.environmentId)
                      ?.connected ?? false;
                  const triggerEnabled =
                    account.trigger &&
                    selected.get(account.trigger.environmentId)?.serverConfig?.accountsVersion ===
                      1;
                  const notTriggered = accountResetNotTriggered(account, now);
                  const resetDetail = notTriggered
                    ? triggerEnabled
                      ? "Sends “test” to a small supported model"
                      : "Connect this account to trigger its timer"
                    : account.resetSource === "saved"
                      ? "Saved date"
                      : account.limits?.checkedAt
                        ? `Updated ${exactTimestamp(account.limits.checkedAt, timeZone)}`
                        : "No reported reset date";
                  const hasSecondaryDetails =
                    (service === "Claude Code" && session && session !== main) ||
                    selected.size > 1 ||
                    account.limits?.unavailable;
                  return (
                    <div
                      key={account.id}
                      className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-t border-border/45 py-1.5 first:border-t-0 sm:grid-cols-[5.5rem_minmax(0,1fr)_minmax(13rem,auto)]"
                    >
                      <div className="row-span-2 sm:row-span-1">
                        <Quota window={main} label={weeklyLabel} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <SensitiveLabel value={account.label} reveal={revealEmails} />
                          {account.saved?.assignee ? (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-2xs text-muted-foreground">
                              {account.saved.assignee} using
                            </span>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={!enabled}
                            aria-label="Edit account details"
                            onClick={() =>
                              setEditor({
                                kind: "account",
                                environmentId: account.environmentId,
                                account,
                              })
                            }
                          >
                            <PencilIcon />
                          </Button>
                        </div>
                        {hasSecondaryDetails ? (
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                            {service === "Claude Code" && session && session !== main ? (
                              <span>
                                Session {remainingPercent(session)}%
                                {session.resetsAt
                                  ? ` · ${exactTimestamp(session.resetsAt, timeZone)}`
                                  : ""}
                              </span>
                            ) : null}
                            {selected.size > 1 ? <span>{account.environmentLabel}</span> : null}
                            {account.limits?.unavailable ? (
                              <span>
                                Usage unavailable
                                {account.limits.unavailable.reason === "probeFailed"
                                  ? " · last reported values"
                                  : ""}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                      <div className="col-start-2 min-w-0 text-xs sm:col-start-auto sm:text-right">
                        {notTriggered ? (
                          <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                            <span
                              aria-label="Reset, not triggered · manually confirmed"
                              className="rounded-full border border-warning/25 bg-warning-surface px-2 py-0.5 text-warning-foreground"
                            >
                              Reset, not triggered
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!triggerEnabled || triggering !== null}
                              onClick={() => void trigger(account)}
                            >
                              {triggering === account.id ? "Triggering…" : "Trigger"}
                            </Button>
                          </div>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger render={<span tabIndex={0} />}>
                              <span className="font-medium tabular-nums">
                                {account.resetAt ? exactTimestamp(account.resetAt, timeZone) : "—"}
                              </span>
                            </TooltipTrigger>
                            <TooltipPopup>{resetDetail}</TooltipPopup>
                          </Tooltip>
                        )}
                        {notTriggered ? (
                          <div className="mt-0.5 text-3xs text-muted-foreground">{resetDetail}</div>
                        ) : null}
                        {statuses[account.id] ? (
                          <p role="status" className="mt-1 max-w-sm text-xs text-muted-foreground">
                            {statuses[account.id]}
                          </p>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : service !== "Linear" ? (
              <p className="text-xs text-muted-foreground">No accounts recorded yet.</p>
            ) : null}
            {service === "Cursor" ? cursorPrompt : null}
            {service === "Linear"
              ? [...selected].map(([environmentId, presentation]) =>
                  presentation.connection.phase === "connected" &&
                  presentation.serverConfig?.accountsVersion === 1 ? (
                    <LinearAccountSummary
                      key={environmentId}
                      environmentId={environmentId}
                      environmentLabel={presentation.entry.target.label}
                      showEnvironment={selected.size > 1}
                      timeZone={timeZone}
                    />
                  ) : null,
                )
              : null}
            <DateGroups
              entries={serviceDates.filter((entry) => entry.kind === "bankedReset")}
              title="Banked reset credits expire"
              revealEmails={revealEmails}
              now={now}
              onEdit={(entry) => {
                if (entry.saved)
                  setEditor({
                    kind: "event",
                    environmentId: entry.environmentId,
                    id: entry.id,
                    event: entry.saved,
                  });
              }}
            />
            <DateGroups
              entries={serviceDates.filter((entry) => entry.kind === "cloudCredit")}
              title="Cloud session credits expire"
              revealEmails={revealEmails}
              now={now}
              onEdit={(entry) => {
                if (entry.saved)
                  setEditor({
                    kind: "event",
                    environmentId: entry.environmentId,
                    id: entry.id,
                    event: entry.saved,
                  });
              }}
            />
            <DateGroups
              entries={serviceDates.filter(
                (entry) => entry.kind !== "bankedReset" && entry.kind !== "cloudCredit",
              )}
              title="Dates"
              revealEmails={revealEmails}
              now={now}
              onEdit={(entry) => {
                if (entry.saved)
                  setEditor({
                    kind: "event",
                    environmentId: entry.environmentId,
                    id: entry.id,
                    event: entry.saved,
                  });
              }}
            />
            {serviceNotes.length > 0 ? (
              <div className="mt-2 space-y-1">
                {serviceNotes.map(({ id, environmentId, note }) => (
                  <div
                    key={`${environmentId}:${id}`}
                    className="flex items-start gap-2 text-sm text-muted-foreground"
                  >
                    <p className="min-w-0 whitespace-pre-wrap break-words">{note.text}</p>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={
                        !environments.find((environment) => environment.id === environmentId)
                          ?.connected
                      }
                      aria-label="Edit note"
                      onClick={() => setEditor({ kind: "note", environmentId, id, note })}
                    >
                      <PencilIcon />
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
      {editor ? (
        <AccountsEditorDialog
          key={`${editor.kind}:${editor.kind === "account" ? (editor.account?.id ?? "new") : (editor.id ?? "new")}`}
          editor={editor}
          environments={environments}
          onSave={save}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}

function DateGroups({
  entries,
  title,
  revealEmails,
  now,
  onEdit,
}: {
  readonly entries: readonly AccountDate[];
  readonly title: string;
  readonly revealEmails: boolean;
  readonly now: number;
  readonly onEdit: (entry: AccountDate) => void;
}) {
  if (entries.length === 0) return null;
  const groups = new Map<string, AccountDate[]>();
  for (const entry of entries) {
    const key = `${entry.date}:${entry.timeZone}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return (
    <div className="mt-3">
      <h4 className="mb-1 text-xs font-medium text-(--account-accent)">{title}</h4>
      {[...groups].map(([key, items]) => {
        const first = items[0];
        if (!first) return null;
        const overdue = accountDateIsPast(first.date, first.timeZone, now);
        return (
          <div
            key={key}
            className="grid min-w-0 gap-x-3 gap-y-1 border-t border-border/45 py-1.5 sm:grid-cols-[7rem_minmax(0,1fr)]"
          >
            <div className="text-xs font-medium text-(--account-accent) tabular-nums">
              <span>{calendarLabel(first.date)}</span>
              {overdue ? (
                <span className="ms-2 text-3xs text-warning-foreground">Past date</span>
              ) : null}
            </div>
            <div className="grid min-w-0 gap-y-0.5">
              {items.map((entry) => (
                <div
                  key={`${entry.environmentId}:${entry.id}`}
                  className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                >
                  <SensitiveLabel value={entry.account ?? entry.label} reveal={revealEmails} />
                  {entry.time ? (
                    <Tooltip>
                      <TooltipTrigger render={<span tabIndex={0} />}>
                        <span className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {twelveHourTime(entry.time)}
                        </span>
                      </TooltipTrigger>
                      <TooltipPopup>
                        {entry.timeZone}
                        {entry.timeUnavailable ? " · time unavailable on this date" : ""}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {entry.account && entry.kind !== "bankedReset" && entry.kind !== "cloudCredit" ? (
                    <span className="text-muted-foreground">{entry.label}</span>
                  ) : null}
                  {entry.origin === "saved" ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit ${ACCOUNT_EVENT_LABELS[entry.kind]}`}
                      onClick={() => onEdit(entry)}
                    >
                      <PencilIcon />
                    </Button>
                  ) : null}
                  {entry.saved?.recurrence && entry.saved.recurrence !== "none" ? (
                    <span className="text-3xs text-muted-foreground">{entry.saved.recurrence}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LinearAccountSummary({
  environmentId,
  environmentLabel,
  showEnvironment,
  timeZone,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly showEnvironment: boolean;
  readonly timeZone: string;
}) {
  const result = useAtomValue(serverEnvironment.linearAccounts({ environmentId, input: {} }));
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  if (!snapshot)
    return (
      <p className="text-xs text-muted-foreground">
        {result.waiting ? "Reading Linear workspace…" : "Linear workspace could not be read."}
      </p>
    );
  if (!snapshot.workspace)
    return (
      <p className="text-xs text-muted-foreground">
        {snapshot.unavailable ??
          "Connect Linear to show its next billing date. Credit expirations can be recorded above."}
      </p>
    );
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/45 py-3">
        <span className="font-medium">
          {snapshot.workspace.name}
          {showEnvironment ? (
            <span className="ms-2 text-xs text-muted-foreground">{environmentLabel}</span>
          ) : null}
        </span>
        <span className="text-xs">
          Next bill{" "}
          {snapshot.workspace.nextBillingAt
            ? exactTimestamp(snapshot.workspace.nextBillingAt, timeZone)
            : "—"}
        </span>
      </div>
      {snapshot.unavailable ? (
        <p className="text-xs text-muted-foreground">{snapshot.unavailable}</p>
      ) : null}
      {snapshot.alerts
        .filter((alert) => !alert.resolvedAt)
        .map((alert) => (
          <div key={alert.id} className="text-xs text-muted-foreground">
            {alert.type === "lowBalance"
              ? "Low credit balance"
              : alert.type === "exhausted"
                ? "Credits exhausted"
                : alert.type === "expiringPromoCredit"
                  ? "Promotional credits expiring"
                  : alert.type}{" "}
            · reported {exactTimestamp(alert.createdAt, timeZone)}
          </div>
        ))}
      <p className="text-xs text-muted-foreground">
        Credit balance and all expiration dates are not available from Linear. Alerts describe their
        recorded state, and billing dates do not establish a credit refresh.
      </p>
    </div>
  );
}
