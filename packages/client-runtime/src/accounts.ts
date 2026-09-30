import * as DateTime from "effect/DateTime";
import type {
  AccountLedgerPatch,
  EnvironmentId,
  ProviderInstanceId,
  ServerConfig,
  ServerProviderUsageLimits,
  ServerSettings,
  UsageLimitSourceId,
} from "@t3tools/contracts";

export type AccountLedger = ServerSettings["accountLedger"];
export type LedgerAccount = AccountLedger["accounts"][string];
export type LedgerEvent = AccountLedger["events"][string];
export type LedgerNote = AccountLedger["notes"][string];

export interface AccountsPresentation {
  readonly entry: { readonly target: { readonly label: string } };
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly settings: Pick<ServerSettings, "accountLedger">;
    readonly providers: ServerConfig["providers"];
    readonly usageLimitSources?: ServerConfig["usageLimitSources"];
  } | null;
}
export type TriggerTimerInput =
  | { readonly instanceId: ProviderInstanceId }
  | { readonly sourceId: UsageLimitSourceId; readonly accountId: string };

export interface AccountRow {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly service: string;
  readonly label: string;
  readonly saved: LedgerAccount | undefined;
  readonly live: boolean;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly resetAt: string | undefined;
  readonly resetSource: "live" | "saved" | undefined;
  readonly trigger: {
    readonly environmentId: EnvironmentId;
    readonly input: TriggerTimerInput;
  } | null;
}

export interface AccountDate {
  readonly id: string;
  readonly environmentId: EnvironmentId;
  readonly service: string;
  readonly account: string | undefined;
  readonly label: string;
  readonly kind: LedgerEvent["kind"];
  readonly date: string;
  readonly time: string | undefined;
  readonly timeZone: string;
  readonly timeUnavailable?: boolean;
  readonly amount: string | undefined;
  readonly origin: "live" | "saved";
  readonly saved: LedgerEvent | undefined;
}

/** Verify authoritative save responses before reporting success to the editor. */
export function accountLedgerContainsPatch(
  ledger: AccountLedger,
  patch: AccountLedgerPatch,
): boolean {
  for (const collection of ["accounts", "events", "notes"] as const) {
    const changes = patch[collection];
    if (!changes) continue;
    for (const [id, expected] of Object.entries(changes)) {
      const actual = ledger[collection][id];
      if (expected === null) {
        if (actual !== undefined) return false;
        continue;
      }
      if (!actual) return false;
      const canonical = (record: object) =>
        JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
      if (canonical(actual) !== canonical(expected)) return false;
    }
  }
  return true;
}

export function accountService(value: string): string {
  const name = value.trim();
  switch (name.toLowerCase()) {
    case "codex":
      return "Codex";
    case "claude":
    case "claudeagent":
    case "claude code":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "linear":
      return "Linear";
    default:
      return name;
  }
}

export function accountIdentity(service: string, label: string): string {
  return `${accountService(service).toLowerCase()}:${label.trim().toLowerCase()}`;
}

export function primaryAccountWindow(limits: ServerProviderUsageLimits | undefined) {
  const windows = limits?.windows ?? [];
  // Model-specific Claude buckets never stand in for the account-wide week.
  return (
    windows.find((window) => window.id === "seven_day") ??
    windows.find(
      (window) =>
        window.kind === "weekly" &&
        !window.id.startsWith("seven_day_") &&
        !window.label.includes("·"),
    ) ??
    windows.find((window) => window.kind === "monthly" && window.id === "totalPercentUsed") ??
    windows.find((window) => window.kind === "monthly") ??
    windows.find((window) => window.kind === "session") ??
    windows.find((window) => window.kind === "other")
  );
}

