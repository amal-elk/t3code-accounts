import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeLinearAccounts } from "./LinearAccounts.ts";

const RequestBody = Schema.Struct({
  query: Schema.String,
  variables: Schema.Struct({ after: Schema.NullOr(Schema.String) }),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const organization = {
  id: "workspace-id",
  name: "Example workspace",
  subscription: { nextBillingAt: "2026-10-10T14:00:00.000Z", type: "business" },
};
const alert = {
  id: "alert-id",
  type: "lowBalance",
  metadata: { balanceAtAlert: 5, threshold: 10, arbitraryFutureField: { enabled: true } },
  createdAt: "2026-09-25T00:00:00.000Z",
  resolvedAt: null,
};
const alerts = (nodes: ReadonlyArray<unknown> = [alert], cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});

function fixture(
  replies: ReadonlyArray<{ body: unknown; status?: number }>,
  env: Record<string, string> = { T3ACCOUNTS_LINEAR_API_KEY: "test-api-key" },
) {
  const requests: Array<typeof RequestBody.Type> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.url).toBe("https://api.linear.app/graphql");
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe("test-api-key");
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request body");
      requests.push(decodeRequest(new TextDecoder().decode(request.body.body)));
      const reply = replies[requests.length - 1];
      if (!reply) throw new Error("Unexpected extra Linear request");
      return HttpClientResponse.fromWeb(
        request,
        Response.json(reply.body, { status: reply.status ?? 200 }),
      );
    }),
  );
  return {
    requests,
    api: makeLinearAccounts.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  };
}

