import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  accountDateTimestamp,
  accountLedgerContainsPatch,
  accountResetNotTriggered,
  primaryAccountWindow,
  collectAccounts,
  collectAccountDates,
  moveAccountPill,
  accountPillRow,
  accountPillRowKey,
  accountPillPatch,
  type AccountPillRow,
  nextAccountEventDate,
  type AccountLedger,
  type AccountRow,
  type AccountsPresentation,
  type LedgerEvent,
} from "./accounts.ts";

const now = Date.parse("2026-09-29T20:00:00Z");
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const limits: ServerProviderUsageLimits = {
  checkedAt: "2026-09-29T20:00:00Z",
  windows: [
    {
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 100,
      resetsAt: "2026-10-03T19:00:00Z",
    },
  ],
};
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "person@example.test" },
    checkedAt: limits.checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: limits,
    ...overrides,
  };
}
function presentation(
  providers: readonly ServerProvider[] = [provider()],
  ledger: Partial<AccountLedger> = {},
): AccountsPresentation {
  return {
    entry: { target: { label: "Test" } },
    connection: { phase: "connected" },
    serverConfig: {
      providers,
      settings: { accountLedger: { accounts: {}, events: {}, notes: {}, ...ledger } },
    },
  };
}
const creditEvent = (date: string, overrides: Partial<LedgerEvent> = {}): LedgerEvent => ({
  service: "Codex",
  account: "person@example.test",
  label: "Banked reset expires",
  kind: "bankedReset",
  date,
  timeZone: "America/Los_Angeles",
  recurrence: "none",
  ...overrides,
});
const collectDates = (map: ReadonlyMap<EnvironmentId, AccountsPresentation>) =>
  collectAccountDates(map, collectAccounts(map, now), "America/Los_Angeles", now);

it("uses Cursor's overall monthly allowance ahead of individual model groups", () => {
  const overall = {
    id: "totalPercentUsed",
    kind: "monthly" as const,
    label: "Overall",
    usedPercent: 8.5,
    resetsAt: "2026-10-20T05:04:58Z",
  };
  const cursorLimits = {
    checkedAt: limits.checkedAt,
    windows: [
      { ...overall, id: "apiPercentUsed", label: "Other Models", usedPercent: 1.1 },
      { ...overall, id: "autoPercentUsed", label: "Cursor Models", usedPercent: 9.7 },
      overall,
    ],
  };
  expect(primaryAccountWindow(cursorLimits)).toBe(overall);
});