export function accountResetNotTriggered(account: AccountRow, now: number): boolean {
  if (!account.saved?.resetNotTriggered) return false;
  const window = primaryAccountWindow(account.limits);
  // A provider-reported account-wide timer disproves a saved observation;
  // a failed probe or model-only bucket cannot establish that timer.
  return !(
    !account.limits?.unavailable &&
    window?.kind === "weekly" &&
    window.resetsAt &&
    Date.parse(window.resetsAt) > now
  );
}

/** Accounts without quota access remain visible; absent quota never means zero. */
export function collectAccounts(
  presentations: ReadonlyMap<EnvironmentId, AccountsPresentation>,
  now: number,
): readonly AccountRow[] {
  const rows = new Map<string, AccountRow>();
  const creditReads = new Map<
    string,
    { checkedAt: string; credits: NonNullable<ServerProviderUsageLimits["resetCredits"]> }
  >();
  const saved = new Map<
    string,
    { id: string; environmentId: EnvironmentId; environmentLabel: string; account: LedgerAccount }
  >();
  for (const [environmentId, presentation] of presentations) {
    for (const [id, account] of Object.entries(
      presentation.serverConfig?.settings.accountLedger.accounts ?? {},
    )) {
      const identity = accountIdentity(account.service, account.label);
      if (!saved.has(identity))
        saved.set(identity, {
          id,
          environmentId,
          environmentLabel: presentation.entry.target.label,
          account,
        });
    }
  }
  const merge = (identity: string, next: AccountRow) => {
    const credits = next.limits?.resetCredits;
    const previousCredit = creditReads.get(identity);
    if (
      credits &&
      (!previousCredit || Date.parse(next.limits!.checkedAt) > Date.parse(previousCredit.checkedAt))
    )
      creditReads.set(identity, { checkedAt: next.limits!.checkedAt, credits });
    const previous = rows.get(identity);
    if (!previous) {
      rows.set(identity, next);
      return;
    }
    const fresh =
      Date.parse(next.limits?.checkedAt ?? "") > Date.parse(previous.limits?.checkedAt ?? "") ||
      (!previous.limits && next.limits);
    const winner = fresh ? next : previous;
    // Prefer a direct authenticated provider for the trigger. A reporting-only
    // source never borrows another account's provider route.
    const trigger = winner.saved
      ? ([previous.trigger, next.trigger].find(
          (route) => route?.environmentId === winner.environmentId,
        ) ?? null)
      : (previous.trigger ?? next.trigger);
    rows.set(identity, { ...winner, trigger });
  };
  const row = (
    identity: string,
    environmentId: EnvironmentId,
    presentation: AccountsPresentation,
    service: string,
    label: string,
    limits: ServerProviderUsageLimits | undefined,
    trigger: AccountRow["trigger"],
  ): AccountRow => {
    const record =
      saved.get(identity) ?? [...saved.values()].find((entry) => entry.id === identity);
    const liveReset = primaryAccountWindow(limits)?.resetsAt;
    return {
      id: record?.id ?? identity,
      environmentId: record?.environmentId ?? environmentId,
      environmentLabel: record?.environmentLabel ?? presentation.entry.target.label,
      service: accountService(service),
      label,
      saved: record?.account,
      live: true,
      limits,
      resetAt: liveReset ?? record?.account.resetAt,
      resetSource: liveReset ? "live" : record?.account.resetAt ? "saved" : undefined,
      trigger: record && trigger?.environmentId !== record.environmentId ? null : trigger,
    };
  };
  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (!provider.enabled || provider.auth.status !== "authenticated") continue;
      const service = accountService(provider.driver);
      const label = provider.auth.email ?? provider.displayName ?? provider.instanceId;
      const identity = accountIdentity(
        service,
        provider.auth.email ??
          provider.usageLimits?.credentialFingerprint ??
          `${environmentId}:${provider.instanceId}`,
      );
      const canTrigger =
        presentation.connection.phase === "connected" &&
        (provider.driver === "codex" || provider.driver === "claudeAgent") &&
        provider.installed &&
        provider.availability !== "unavailable";
      merge(
        identity,
        row(
          identity,
          environmentId,
          presentation,
          service,
          label,
          provider.usageLimits,
          canTrigger ? { environmentId, input: { instanceId: provider.instanceId } } : null,
        ),
      );
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        const service = accountService(account.driver);
        const label = account.email ?? account.id;
        const identity = accountIdentity(
          service,
          account.email ??
            account.usageLimits.credentialFingerprint ??
            `${environmentId}:${source.id}:${account.id}`,
        );
        merge(
          identity,
          row(
            identity,
            environmentId,
            presentation,
            service,
            label,
            account.usageLimits,
            presentation.connection.phase === "connected" && account.driver === "codex"
              ? { environmentId, input: { sourceId: source.id, accountId: account.id } }
              : null,
          ),
        );
      }
    }
  }
  for (const [identity, record] of saved) {
    if (rows.has(identity) || [...rows.values()].some((account) => account.id === record.id))
      continue;
    rows.set(identity, {
      id: record.id,
      environmentId: record.environmentId,
      environmentLabel: record.environmentLabel,
      service: accountService(record.account.service),
      label: record.account.label,
      saved: record.account,
      live: false,
      limits: undefined,
      resetAt: record.account.resetAt,
      resetSource: record.account.resetAt ? "saved" : undefined,
      trigger: null,
    });
  }
  for (const [identity, account] of rows) {
    const read = creditReads.get(identity);
    if (read && account.limits)
      rows.set(identity, { ...account, limits: { ...account.limits, resetCredits: read.credits } });
  }
  return [...rows.values()].sort(
    (a, b) =>
      Number(accountResetNotTriggered(b, now)) - Number(accountResetNotTriggered(a, now)) ||
      (a.resetAt ? Date.parse(a.resetAt) : Infinity) -
        (b.resetAt ? Date.parse(b.resetAt) : Infinity) ||
      a.label.localeCompare(b.label),
  );
}

