import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

const AccountActionIdentity = {
  /** Pins this action to the saved account identity. */
  ledgerAccountId: TrimmedNonEmptyString,
  expectedAccountEmail: Schema.optional(TrimmedNonEmptyString),
  expectedCredentialFingerprint: Schema.optional(TrimmedNonEmptyString),
};

export const ProviderTriggerResetTimerInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId, ...AccountActionIdentity }),
  Schema.Struct({
    sourceId: UsageLimitSourceId,
    accountId: TrimmedNonEmptyString,
    ...AccountActionIdentity,
  }),
]);
export type ProviderTriggerResetTimerInput = typeof ProviderTriggerResetTimerInput.Type;

export const ProviderTriggerResetTimerResult = Schema.Struct({
  model: TrimmedNonEmptyString,
  /** Only a fresh provider observation can establish the new timer. */
  limits: Schema.optional(ServerProviderUsageLimits),
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderTriggerResetTimerResult = typeof ProviderTriggerResetTimerResult.Type;

export class AccountActionError extends Schema.TaggedError<AccountActionError>()(
  "AccountActionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