describe("Accounts view selection", () => {
  it("keeps signed-in accounts when usage is unavailable and never creates a fresh-reset state from 100%", () => {
    const rows = collectAccounts(
      new Map([
        [
          local,
          presentation([
            provider({ usageLimits: undefined }),
            provider({
              instanceId: ProviderInstanceId.make("other"),
              auth: { status: "authenticated", email: "full@example.test" },
              usageLimits: {
                ...limits,
                windows: [{ ...limits.windows[0]!, usedPercent: 0, resetsAt: undefined }],
              },
            }),
          ]),
        ],
      ]),
      now,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.label === "person@example.test")?.limits).toBeUndefined();
    expect(
      rows.find((row) => row.label === "full@example.test")?.saved?.resetNotTriggered,
    ).toBeUndefined();
    expect(rows.find((row) => row.label === "full@example.test")?.resetAt).toBeUndefined();
  });

  it("joins saved assignments to native accounts, prefers a reported reset, and orders soonest resets first", () => {
    const map = new Map([
      [
        local,
        presentation(
          [
            provider(),
            provider({
              instanceId: ProviderInstanceId.make("later"),
              auth: { status: "authenticated", email: "later@example.test" },
              usageLimits: {
                ...limits,
                windows: [{ ...limits.windows[0]!, resetsAt: "2026-10-06T21:00:00Z" }],
              },
            }),
          ],
          {
            accounts: {
              person: {
                service: "codex",
                label: "PERSON@example.test",
                assignees: ["Alex"],
                resetAt: "2026-10-01T00:00:00Z",
              },
            },
          },
        ),
      ],
    ]);
    const rows = collectAccounts(map, now);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: "person",
      label: "person@example.test",
      resetAt: "2026-10-03T19:00:00Z",
      resetSource: "live",
      saved: { assignees: ["Alex"] },
    });
    expect(rows[1]?.label).toBe("later@example.test");
  });

  it("deduplicates accounts across environments with the newest usage and the annotation-owner route", () => {
    const map = new Map([
      [
        local,
        presentation([provider()], {
          accounts: {
            person: { service: "Codex", label: "person@example.test", resetNotTriggered: true },
          },
        }),
      ],
      [
        remote,
        presentation([
          provider({
            usageLimits: {
              ...limits,
              checkedAt: "2026-09-29T21:00:00Z",
              windows: [{ ...limits.windows[0]!, usedPercent: 30 }],
            },
          }),
        ]),
      ],
    ]);
    const rows = collectAccounts(map, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.limits?.windows[0]?.usedPercent).toBe(30);
    expect(rows[0]?.environmentId).toBe(local);
    expect(rows[0]?.trigger?.environmentId).toBe(local);
  });

  it.each(["probeFailed", "unsupported"] as const)(
    "keeps a successful zero reading when a second connection reports %s, while refreshing spent credits",
    (reason) => {
      const good = provider({ usageLimits: { ...limits, resetCredits: { availableCount: 2 } } });
      const failed = provider({
        instanceId: ProviderInstanceId.make("other"),
        usageLimits: {
          checkedAt: "2026-09-29T21:00:00Z",
          windows: [],
          unavailable: { reason },
          resetCredits: { availableCount: 0, credits: [] },
        },
      });
      for (const providers of [
        [good, failed],
        [failed, good],
      ]) {
        for (const ledger of [
          {},
          { accounts: { person: { service: "Codex", label: "person@example.test" } } },
        ]) {
          const rows = collectAccounts(new Map([[local, presentation(providers, ledger)]]), now);
          expect(rows).toHaveLength(1);
          expect(rows[0]?.limits?.windows[0]?.usedPercent).toBe(100);
          expect(rows[0]?.limits?.checkedAt).toBe(limits.checkedAt);
          expect(rows[0]?.limits?.unavailable).toBeUndefined();
          expect(rows[0]?.limits?.resetCredits?.availableCount).toBe(0);
          expect(rows[0]?.trigger?.input).toEqual({ instanceId: good.instanceId });
        }
      }
    },
  );

  it("never routes a manual-only account or borrows another environment's confirmation", () => {
    const map = new Map([
      [
        local,
        presentation([], {
          accounts: {
            manual: { service: "Codex", label: "manual@example.test", resetNotTriggered: true },
            person: { service: "Codex", label: "person@example.test", resetNotTriggered: true },
          },
        }),
      ],
      [remote, presentation()],
    ]);
    expect(collectAccounts(map, now).every((account) => account.trigger === null)).toBe(true);
  });

  it("gives a hub account an exact source/account route even without banked credits", () => {
    const item = presentation([]);
    const map = new Map([
      [
        local,
        {
          ...item,
          serverConfig: {
            ...item.serverConfig!,
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("pool"),
                kind: "cliproxy" as const,
                label: "Pool",
                checkedAt: limits.checkedAt,
                accounts: [
                  {
                    id: "account-file",
                    driver: ProviderDriverKind.make("codex"),
                    email: "person@example.test",
                    usageLimits: limits,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(collectAccounts(map, now)[0]?.trigger?.input).toEqual({
      sourceId: "pool",
      accountId: "account-file",
    });
  });
});

describe("Banked credit dates", () => {
  it("shows every reported grant and avoids counting saved copies of a complete ledger", () => {
    const map = new Map([
      [
        local,
        presentation(
          [
            provider({
              usageLimits: {
                ...limits,
                resetCredits: {
                  availableCount: 2,
                  credits: [
                    { id: "first", count: 1, expiresAt: "2026-10-22T20:00:00Z" },
                    { id: "second", count: 1, expiresAt: "2026-10-29T20:00:00Z" },
                  ],
                },
              },
            }),
          ],
          { events: { first: creditEvent("2026-10-22"), second: creditEvent("2026-10-29") } },
        ),
      ],
    ]);
    expect(collectDates(map).map((event) => [event.date, event.origin])).toEqual([
      ["2026-10-22", "live"],
      ["2026-10-29", "live"],
    ]);
  });

  it("preserves saved later expirations when older or capped APIs report only the earliest grant", () => {
    for (const credits of [
      { availableCount: 2, nextExpiresAt: "2026-10-22T20:00:00Z" },
      {
        availableCount: 2,
        credits: [{ id: "first", count: 1, expiresAt: "2026-10-22T20:00:00Z" }],
      },
    ]) {
      const map = new Map([
        [
          local,
          presentation([provider({ usageLimits: { ...limits, resetCredits: credits } })], {
            events: { first: creditEvent("2026-10-22"), second: creditEvent("2026-10-29") },
          }),
        ],
      ]);
      expect(collectDates(map).map((event) => [event.date, event.origin])).toEqual([
        ["2026-10-22", "live"],
        ["2026-10-29", "saved"],
      ]);
    }
  });

  it("keeps manually recorded deadlines if a reported grant has no expiry", () => {
    const map = new Map([
      [
        local,
        presentation(
          [
            provider({
              usageLimits: {
                ...limits,
                resetCredits: { availableCount: 1, credits: [{ id: "unknown-expiry", count: 1 }] },
              },
            }),
          ],
          { events: { manual: creditEvent("2026-10-29") } },
        ),
      ],
    ]);
    expect(collectDates(map)).toMatchObject([{ date: "2026-10-29", origin: "saved" }]);
  });

  it("does not confuse generic service credits with banked provider reset credits", () => {
    const map = new Map([
      [
        local,
        presentation(
          [
            provider({
              usageLimits: { ...limits, resetCredits: { availableCount: 0, credits: [] } },
            }),
          ],
          {
            events: {
              expiry: creditEvent("2026-10-29", { kind: "creditExpiry" }),
              cloud: creditEvent("2026-11-04", { kind: "cloudCredit" }),
              banked: creditEvent("2026-10-29"),
            },
          },
        ),
      ],
    ]);
    expect(collectDates(map).map((event) => event.kind)).toEqual(["creditExpiry", "cloudCredit"]);
  });
});

describe("Recorded calendar dates", () => {
  it("sorts exact local times using the recorded timezone", () => {
    expect(
      DateTime.formatIso(
        DateTime.makeUnsafe(accountDateTimestamp("2026-10-03", "12:00", "America/Los_Angeles")),
      ),
    ).toBe("2026-10-03T19:00:00.000Z");
    expect(accountDateTimestamp("2026-10-03", "12:00", "UTC")).toBeLessThan(
      accountDateTimestamp("2026-10-03", "12:00", "America/Los_Angeles"),
    );
  });

  it("rejects invalid dates and times that disappear during daylight saving", () => {
    expect(() => accountDateTimestamp("2026-02-31", undefined, "UTC")).toThrow();
    expect(() => accountDateTimestamp("2026-03-08", "02:30", "America/Los_Angeles")).toThrow(
      "does not exist",
    );
  });

  it("repeats monthly billing from its original day instead of drifting after February", () => {
    const event = creditEvent("2026-01-31", { kind: "renewal", recurrence: "monthly" });
    expect(nextAccountEventDate(event, Date.parse("2026-02-01T20:00:00Z"))).toBe("2026-02-28");
    expect(nextAccountEventDate(event, Date.parse("2026-03-01T20:00:00Z"))).toBe("2026-03-31");
  });

  it("retains overdue one-time dates and handles yearly leap-day reminders", () => {
    expect(nextAccountEventDate(creditEvent("2026-01-01"), now)).toBe("2026-01-01");
    expect(nextAccountEventDate(creditEvent("2024-02-29", { recurrence: "yearly" }), now)).toBe(
      "2027-02-28",
    );
  });
});

describe("Authoritative annotation responses", () => {
  it("accepts the named record without requiring other clients' records to match", () => {
    const ledger: AccountLedger = {
      accounts: {
        one: { label: "One", service: "Codex", assignees: ["Alex"] },
        other: { label: "Other", service: "Cursor" },
      },
      events: {},
      notes: {},
    };
    expect(
      accountLedgerContainsPatch(ledger, {
        accounts: { one: { service: "Codex", label: "One", assignees: ["Alex"] } },
      }),
    ).toBe(true);
    expect(
      accountLedgerContainsPatch(ledger, {
        accounts: { one: { service: "Codex", label: "One", assignees: ["Amal"] } },
      }),
    ).toBe(false);
    expect(
      accountLedgerContainsPatch(ledger, {
        accounts: { absent: { service: "Codex", label: "Missing" } },
      }),
    ).toBe(false);
    expect(accountLedgerContainsPatch(ledger, { accounts: { one: null } })).toBe(false);
    expect(accountLedgerContainsPatch(ledger, { accounts: { absent: null } })).toBe(true);
  });
});

describe("Account pills", () => {
  it("retains the account identity when adding a pill to a provider-owned row", () => {
    const account = collectAccounts(new Map([[local, presentation()]]), now)[0]!;
    const row = accountPillRow(
      { accounts: {}, events: {}, notes: {} },
      { kind: "account", id: account.id, environmentId: local, label: account.label, account },
    );
    expect(accountPillPatch([{ ...row, pills: ["Needs review"] }])).toEqual({
      accounts: { [account.id]: { service: "Codex", label: "person@example.test" } },
      rowPills: { [accountPillRowKey(row)]: ["Needs review"] },
    });
  });
  it("does not attach a pill to the next credit after a different credit expires", () => {
    const dateId = (expiresAt: string) => {
      const map = new Map([
        [
          local,
          presentation([
            provider({
              usageLimits: {
                ...limits,
                resetCredits: { availableCount: 1, nextExpiresAt: expiresAt },
              },
            }),
          ]),
        ],
      ]);
      return collectAccountDates(map, collectAccounts(map, now), "America/Los_Angeles", now)[0]!.id;
    };
    expect(dateId("2026-10-22T19:00:00Z")).not.toBe(dateId("2026-10-29T19:00:00Z"));
  });
  const source: AccountPillRow = {
    id: "shared-id",
    kind: "account",
    environmentId: local,
    label: "source",
    pills: ["Amal using", "Needs review"],
  };
  const date: AccountPillRow = {
    id: "shared-id",
    kind: "date",
    environmentId: local,
    label: "Credits expire",
    pills: ["Alex using"],
  };
  it("moves full text across row types, preserving every other pill", () => {
    expect(moveAccountPill(source, date, "Needs review")).toEqual({
      rowPills: {
        [accountPillRowKey(source)]: ["Amal using"],
        [accountPillRowKey(date)]: ["Alex using", "Needs review"],
      },
    });
    expect(source.pills).toEqual(["Amal using", "Needs review"]);
  });
  it("removes an empty source and does not duplicate a destination pill", () => {
    expect(moveAccountPill({ ...source, pills: ["Alex using"] }, date, "Alex using")).toEqual({
      rowPills: {
        [accountPillRowKey(source)]: null,
        [accountPillRowKey(date)]: ["Alex using"],
      },
    });
  });
  it("rejects absent pills, the same row, and cross-environment moves", () => {
    expect(moveAccountPill(source, source, "Amal using")).toBeNull();
    expect(moveAccountPill(source, date, "Missing")).toBeNull();
    expect(moveAccountPill(source, { ...date, environmentId: remote }, "Amal using")).toBeNull();
  });
  it("turns retained names into editable full-text pills without changing account details", () => {
    const account: AccountRow = {
      id: "work",
      environmentId: local,
      environmentLabel: "Local",
      service: "Codex",
      label: "work@example.test",
      saved: {
        service: "Codex",
        label: "work@example.test",
        assignees: ["Amal", "Alex"],
        resetAt: "2026-10-03T19:00:00Z",
        resetNotTriggered: true,
      },
      live: true,
      limits,
      resetAt: undefined,
      resetSource: undefined,
      trigger: null,
    };
    const ledger: AccountLedger = { accounts: { work: account.saved! }, events: {}, notes: {} };
    const row = accountPillRow(ledger, {
      kind: "account",
      id: account.id,
      environmentId: local,
      label: account.label,
      account,
    });
    expect(row.pills).toEqual(["Amal using", "Alex using"]);
    const patch = accountPillPatch([{ ...row, pills: [...row.pills, "Borrowed, until Friday"] }]);
    expect(patch).toEqual({
      rowPills: {
        [accountPillRowKey(row)]: ["Amal using", "Alex using", "Borrowed, until Friday"],
      },
      accounts: {
        work: {
          service: "Codex",
          label: "work@example.test",
          resetAt: "2026-10-03T19:00:00Z",
          resetNotTriggered: true,
        },
      },
    });
    expect(account.saved?.assignees).toEqual(["Amal", "Alex"]);
    expect(
      accountPillRow({ ...ledger, rowPills: { [accountPillRowKey(row)]: [] } }, row).pills,
    ).toEqual([]);
  });
  it("verifies that a server actually retained the pill patch, including deletion", () => {
    const ledger: AccountLedger = {
      accounts: {},
      events: {},
      notes: {},
      rowPills: { one: ["A, B"] },
    };
    expect(accountLedgerContainsPatch(ledger, { rowPills: { one: ["A, B"] } })).toBe(true);
    expect(accountLedgerContainsPatch(ledger, { rowPills: { one: ["A", "B"] } })).toBe(false);
    expect(accountLedgerContainsPatch(ledger, { rowPills: { one: null } })).toBe(false);
    expect(
      accountLedgerContainsPatch({ ...ledger, rowPills: {} }, { rowPills: { one: null } }),
    ).toBe(true);
  });
});

describe("Confirmed reset observations", () => {
  it("shows the reported active weekly timer even when a saved confirmation remains", () => {
    const map = new Map([
      [
        local,
        presentation([provider()], {
          accounts: {
            person: { service: "Codex", label: "person@example.test", resetNotTriggered: true },
          },
        }),
      ],
    ]);
    const row = collectAccounts(map, now)[0]!;
    expect(accountResetNotTriggered(row, now)).toBe(false);
    expect(row.resetAt).toBe("2026-10-03T19:00:00Z");
  });
  it("never substitutes a model bucket for Claude's account-wide week", () => {
    const scoped = {
      id: "seven_day_fable",
      kind: "weekly",
      label: "Weekly · Fable",
      usedPercent: 0,
      resetsAt: "2026-10-03T19:00:00Z",
    } as const;
    const weekly = { ...limits.windows[0]!, id: "seven_day", usedPercent: 80 };
    expect(primaryAccountWindow({ ...limits, windows: [scoped, weekly] })).toBe(weekly);
    const map = new Map([
      [
        local,
        presentation(
          [
            provider({
              driver: ProviderDriverKind.make("claudeAgent"),
              usageLimits: { ...limits, windows: [scoped] },
            }),
          ],
          {
            accounts: {
              person: {
                service: "Claude Code",
                label: "person@example.test",
                resetNotTriggered: true,
              },
            },
          },
        ),
      ],
    ]);
    const row = collectAccounts(map, now)[0]!;
    expect(primaryAccountWindow(row.limits)).toBeUndefined();
    expect(accountResetNotTriggered(row, now)).toBe(true);
  });
  it("preserves the observation when a failed probe cannot disprove it", () => {
    const map = new Map([
      [
        local,
        presentation(
          [provider({ usageLimits: { ...limits, unavailable: { reason: "probeFailed" } } })],
          {
            accounts: {
              person: { service: "Codex", label: "person@example.test", resetNotTriggered: true },
            },
          },
        ),
      ],
    ]);
    expect(accountResetNotTriggered(collectAccounts(map, now)[0]!, now)).toBe(true);
  });
});

describe("Stable account annotations", () => {
  it("keeps anonymous accounts on different environments separate even when source ids match", () => {
    const item = presentation([]);
    const anonymous: AccountsPresentation = {
      ...item,
      serverConfig: {
        ...item.serverConfig!,
        usageLimitSources: [
          {
            id: UsageLimitSourceId.make("pool"),
            kind: "cliproxy",
            label: "Pool",
            checkedAt: limits.checkedAt,
            accounts: [
              {
                id: "default-account",
                driver: ProviderDriverKind.make("codex"),
                usageLimits: limits,
              },
            ],
          },
        ],
      },
    };
    const rows = collectAccounts(
      new Map([
        [local, anonymous],
        [remote, anonymous],
      ]),
      now,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
    expect(new Set(rows.map((row) => row.trigger?.environmentId)).size).toBe(2);
  });

  it("keeps annotations on a credential-backed account that has no reported email", () => {
    const native = provider({
      auth: { status: "authenticated" },
      displayName: "Personal",
      usageLimits: { ...limits, credentialFingerprint: "credential-identity" },
    });
    const first = collectAccounts(new Map([[local, presentation([native])]]), now)[0]!;
    const saved = collectAccounts(
      new Map([
        [
          local,
          presentation([native], {
            accounts: { [first.id]: { service: "Codex", label: "Personal", assignees: ["Alex"] } },
          }),
        ],
      ]),
      now,
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]?.saved?.assignees).toEqual(["Alex"]);
    expect(saved[0]?.live).toBe(true);
  });
  it("resolves account-key event scope before comparing reported and saved grants", () => {
    const map = new Map([
      [
        local,
        presentation(
          [
            provider({
              usageLimits: {
                ...limits,
                resetCredits: {
                  availableCount: 1,
                  credits: [{ id: "grant", count: 1, expiresAt: "2026-10-22T20:00:00Z" }],
                },
              },
            }),
          ],
          {
            accounts: { personal: { service: "Codex", label: "person@example.test" } },
            events: { expiry: creditEvent("2026-10-22", { account: "personal" }) },
          },
        ),
      ],
    ]);
    expect(collectDates(map)).toHaveLength(1);
  });
});

describe("Partial provider observations", () => {
  it("does not invent the number of credits that expire at a legacy earliest deadline", () => {
    const map = new Map([
      [
        local,
        presentation(
          [
            provider({
              usageLimits: {
                ...limits,
                resetCredits: { availableCount: 2, nextExpiresAt: "2026-10-22T20:00:00Z" },
              },
            }),
          ],
          { events: { second: creditEvent("2026-10-29", { amount: "1 credit" }) } },
        ),
      ],
    ]);
    const dates = collectDates(map);
    expect(dates[0]?.date).toBe("2026-10-22");
    expect(dates[0]?.amount).toBeUndefined();
    expect(dates[1]?.amount).toBe("1 credit");
  });
  it("retains a successful credit read when newer quota omits it", () => {
    const map = new Map([
      [
        local,
        presentation([
          provider({
            usageLimits: {
              ...limits,
              resetCredits: {
                availableCount: 1,
                credits: [{ id: "grant", count: 1, expiresAt: "2026-10-22T20:00:00Z" }],
              },
            },
          }),
        ]),
      ],
      [
        remote,
        presentation([provider({ usageLimits: { ...limits, checkedAt: "2026-09-29T21:00:00Z" } })]),
      ],
    ]);
    expect(collectDates(map)).toMatchObject([{ date: "2026-10-22", amount: "1 credit" }]);
  });
  it("keeps a recurring DST-gap date visible and sorts the rest of the list without crashing", () => {
    const spring = Date.parse("2026-03-01T20:00:00Z");
    const map = new Map([
      [
        local,
        presentation([], {
          events: {
            cycle: creditEvent("2026-02-08", {
              kind: "renewal",
              recurrence: "monthly",
              time: "02:30",
            }),
            other: creditEvent("2026-03-09"),
          },
        }),
      ],
    ]);
    const dates = collectAccountDates(
      map,
      collectAccounts(map, spring),
      "America/Los_Angeles",
      spring,
    );
    expect(dates).toHaveLength(2);
    expect(dates[0]).toMatchObject({ date: "2026-03-08", time: "02:30", timeUnavailable: true });
    expect(dates[1]?.date).toBe("2026-03-09");
  });
});
