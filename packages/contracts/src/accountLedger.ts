import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A local calendar date; date-only credit deadlines must never shift with UTC. */
export const AccountDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((value) => {
    const date = DateTime.make(`${value}T00:00:00.000Z`);
    return (
      (Option.isSome(date) && DateTime.formatIsoDateUtc(date.value) === value) ||
      "Expected a valid calendar date (YYYY-MM-DD)."
    );
  }),
);
export type AccountDate = typeof AccountDate.Type;
const isAccountDate = Schema.is(AccountDate);

export const AccountTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/));
export type AccountTime = typeof AccountTime.Type;

export const AccountTimeZone = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) => Option.isSome(DateTime.zoneMakeNamed(value)) || "Expected a supported time zone.",
  ),
);
export type AccountTimeZone = typeof AccountTimeZone.Type;

const AccountResetAt = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  ),
  Schema.makeFilter(
    (value) =>
      (isAccountDate(value.slice(0, 10)) && Option.isSome(DateTime.make(value))) ||
      "Expected an ISO timestamp.",
  ),
);
const AccountLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(500));

/** Keys in `AccountLedger.accounts` own identity; provider usage stays outside this record. */
const AccountRecordFields = {
  service: AccountLabel,
  label: AccountLabel,
  assignees: Schema.optionalKey(
    Schema.Array(AccountLabel).check(
      Schema.makeFilter((people) => new Set(people).size === people.length || "Duplicate person."),
    ),
  ),
  resetAt: Schema.optionalKey(AccountResetAt),
  /** An explicit observation, never inferred from an account reporting 100% remaining. */
  resetNotTriggered: Schema.optionalKey(Schema.Boolean),
  billingDay: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 31 }))),
};
// Existing saved single-person assignments migrate on read; every write uses the list.
export const AccountRecord = Schema.Struct({
  ...AccountRecordFields,
  assignee: Schema.optionalKey(AccountLabel),
}).pipe(
  Schema.decodeTo(
    Schema.Struct(AccountRecordFields),
    SchemaTransformation.transform({
      decode: ({ assignee, ...record }) => ({
        ...record,
        ...(record.assignees === undefined && assignee ? { assignees: [assignee] } : {}),
      }),
      encode: (record) => record,
    }),
  ),
);
export type AccountRecord = typeof AccountRecord.Type;

export const AccountEventKind = Schema.Literals([
  "bankedReset",
  "cloudCredit",
  "creditExpiry",
  "renewal",
  "refresh",
  "reminder",
]);
export type AccountEventKind = typeof AccountEventKind.Type;

export const AccountEventRecurrence = Schema.Literals(["none", "monthly", "yearly"]);
export type AccountEventRecurrence = typeof AccountEventRecurrence.Type;

export const AccountEvent = Schema.Struct({
  service: AccountLabel,
  label: AccountLabel,
  /** An account key or label; omitted for workspace-wide and service-wide dates. */
  account: Schema.optionalKey(AccountLabel),
  kind: AccountEventKind,
  date: AccountDate,
  time: Schema.optionalKey(AccountTime),
  timeZone: AccountTimeZone,
  amount: Schema.optionalKey(AccountLabel),
  recurrence: AccountEventRecurrence.pipe(Schema.withDecodingDefault(Effect.succeed("none"))),
});
export type AccountEvent = typeof AccountEvent.Type;

export const AccountNote = Schema.Struct({
  service: AccountLabel,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
});
export type AccountNote = typeof AccountNote.Type;

/** Server-local annotations shared by every connected client. Never store credentials here. */
export const AccountLedger = Schema.Struct({
  accounts: Schema.Record(TrimmedNonEmptyString, AccountRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  events: Schema.Record(TrimmedNonEmptyString, AccountEvent).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  notes: Schema.Record(TrimmedNonEmptyString, AccountNote).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type AccountLedger = typeof AccountLedger.Type;

/** Replace only the named records, preserving other clients' edits. `null` deletes a record. */
export const AccountLedgerPatch = Schema.Struct({
  accounts: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, Schema.NullOr(AccountRecord))),
  events: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, Schema.NullOr(AccountEvent))),
  notes: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, Schema.NullOr(AccountNote))),
  /** Clear an observed state atomically without replacing a record edited during a provider call. */
  clearResetNotTriggered: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString,
      Schema.Struct({ service: AccountLabel, label: AccountLabel }),
    ),
  ),
});
export type AccountLedgerPatch = typeof AccountLedgerPatch.Type;
