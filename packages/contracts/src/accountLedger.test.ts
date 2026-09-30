import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { AccountDate, AccountEvent, AccountLedgerPatch } from "./accountLedger.ts";

const decodeDate = Schema.decodeUnknownSync(AccountDate);
const decodeEvent = Schema.decodeUnknownSync(AccountEvent);
const encodeEvent = Schema.encodeSync(AccountEvent);
const decodeLedgerPatch = Schema.decodeSync(AccountLedgerPatch);
const event = {
  service: "other-service",
  label: "Promotional credits expire",
  kind: "creditExpiry" as const,
  date: "2028-02-29",
  timeZone: "America/Los_Angeles",
};

describe("account dates", () => {
  it("keeps a date-only deadline local and round-trips a leap day", () => {
    const decoded = decodeEvent(event);
    expect(encodeEvent(decoded)).toEqual({ ...event, recurrence: "none" });
    expect(decoded.date).toBe("2028-02-29");
    expect(decoded.time).toBeUndefined();
  });

  it.each(["2027-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "10/22/26"])(
    "rejects invalid calendar date %s instead of silently moving a deadline",
    (date) => {
      expect(() => decodeDate(date)).toThrow();
    },
  );

  it("requires valid times and time zones for dated records", () => {
    expect(() => decodeEvent({ ...event, time: "24:00" })).toThrow();
    expect(() => decodeEvent({ ...event, time: "12:60" })).toThrow();
    expect(() => decodeEvent({ ...event, timeZone: "made-up/time-zone" })).toThrow();
    expect(decodeEvent({ ...event, time: "23:59" }).time).toBe("23:59");
  });

  it("accepts service-wide dates and deletion without an account or invented amount", () => {
    const patch = decodeLedgerPatch({
      events: { promo: event, old: null },
    });
    expect(patch.events?.promo?.account).toBeUndefined();
    expect(patch.events?.promo?.amount).toBeUndefined();
    expect(patch.events?.old).toBeNull();
  });
});
