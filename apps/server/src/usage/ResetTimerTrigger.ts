import {
  AccountActionError,
  type AccountRecord,
  type ProviderTriggerResetTimerInput,
  type ProviderTriggerResetTimerResult,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeCliproxyResetTimer } from "./cliproxyResetTimer.ts";
import { selectResetTimerModel } from "./resetTimerModels.ts";

export interface ResetTimerObservation {
  readonly driver: string;
  readonly email?: string | undefined;
  readonly usageLimits?: ServerProviderUsageLimits | undefined;
}

export class ResetTimerTrigger extends Context.Service<
  ResetTimerTrigger,
  {
    readonly trigger: (
      input: ProviderTriggerResetTimerInput,
    ) => Effect.Effect<ProviderTriggerResetTimerResult, AccountActionError>;
    readonly reconcile: (observations: ReadonlyArray<ResetTimerObservation>) => Effect.Effect<void>;
  }
>()("t3/usage/ResetTimerTrigger") {}

const normalize = (value: string) => value.trim().toLowerCase();
const isAccountActionError = Schema.is(AccountActionError);
const actionError = (cause: unknown) =>
  isAccountActionError(cause)
    ? cause
    : new AccountActionError({
        detail: "The account action could not be completed. Refresh its limits before retrying.",
      });

interface PreparedTrigger {
  readonly model: string;
  readonly send: Effect.Effect<void, AccountActionError>;
  readonly refresh: Effect.Effect<ServerProviderUsageLimits | undefined, AccountActionError>;
}

function serviceDriver(record: AccountRecord): string | undefined {
  const service = normalize(record.service).replaceAll(" ", "");
  return service === "codex"
    ? "codex"
    : service === "claudecode" || service === "claude"
      ? "claudeAgent"
      : undefined;
}

export function hasActiveWeeklyTimer(
  driver: string,
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): boolean {
  const weekly = accountWeeklyWindow(driver, limits);
  return Boolean(weekly?.resetsAt && Date.parse(weekly.resetsAt) > now);
}