function zonedParts(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}`,
  };
}

/** Convert a recorded wall time without letting the host machine choose its zone. */
export function accountDateTimestamp(
  date: string,
  time: string | undefined,
  timeZone: string,
): number {
  const wall = Date.parse(`${date}T${time ?? "00:00"}:00Z`);
  if (!Number.isFinite(wall) || DateTime.formatIsoDateUtc(DateTime.makeUnsafe(wall)) !== date)
    throw new Error("Choose a valid date and time.");
  let candidate = wall;
  for (let pass = 0; pass < 3; pass += 1) {
    const parts = zonedParts(candidate, timeZone);
    const represented = Date.parse(`${parts.date}T${parts.time}:00Z`);
    const delta = wall - represented;
    if (delta === 0) return candidate;
    candidate += delta;
  }
  throw new Error("That time does not exist in this time zone. Choose a different time.");
}

/** A recurring wall time can land in a DST gap; keep the date visible and order it safely. */
export function accountDateOrder(entry: {
  readonly date: string;
  readonly time?: string | undefined;
  readonly timeZone: string;
}): number {
  try {
    return accountDateTimestamp(entry.date, entry.time, entry.timeZone);
  } catch {
    try {
      return accountDateTimestamp(entry.date, "12:00", entry.timeZone);
    } catch {
      return Date.parse(`${entry.date}T12:00:00Z`);
    }
  }
}

export function accountDateIsPast(date: string, timeZone: string, now: number): boolean {
  return date < zonedParts(now, timeZone).date;
}

/** Recurring billing uses the original day, including after a short month. */
export function nextAccountEventDate(event: LedgerEvent, now: number): string {
  if (event.recurrence === "none") return event.date;
  const today = zonedParts(now, event.timeZone).date;
  if (event.date >= today) return event.date;
  const [year = 0, month = 1, day = 1] = event.date.split("-").map(Number);
  const [currentYear = 0, currentMonth = 1] = today.split("-").map(Number);
  let steps =
    event.recurrence === "yearly"
      ? currentYear - year
      : (currentYear - year) * 12 + currentMonth - month;
  const occurrence = (index: number) => {
    const result = DateTime.makeUnsafe(
      Date.UTC(
        year + (event.recurrence === "yearly" ? index : 0),
        month - 1 + (event.recurrence === "monthly" ? index : 0),
        1,
      ),
    );
    const lastDay = DateTime.toPartsUtc(DateTime.endOf(result, "month")).day;
    return DateTime.formatIsoDateUtc(DateTime.setPartsUtc(result, { day: Math.min(day, lastDay) }));
  };
  if (occurrence(steps) < today) steps += 1;
  return occurrence(steps);
}

export function collectAccountDates(
  presentations: ReadonlyMap<EnvironmentId, AccountsPresentation>,
  accounts: readonly AccountRow[],
  timeZone: string,
  now: number,
): readonly AccountDate[] {
  const dates: AccountDate[] = [];
  const reported = new Set<string>();
  for (const account of accounts) {
    const credits = account.limits?.resetCredits;
    if (!credits) continue;
    const identity = accountIdentity(account.service, account.label);
    // A current ledger is authoritative even when it is empty. Older servers
    // know only the first expiry, so saved later grants are still useful.
    if (
      credits.credits !== undefined &&
      credits.credits.reduce((total, credit) => total + credit.count, 0) >=
        credits.availableCount &&
      credits.credits.every((credit) => credit.expiresAt !== undefined)
    )
      reported.add(identity);
    const entries =
      credits.credits ??
      (credits.nextExpiresAt
        ? [
            {
              id: "next",
              count: credits.availableCount > 0 ? 1 : 0,
              expiresAt: credits.nextExpiresAt,
            },
          ]
        : []);
    for (const credit of entries) {
      if (!credit.expiresAt || credit.count === 0) continue;
      const parts = zonedParts(Date.parse(credit.expiresAt), timeZone);
      dates.push({
        id: `live:${account.id}:${credit.id}`,
        environmentId: account.environmentId,
        service: account.service,
        account: account.label,
        label: "Banked reset expires",
        kind: "bankedReset",
        ...parts,
        timeZone,
        amount:
          credits.credits === undefined
            ? undefined
            : `${credit.count} ${credit.count === 1 ? "credit" : "credits"}`,
        origin: "live",
        saved: undefined,
      });
    }
  }
  for (const [environmentId, presentation] of presentations) {
    for (const [id, event] of Object.entries(
      presentation.serverConfig?.settings.accountLedger.events ?? {},
    )) {
      const eventAccount =
        accounts.find(
          (account) =>
            account.id === event.account && accountService(event.service) === account.service,
        )?.label ?? event.account;
      const identity = eventAccount ? accountIdentity(event.service, eventAccount) : null;
      if (event.kind === "bankedReset" && identity && reported.has(identity)) continue;
      const date = nextAccountEventDate(event, now);
      // When only the oldest expiry is reported, suppress a saved copy of it.
      if (
        event.kind === "bankedReset" &&
        dates.some(
          (entry) =>
            entry.origin === "live" &&
            entry.date === date &&
            entry.account &&
            accountIdentity(entry.service, entry.account) === identity,
        )
      )
        continue;
      let timeUnavailable = false;
      if (event.time) {
        try {
          accountDateTimestamp(date, event.time, event.timeZone);
        } catch {
          timeUnavailable = true;
        }
      }
      dates.push({
        id,
        environmentId,
        service: accountService(event.service),
        account: eventAccount,
        label: event.label,
        kind: event.kind,
        date,
        time: event.time,
        ...(timeUnavailable ? { timeUnavailable: true } : {}),
        timeZone: event.timeZone,
        amount: event.amount,
        origin: "saved",
        saved: event,
      });
    }
  }
  return dates.sort(
    (a, b) =>
      accountDateOrder(a) - accountDateOrder(b) ||
      (a.account ?? a.label).localeCompare(b.account ?? b.label),
  );
}
