import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LINEAR_ALERT_SNAPSHOT_NOTICE =
  "Linear alerts describe the balance or condition when they were raised. They do not report a current credit balance or every credit expiration.";

export const LinearAccountAlert = Schema.Struct({
  id: TrimmedNonEmptyString,
  type: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  resolvedAt: Schema.optional(IsoDateTime),
  /** An opaque snapshot, not a live balance or a credit ledger. */
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
});
export type LinearAccountAlert = typeof LinearAccountAlert.Type;

export const LinearAccountsSnapshot = Schema.Struct({
  checkedAt: IsoDateTime,
  workspace: Schema.optional(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      name: TrimmedNonEmptyString,
      /** Subscription billing, not a credit expiry or allowance refresh. */
      nextBillingAt: Schema.optional(IsoDateTime),
    }),
  ),
  alerts: Schema.Array(LinearAccountAlert),
  /** Safe credential, request, permission, or incomplete-pagination notice. */
  unavailable: Schema.optional(TrimmedNonEmptyString),
});
export type LinearAccountsSnapshot = typeof LinearAccountsSnapshot.Type;