function accountWeeklyWindow(driver: string, limits: ServerProviderUsageLimits | undefined) {
  return limits?.windows.find(
    (window) =>
      window.kind === "weekly" &&
      (driver === "claudeAgent"
        ? window.id === "seven_day"
        : window.id === "primary" || window.id === "secondary"),
  );
}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const settings = yield* ServerSettingsService;
  const hub = yield* makeCliproxyResetTimer;
  const active = yield* Ref.make<ReadonlySet<string>>(new Set());

  const reconcile: ResetTimerTrigger["Service"]["reconcile"] = Effect.fn(
    "ResetTimerTrigger.reconcile",
  )(
    function* (observations) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const confirmed = new Set(
        observations.flatMap((observation) =>
          observation.email &&
          !observation.usageLimits?.unavailable &&
          hasActiveWeeklyTimer(observation.driver, observation.usageLimits, now)
            ? [`${observation.driver}:${normalize(observation.email)}`]
            : [],
        ),
      );
      if (confirmed.size === 0) return;
      const saved = yield* settings.getSettings;
      const clearResetNotTriggered = Object.fromEntries(
        Object.entries(saved.accountLedger.accounts).flatMap(([id, record]) => {
          const driver = serviceDriver(record);
          return record.resetNotTriggered &&
            driver &&
            confirmed.has(`${driver}:${normalize(record.label)}`)
            ? [[id, { service: record.service, label: record.label }]]
            : [];
        }),
      );
      if (Object.keys(clearResetNotTriggered).length === 0) return;
      yield* settings.updateSettings({ accountLedger: { clearResetNotTriggered } });
    },
    Effect.catch(() => Effect.logWarning("Saved reset observations could not be reconciled.")),
  );

  const validate = Effect.fn("ResetTimerTrigger.validate")(function* (
    input: ProviderTriggerResetTimerInput,
    record: AccountRecord,
    driver: string,
    email: string | undefined,
    limits: ServerProviderUsageLimits | undefined,
  ) {
    if (
      serviceDriver(record) !== driver ||
      !email ||
      normalize(record.label) !== normalize(email)
    ) {
      return yield* new AccountActionError({
        detail:
          "The saved account does not match the selected signed-in account. Refresh and check its identity.",
      });
    }
    if (input.expectedAccountEmail && normalize(input.expectedAccountEmail) !== normalize(email)) {
      return yield* new AccountActionError({
        detail: "The signed-in account changed. Refresh before triggering.",
      });
    }
    if (
      input.expectedCredentialFingerprint &&
      input.expectedCredentialFingerprint !== limits?.credentialFingerprint
    ) {
      return yield* new AccountActionError({
        detail: "The credentials changed. Refresh before triggering.",
      });
    }
    if (!limits || limits.unavailable || !accountWeeklyWindow(driver, limits)) {
      return yield* new AccountActionError({
        detail: "Fresh weekly limits are required to trigger this account safely.",
      });
    }
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (hasActiveWeeklyTimer(driver, limits, now)) {
      return yield* new AccountActionError({
        detail: "This account already has an active weekly timer. Refresh the saved reset state.",
      });
    }
    const weekly = accountWeeklyWindow(driver, limits);
    if (weekly && weekly.usedPercent > 0) {
      return yield* new AccountActionError({
        detail: "The provider has not confirmed a fresh allowance for this account.",
      });
    }
  });

  const clearConfirmedFlag = Effect.fn("ResetTimerTrigger.clearConfirmedFlag")(function* (
    input: ProviderTriggerResetTimerInput,
    record: AccountRecord,
  ) {
    // The settings reducer clears only the current matching record under its write lock.
    yield* settings.updateSettings({
      accountLedger: {
        clearResetNotTriggered: {
          [input.ledgerAccountId]: { service: record.service, label: record.label },
        },
      },
    });
  });

  const trigger: ResetTimerTrigger["Service"]["trigger"] = Effect.fn("ResetTimerTrigger.trigger")(
    function* (input) {
      const saved = yield* settings.getSettings;
      const record = saved.accountLedger.accounts[input.ledgerAccountId];
      if (!record?.resetNotTriggered || !serviceDriver(record)) {
        return yield* new AccountActionError({
          detail: "First confirm that this account reset and its timer has not started.",
        });
      }
      const accountKey = `${serviceDriver(record)}:${normalize(record.label)}`;
      const acquire = Ref.modify(active, (current) => {
        if (current.has(accountKey)) return [false, current] as const;
        return [true, new Set([...current, accountKey])] as const;
      }).pipe(
        Effect.flatMap((acquired) =>
          acquired
            ? Effect.void
            : Effect.fail(
                new AccountActionError({
                  detail: "A test message is already running for this account.",
                }),
              ),
        ),
      );

      const operation = Effect.gen(function* () {
        // Preparing the selected instance/source never routes through a provider pool.
        const prepared: PreparedTrigger =
          "instanceId" in input
            ? yield* Effect.gen(function* () {
                const instance = yield* registry.getInstance(input.instanceId);
                if (!instance?.enabled || !instance.triggerResetTimer) {
                  return yield* new AccountActionError({
                    detail:
                      "This provider instance is missing, disabled, or cannot trigger a timer.",
                  });
                }
                const before = (yield* instance.snapshot.getSnapshot).usageLimits?.checkedAt;
                yield* instance.invalidateCaches ?? Effect.void;
                const current = yield* instance.snapshot.refresh;
                if (
                  !current.enabled ||
                  current.auth.status !== "authenticated" ||
                  !current.installed
                ) {
                  return yield* new AccountActionError({
                    detail: "The selected provider is not signed in and ready.",
                  });
                }
                if (current.usageLimits?.checkedAt === before) {
                  return yield* new AccountActionError({
                    detail:
                      "The provider could not refresh this account's limits. Try Refresh first.",
                  });
                }
                yield* validate(
                  input,
                  record,
                  current.driver,
                  current.auth.email,
                  current.usageLimits,
                );
                const model = selectResetTimerModel(current.driver, current.models);
                if (!model)
                  return yield* new AccountActionError({
                    detail:
                      "This account did not report a supported small model. No larger model will be selected automatically.",
                  });
                const email = current.auth.email!;
                return {
                  model: model.slug,
                  send: instance
                    .triggerResetTimer({ model: model.slug, expectedAccountEmail: email })
                    .pipe(Effect.mapError(actionError)),
                  refresh: Effect.gen(function* () {
                    yield* instance.invalidateCaches ?? Effect.void;
                    const after = yield* instance.snapshot.refresh;
                    if (normalize(after.auth.email ?? "") !== normalize(email)) {
                      return yield* new AccountActionError({
                        detail: "The provider login changed during the test message.",
                      });
                    }
                    if (
                      after.usageLimits?.checkedAt === current.usageLimits?.checkedAt ||
                      after.usageLimits?.unavailable
                    ) {
                      return undefined;
                    }
                    return after.usageLimits;
                  }),
                };
              })
            : yield* Effect.gen(function* () {
                const config = saved.usageLimitSources[input.sourceId];
                if (!config?.enabled || !config.managementKey) {
                  return yield* new AccountActionError({
                    detail: "The selected usage source is missing or disabled.",
                  });
                }
                const prepared = yield* hub.prepare(config, input.accountId);
                yield* validate(
                  input,
                  record,
                  prepared.current.driver,
                  prepared.current.email,
                  prepared.current.usageLimits,
                );
                return {
                  ...prepared,
                  send: prepared.send.pipe(Effect.mapError(actionError)),
                  refresh: prepared.refresh.pipe(
                    Effect.map((account) => account.usageLimits),
                    Effect.mapError(actionError),
                  ),
                };
              });
        // Never retry inference automatically, even when the provider might have accepted it.
        const latest = (yield* settings.getSettings).accountLedger.accounts[input.ledgerAccountId];
        if (
          !latest?.resetNotTriggered ||
          latest.service !== record.service ||
          latest.label !== record.label
        ) {
          return yield* new AccountActionError({
            detail:
              "The saved reset observation changed while preparing the message. Refresh before triggering.",
          });
        }
        const sent = yield* prepared.send.pipe(Effect.result);
        const observed = yield* prepared.refresh.pipe(Effect.result);
        const limits =
          observed._tag === "Success" && !observed.success?.unavailable
            ? observed.success
            : undefined;
        const confirmed = hasActiveWeeklyTimer(
          serviceDriver(record)!,
          limits,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        if (confirmed) yield* clearConfirmedFlag(input, record);
        if (sent._tag === "Failure" && !confirmed) {
          return yield* new AccountActionError({
            detail:
              "The test message could not be confirmed. Its limits were re-read; check this account before explicitly retrying.",
          });
        }
        return {
          model: prepared.model,
          ...(limits ? { limits } : {}),
          ...(!confirmed
            ? {
                warning:
                  "Test message sent, but the provider has not reported a new weekly timer. Refresh before retrying; the saved reset state is unchanged.",
              }
            : sent._tag === "Failure"
              ? {
                  warning:
                    "The message response was interrupted, but the provider confirmed the new weekly timer.",
                }
              : {}),
        };
      });
      return yield* Effect.acquireUseRelease(
        acquire,
        () => operation,
        () =>
          Ref.update(active, (current) => {
            const next = new Set(current);
            next.delete(accountKey);
            return next;
          }),
      );
    },
    Effect.mapError(actionError),
  );

  return { trigger, reconcile } satisfies ResetTimerTrigger["Service"];
});

export const layer = Layer.effect(ResetTimerTrigger, make);
