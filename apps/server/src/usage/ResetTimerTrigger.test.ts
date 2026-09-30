import { describe, expect, it } from "@effect/vitest";
import {
  AccountActionError,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  ServerSettingsError,
  type ServerProviderModel,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderDriverError } from "../provider/Errors.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { make } from "./ResetTimerTrigger.ts";

const instanceId = ProviderInstanceId.make("test-codex");
const input = { instanceId, ledgerAccountId: "alice", expectedAccountEmail: "alice@example.com" };
const smallModel: ServerProviderModel = {
  slug: "gpt-6-luna",
  name: "Luna",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "low", label: "Low" }],
      },
    ],
  },
};
const unused = () => Effect.die("The trigger action must not open a project session.");
const decodeServerProvider = Schema.decodeSync(ServerProvider);

const fixture = Effect.fnUntraced(function* (
  options: {
    enabled?: boolean;
    email?: string;
    models?: ReadonlyArray<ServerProviderModel>;
    activeTimer?: boolean;
    observedReset?: boolean;
    send?: Effect.Effect<void, AccountActionError>;
    confirmTimer?: boolean;
    driver?: "codex" | "claudeAgent";
    weeklyWindows?: ServerProviderUsageLimits["windows"];
    settingsFailure?: "read" | "write";
  } = {},
) {
  const settings = yield* ServerSettingsService;
  const driver = options.driver ?? "codex";
  const testModel =
    driver === "claudeAgent" ? { ...smallModel, slug: "claude-haiku-4-5" } : smallModel;
  yield* settings.updateSettings({
    accountLedger: {
      accounts: {
        alice: {
          service: driver === "codex" ? "Codex" : "Claude Code",
          label: "alice@example.com",
          resetNotTriggered: options.observedReset ?? true,
        },
      },
    },
  });
  let refreshes = 0;
  let sent = 0;
  let timer = options.activeTimer ?? false;
  const snapshot = () =>
    decodeServerProvider({
      instanceId,
      driver,
      enabled: options.enabled ?? true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated", email: options.email ?? "alice@example.com" },
      checkedAt: `1970-01-01T00:00:00.${String(refreshes).padStart(3, "0")}Z`,
      models: options.models ?? [testModel],
      usageLimits: {
        checkedAt: `1970-01-01T00:00:00.${String(refreshes).padStart(3, "0")}Z`,
        windows:
          !timer && options.weeklyWindows
            ? options.weeklyWindows
            : [
                {
                  id: driver === "codex" ? "secondary" : "seven_day",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 0,
                  ...(timer ? { resetsAt: "2099-01-01T00:00:00Z" } : {}),
                },
              ],
      },
    });
  const instance: ProviderInstance = {
    instanceId,
    driverKind: ProviderDriverKind.make(driver),
    continuationIdentity: { driverKind: ProviderDriverKind.make("codex"), continuationKey: "test" },
    displayName: undefined,
    enabled: options.enabled ?? true,
    snapshot: {
      getSnapshot: Effect.sync(snapshot),
      refresh: Effect.sync(() => {
        refreshes += 1;
        return snapshot();
      }),
      streamChanges: Stream.empty,
      resolveMaintenance: unused,
      applyUsageLimits: unused,
    },
    triggerResetTimer: ({ model }) =>
      Effect.gen(function* () {
        expect(model).toBe(testModel.slug);
        sent += 1;
        yield* (options.send ?? Effect.void).pipe(
          Effect.mapError(
            () =>
              new ProviderDriverError({
                driver: "codex",
                instanceId,
                detail: "Interrupted response",
              }),
          ),
        );
        if (options.confirmTimer ?? true) timer = true;
      }),
    adapter: {
      provider: ProviderDriverKind.make("codex"),
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession: unused,
      sendTurn: unused,
      interruptTurn: unused,
      respondToRequest: unused,
      respondToUserInput: unused,
      stopSession: unused,
      listSessions: unused,
      hasSession: unused,
      readThread: unused,
      rollbackThread: unused,
      stopAll: unused,
      streamEvents: Stream.empty,
    },
    textGeneration: {
      generateCommitMessage: unused,
      generatePrContent: unused,
      generateBranchName: unused,
      generateThreadTitle: unused,
    },
  };
  const service = yield* make.pipe(
    Effect.provideService(ServerSettingsService, {
      ...settings,
      getSettings:
        options.settingsFailure === "read"
          ? Effect.fail(
              new ServerSettingsError({
                settingsPath: "fixture",
                operation: "read-file",
                cause: "Unavailable",
              }),
            )
          : settings.getSettings,
      updateSettings: (patch) =>
        options.settingsFailure === "write"
          ? Effect.fail(
              new ServerSettingsError({
                settingsPath: "fixture",
                operation: "write-file",
                cause: "Unavailable",
              }),
            )
          : settings.updateSettings(patch),
    }),
    Effect.provideService(ProviderInstanceRegistry, {
      getInstance: (id) => Effect.succeed(id === instanceId ? instance : undefined),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: unused(),
    }),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("No live HTTP requests in native trigger tests.")),
    ),
  );
  return { service, settings, sent: () => sent, refreshes: () => refreshes };
});

