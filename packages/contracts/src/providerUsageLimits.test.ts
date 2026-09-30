import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProviderResetCredits } from "./providerUsageLimits.ts";

const decode = Schema.decodeUnknownSync(ServerProviderResetCredits);
const CreditsJson = Schema.fromJsonString(ServerProviderResetCredits);
const encodeJson = Schema.encodeSync(CreditsJson);
const decodeJson = Schema.decodeUnknownSync(CreditsJson);

describe("ServerProviderResetCredits", () => {
  it("accepts summary-only snapshots from an older server", () => {
    expect(decode({ availableCount: 2, nextExpiresAt: "2026-10-22T00:00:00.000Z" })).toEqual({
      availableCount: 2,
      nextExpiresAt: "2026-10-22T00:00:00.000Z",
    });
  });

  it("preserves grant counts and non-expiring credits across the wire", () => {
    const credits = {
      availableCount: 3,
      credits: [
        { id: "grant_a", count: 2, expiresAt: "2026-10-22T00:00:00.000Z" },
        { id: "grant_b", count: 1 },
      ],
    };
    expect(decodeJson(encodeJson(credits))).toEqual(credits);
  });

  it("keeps valid credit rows when a newer provider returns an unknown detail shape", () => {
    expect(
      decode({
        availableCount: 2,
        credits: [
          { id: "valid", count: 1 },
          { id: "future_shape", amount: 1 },
        ],
      }),
    ).toEqual({ availableCount: 2, credits: [{ id: "valid", count: 1 }] });
  });
});