describe("Linear account billing and alert snapshots", () => {
  it.effect("reports the missing server key without making a request", () =>
    Effect.gen(function* () {
      const test = fixture([], {});
      const api = yield* test.api;
      const result = yield* api.read;
      expect(result.alerts).toEqual([]);
      expect(result.workspace).toBeUndefined();
      expect(result.unavailable).toContain("T3ACCOUNTS_LINEAR_API_KEY");
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect("treats an empty key as disconnected", () =>
    Effect.gen(function* () {
      const test = fixture([], { T3ACCOUNTS_LINEAR_API_KEY: "  " });
      const api = yield* test.api;
      expect((yield* api.read).unavailable).toContain("T3ACCOUNTS_LINEAR_API_KEY");
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect("keeps opaque alert metadata and reads the next billing date", () =>
    Effect.gen(function* () {
      const test = fixture([{ body: { data: { organization, usageAlerts: alerts() } } }]);
      const api = yield* test.api;
      const result = yield* api.read;
      expect(result.workspace).toEqual({
        id: "workspace-id",
        name: "Example workspace",
        nextBillingAt: "2026-10-10T14:00:00.000Z",
      });
      expect(result.alerts).toEqual([
        { id: alert.id, type: alert.type, createdAt: alert.createdAt, metadata: alert.metadata },
      ]);
      expect(result.unavailable).toBeUndefined();
      expect(result).not.toHaveProperty("balance");
      expect(result).not.toHaveProperty("creditExpiresAt");
      expect(test.requests[0]?.variables.after).toBeNull();
    }),
  );

  it.effect("supports a workspace without a subscription or upcoming billing date", () =>
    Effect.gen(function* () {
      for (const subscription of [null, { type: "business", nextBillingAt: null }]) {
        const test = fixture([
          {
            body: {
              data: { organization: { ...organization, subscription }, usageAlerts: alerts([]) },
            },
          },
        ]);
        const api = yield* test.api;
        const result = yield* api.read;
        expect(result.workspace).toEqual({ id: "workspace-id", name: "Example workspace" });
        expect(result.unavailable).toBeUndefined();
      }
    }),
  );

  it.effect("retains resolvedAt and follows pagination without duplicating alerts", () =>
    Effect.gen(function* () {
      const resolvedAlert = { ...alert, resolvedAt: "2026-09-26T00:00:00.000Z" };
      const nextAlert = { ...alert, id: "next-alert", type: "expiringPromoCredit" };
      const test = fixture([
        { body: { data: { organization, usageAlerts: alerts([alert], "cursor-one") } } },
        { body: { data: { organization, usageAlerts: alerts([resolvedAlert, nextAlert]) } } },
      ]);
      const api = yield* test.api;
      const result = yield* api.read;
      expect(test.requests.map((request) => request.variables.after)).toEqual([null, "cursor-one"]);
      expect(result.alerts).toHaveLength(2);
      expect(result.alerts[0]?.resolvedAt).toBe("2026-09-26T00:00:00.000Z");
      expect(result.alerts[1]?.type).toBe("expiringPromoCredit");
      expect(result.unavailable).toBeUndefined();
    }),
  );

  it.effect("returns a safe notice for GraphQL errors rather than provider error text", () =>
    Effect.gen(function* () {
      const test = fixture([
        { body: { errors: [{ message: "secret provider details" }], data: null } },
      ]);
      const api = yield* test.api;
      const result = yield* api.read;
      expect(result.alerts).toEqual([]);
      expect(result.workspace).toBeUndefined();
      expect(result.unavailable).toContain("permissions");
      expect(result.unavailable).not.toContain("secret provider details");
    }),
  );

  it.effect("retains useful billing data when GraphQL returns a partial permissions error", () =>
    Effect.gen(function* () {
      const test = fixture([
        {
          body: {
            data: { organization, usageAlerts: null },
            errors: [{ message: "secret provider details", path: ["usageAlerts"] }],
          },
        },
      ]);
      const api = yield* test.api;
      const result = yield* api.read;
      expect(result.workspace?.nextBillingAt).toBe(organization.subscription.nextBillingAt);
      expect(result.alerts).toEqual([]);
      expect(result.unavailable).toContain("permissions");
    }),
  );

  it.effect("retains successful pages when a later HTTP request fails", () =>
    Effect.gen(function* () {
      const test = fixture([
        { body: { data: { organization, usageAlerts: alerts([alert], "cursor-one") } } },
        { body: { error: "secret provider details" }, status: 401 },
      ]);
      const api = yield* test.api;
      const result = yield* api.read;
      expect(result.workspace?.id).toBe("workspace-id");
      expect(result.alerts).toHaveLength(1);
      expect(result.unavailable).toBe("Linear billing and alerts could not be read.");
    }),
  );

  it.effect("rejects malformed responses without exposing response contents", () =>
    Effect.gen(function* () {
      const test = fixture([
        { body: { data: { organization: "secret malformed contents", usageAlerts: alerts() } } },
      ]);
      const api = yield* test.api;
      const result = yield* api.read;
      expect(result.workspace).toBeUndefined();
      expect(result.alerts).toEqual([]);
      expect(result.unavailable).toBe("Linear billing and alerts could not be read.");
    }),
  );

  it.effect("bounds the whole collection when a request never completes", () =>
    Effect.gen(function* () {
      const api = yield* makeLinearAccounts.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { T3ACCOUNTS_LINEAR_API_KEY: "test-api-key" } }),
          ),
        ),
      );
      const fiber = yield* Effect.forkChild(api.read);
      yield* TestClock.adjust("20 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.alerts).toEqual([]);
      expect(result.unavailable).toBe("The Linear billing and alerts request timed out.");
    }),
  );

  it.effect("stops a repeated cursor and identifies the partial alert list", () =>
    Effect.gen(function* () {
      const test = fixture([
        { body: { data: { organization, usageAlerts: alerts([alert], "same-cursor") } } },
        { body: { data: { organization, usageAlerts: alerts([alert], "same-cursor") } } },
      ]);
      const api = yield* test.api;
      const result = yield* api.read;
      expect(test.requests).toHaveLength(2);
      expect(result.alerts).toHaveLength(1);
      expect(result.unavailable).toContain("pagination did not advance");
    }),
  );

  it.effect("caps pagination and labels the incomplete history", () =>
    Effect.gen(function* () {
      const test = fixture(
        Array.from({ length: 10 }, (_, index) => ({
          body: {
            data: {
              organization,
              usageAlerts: alerts([{ ...alert, id: `alert-${index}` }], `cursor-${index}`),
            },
          },
        })),
      );
      const api = yield* test.api;
      const result = yield* api.read;
      expect(test.requests).toHaveLength(10);
      expect(result.alerts).toHaveLength(10);
      expect(result.unavailable).toContain("Additional alert snapshots are omitted");
    }),
  );
});