describe("ResetTimerTrigger", () => {
  it.effect("sends only after a saved reset observation and saves only the reported timer", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const result = yield* test.service.trigger(input);
      expect(result.model).toBe("gpt-6-luna");
      expect(result.limits?.windows[0]?.resetsAt).toBe("2099-01-01T00:00:00Z");
      expect(test.sent()).toBe(1);
      expect(
        (yield* test.settings.getSettings).accountLedger.accounts.alice?.resetNotTriggered,
      ).toBe(false);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("does not infer a reset from 100% remaining", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ observedReset: false });
      expect((yield* test.service.trigger(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(test.sent()).toBe(0);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("rejects a mismatched signed-in account", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ email: "bob@example.com" });
      const result = yield* test.service.trigger(input).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.sent()).toBe(0);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("rejects a disabled instance", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ enabled: false });
      expect((yield* test.service.trigger(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(test.sent()).toBe(0);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("does not substitute a large model when no small model is reported", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ models: [{ ...smallModel, slug: "gpt-6-astra" }] });
      expect((yield* test.service.trigger(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(test.sent()).toBe(0);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("refuses a duplicate after the provider reports an active timer even at 0% usage", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ activeTimer: true });
      expect((yield* test.service.trigger(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(test.sent()).toBe(0);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("rejects concurrent sends instead of queueing another test message", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = yield* fixture({
        send: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      const first = yield* test.service.trigger(input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect((yield* test.service.trigger(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(test.sent()).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("re-reads quota after an ambiguous failure without resending", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        send: Effect.fail(new AccountActionError({ detail: "Interrupted response" })),
      });
      expect((yield* test.service.trigger(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(test.sent()).toBe(1);
      expect(test.refreshes()).toBe(2);
      expect(
        (yield* test.settings.getSettings).accountLedger.accounts.alice?.resetNotTriggered,
      ).toBe(true);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("releases the in-flight account lock when the caller is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = yield* fixture({
        send: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      const first = yield* test.service.trigger(input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, undefined);
      const retried = yield* test.service.trigger(input);
      expect(retried.limits?.windows[0]?.resetsAt).toBe("2099-01-01T00:00:00Z");
      expect(test.sent()).toBe(2);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("preserves concurrent assignment edits when clearing the confirmed reset flag", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const test = yield* fixture({
        send: settings
          .updateSettings({
            accountLedger: {
              accounts: {
                alice: {
                  service: "Codex",
                  label: "alice@example.com",
                  assignee: "Changed during inference",
                  resetNotTriggered: true,
                },
              },
            },
          })
          .pipe(
            Effect.asVoid,
            Effect.mapError(() => new AccountActionError({ detail: "Settings write failed" })),
          ),
      });
      yield* test.service.trigger(input);
      expect((yield* settings.getSettings).accountLedger.accounts.alice?.assignee).toBe(
        "Changed during inference",
      );
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("starts Claude's account-wide weekly timer even when a model bucket is active", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        driver: "claudeAgent",
        weeklyWindows: [
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 0 },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Fable",
            usedPercent: 50,
            resetsAt: "2099-01-01T00:00:00Z",
          },
        ],
      });
      const result = yield* test.service.trigger(input);
      expect(result.model).toBe("claude-haiku-4-5");
      expect(test.sent()).toBe(1);
      expect(
        (yield* test.settings.getSettings).accountLedger.accounts.alice?.resetNotTriggered,
      ).toBe(false);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("does not confirm Claude's timer using a model-scoped weekly bucket", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        driver: "claudeAgent",
        confirmTimer: false,
        weeklyWindows: [
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 0 },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Fable",
            usedPercent: 50,
            resetsAt: "2099-01-01T00:00:00Z",
          },
        ],
      });
      const result = yield* test.service.trigger(input);
      expect(result.warning).toBeDefined();
      expect(
        (yield* test.settings.getSettings).accountLedger.accounts.alice?.resetNotTriggered,
      ).toBe(true);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("requires Claude's account-wide weekly bucket before sending", () =>
    Effect.gen(function* () {
      const test = yield* fixture({
        driver: "claudeAgent",
        weeklyWindows: [{ id: "seven_day_fable", kind: "weekly", label: "Fable", usedPercent: 0 }],
      });
      expect((yield* test.service.trigger(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(test.sent()).toBe(0);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect(
    "permanently clears a reset observation when regular quota refresh confirms its timer",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture();
        yield* test.settings.updateSettings({
          accountLedger: {
            accounts: {
              alice: {
                service: "Codex",
                label: "alice@example.com",
                assignee: "Edited assignment",
                resetNotTriggered: true,
              },
            },
          },
        });
        yield* test.service.reconcile([
          {
            driver: "codex",
            email: "ALICE@example.com",
            usageLimits: {
              checkedAt: "1970-01-01T00:00:01Z",
              windows: [
                {
                  id: "secondary",
                  kind: "weekly",
                  label: "Weekly",
                  usedPercent: 0,
                  resetsAt: "2099-01-01T00:00:00Z",
                },
              ],
            },
          },
        ]);
        const record = (yield* test.settings.getSettings).accountLedger.accounts.alice;
        expect(record?.resetNotTriggered).toBe(false);
        expect(record?.assignee).toBe("Edited assignment");
        yield* test.service.reconcile([
          {
            driver: "codex",
            email: "alice@example.com",
            usageLimits: {
              checkedAt: "1970-01-01T00:00:02Z",
              windows: [{ id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 0 }],
            },
          },
        ]);
        expect(
          (yield* test.settings.getSettings).accountLedger.accounts.alice?.resetNotTriggered,
        ).toBe(false);
        expect(test.sent()).toBe(0);
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("does not reconcile unavailable, expired, or mismatched account observations", () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const active = {
        checkedAt: "1970-01-01T00:00:01Z",
        windows: [
          {
            id: "secondary",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: 0,
            resetsAt: "2099-01-01T00:00:00Z",
          },
        ],
      };
      yield* test.service.reconcile([
        {
          driver: "codex",
          email: "alice@example.com",
          usageLimits: { ...active, unavailable: { reason: "probeFailed" } },
        },
        { driver: "codex", email: "bob@example.com", usageLimits: active },
        { driver: "claudeAgent", email: "alice@example.com", usageLimits: active },
        {
          driver: "codex",
          email: "alice@example.com",
          usageLimits: {
            ...active,
            windows: [{ ...active.windows[0]!, resetsAt: "1969-01-01T00:00:00Z" }],
          },
        },
      ]);
      expect(
        (yield* test.settings.getSettings).accountLedger.accounts.alice?.resetNotTriggered,
      ).toBe(true);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  it.effect("does not reconcile Claude's reset flag from model-scoped weekly timers", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ driver: "claudeAgent" });
      yield* test.service.reconcile([
        {
          driver: "claudeAgent",
          email: "alice@example.com",
          usageLimits: {
            checkedAt: "1970-01-01T00:00:01Z",
            windows: [
              { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 0 },
              {
                id: "seven_day_fable",
                kind: "weekly",
                label: "Fable",
                usedPercent: 50,
                resetsAt: "2099-01-01T00:00:00Z",
              },
            ],
          },
        },
      ]);
      expect(
        (yield* test.settings.getSettings).accountLedger.accounts.alice?.resetNotTriggered,
      ).toBe(true);
    }).pipe(Effect.provide(ServerSettingsService.layerTest())),
  );

  for (const settingsFailure of ["read", "write"] as const) {
    it.effect(`keeps quota observation successful when settings ${settingsFailure} fails`, () =>
      Effect.gen(function* () {
        const test = yield* fixture({ settingsFailure });
        const result = yield* test.service
          .reconcile([
            {
              driver: "codex",
              email: "alice@example.com",
              usageLimits: {
                checkedAt: "1970-01-01T00:00:01Z",
                windows: [
                  {
                    id: "secondary",
                    kind: "weekly",
                    label: "Weekly",
                    usedPercent: 0,
                    resetsAt: "2099-01-01T00:00:00Z",
                  },
                ],
              },
            },
          ])
          .pipe(Effect.result);
        expect(result._tag).toBe("Success");
        expect(
          (yield* test.settings.getSettings).accountLedger.accounts.alice?.resetNotTriggered,
        ).toBe(true);
      }).pipe(Effect.provide(ServerSettingsService.layerTest())),
    );
  }
});
