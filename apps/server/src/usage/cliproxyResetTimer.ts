import { AccountActionError, type UsageLimitSourceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import {
  codexResetTimerBody,
  didCodexInferenceComplete,
} from "../provider/Drivers/ResetTimerInference.ts";
import { resolveCodexReleaseAsset } from "../provider/CodexInstallation.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { selectResetTimerModel } from "./resetTimerModels.ts";

const Catalog = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.NonEmptyString,
      display_name: Schema.NonEmptyString,
      visibility: Schema.optional(Schema.String),
      supported_reasoning_levels: Schema.Array(Schema.Struct({ effort: Schema.String })),
    }),
  ),
});
const decodeCatalog = Schema.decodeEffect(Schema.fromJsonString(Catalog));

export const makeCliproxyResetTimer = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const resolveAccount = Effect.fn("CliproxyResetTimer.resolveAccount")(function* (
    config: UsageLimitSourceConfig,
    accountId: string,
  ) {
    const account = (yield* api.authFiles(config)).find((candidate) => candidate.id === accountId);
    if (!account || account.disabled || account.provider !== "codex" || !account.email) {
      return yield* new AccountActionError({
        detail:
          "This hub account cannot trigger a timer. Only an enabled, explicitly identified Codex account is supported.",
      });
    }
    return account;
  });

  const prepare = Effect.fn("CliproxyResetTimer.prepare")(function* (
    config: UsageLimitSourceConfig,
    accountId: string,
  ) {
    const account = yield* resolveAccount(config, accountId);
    const current = yield* api.readAccount(config, account);
    const version = resolveCodexReleaseAsset(platform, arch)?.version;
    if (!version)
      return yield* new AccountActionError({
        detail: "This host has no supported Codex protocol version for model discovery.",
      });
    const catalogBody = yield* api.apiCall(
      config,
      account,
      `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`,
    );
    const catalog = yield* decodeCatalog(catalogBody);
    const models = catalog.models
      .filter((model) => model.visibility === undefined || model.visibility === "list")
      .map((model) => ({
        slug: model.slug,
        name: model.display_name,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select" as const,
              options: model.supported_reasoning_levels.map((effort) => ({
                id: effort.effort,
                label: effort.effort,
              })),
            },
          ],
        },
      }));
    const model = selectResetTimerModel("codex", models);
    if (!model) {
      return yield* new AccountActionError({
        detail: "The selected hub account did not report a small model supporting Low reasoning.",
      });
    }
    const send = Effect.gen(function* () {
      // Re-read the index immediately before sending; an edited auth file must not route elsewhere.
      const latest = yield* resolveAccount(config, accountId);
      if (latest.auth_index !== account.auth_index || latest.email !== account.email) {
        return yield* new AccountActionError({
          detail: "The hub login changed. Refresh before triggering.",
        });
      }
      const body = yield* api.apiCall(
        config,
        latest,
        "https://chatgpt.com/backend-api/codex/responses",
        codexResetTimerBody(model.slug),
      );
      if (!didCodexInferenceComplete(body)) {
        return yield* new AccountActionError({
          detail: "The hub did not confirm completion. Refresh its limits before retrying.",
        });
      }
    }).pipe(Effect.timeout("60 seconds"));
    return {
      current,
      model: model.slug,
      send,
      refresh: Effect.gen(function* () {
        const latest = yield* resolveAccount(config, accountId);
        if (latest.auth_index !== account.auth_index || latest.email !== account.email) {
          return yield* new AccountActionError({
            detail: "The hub login changed during the test message.",
          });
        }
        return yield* api.readAccount(config, latest);
      }),
    };
  });
  return { prepare };
});
