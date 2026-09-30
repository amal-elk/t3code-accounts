import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeCliproxyResetTimer } from "./cliproxyResetTimer.ts";

const config = {
  kind: "cliproxy",
  enabled: true,
  url: "http://fixture-hub.test",
  managementKey: "fixture-key",
} as const;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Request = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.String,
  url: Schema.String,
  header: Schema.Record(Schema.String, Schema.String),
  data: Schema.optional(Schema.String),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Request));

const fixture = (disabled = false) => {
  const requests: Array<typeof Request.Type> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer fixture-key");
      if (request.url.endsWith("auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            files: [
              { id: "first", auth_index: "a", provider: "codex", email: "first@example.com" },
              {
                id: "second",
                auth_index: "b",
                provider: "codex",
                email: "second@example.com",
                disabled,
                id_token: { chatgpt_account_id: "second-account" },
              },
            ],
          }),
        );
      if (request.body._tag !== "Uint8Array") throw new Error("Expected management API-call body");
      const body = decodeRequest(new TextDecoder().decode(request.body.body));
      requests.push(body);
      expect(body.auth_index).toBe("b");
      expect(body.header.Authorization).toBe("Bearer $TOKEN$");
      expect(body.header["Chatgpt-Account-Id"]).toBe("second-account");
      const response = body.url.includes("/models")
        ? encodeJson({
            models: [
              {
                slug: "gpt-6-luna",
                display_name: "Luna",
                visibility: "list",
                supported_reasoning_levels: [{ effort: "low" }],
              },
            ],
          })
        : body.url.endsWith("/responses")
          ? 'data: {"type":"response.completed"}\n'
          : body.url.endsWith("rate-limit-reset-credits")
            ? encodeJson({ credits: [] })
            : encodeJson({
                rate_limit: {
                  secondary_window: { used_percent: 0, reset_at: 0, limit_window_seconds: 604800 },
                },
              });
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: 200, body: response }),
      );
    }),
  );
  return { http, requests };
};

describe("CLIProxy reset timer", () => {
  it.effect("discovers models, sends, and refreshes only the selected auth_index", () =>
    Effect.gen(function* () {
      const test = fixture();
      const helper = yield* makeCliproxyResetTimer.pipe(
        Effect.provideService(HttpClient.HttpClient, test.http),
      );
      const prepared = yield* helper.prepare(config, "second");
      expect(prepared.model).toBe("gpt-6-luna");
      yield* prepared.send;
      yield* prepared.refresh;
      const inference = test.requests.filter((request) => request.method === "POST");
      expect(inference).toHaveLength(1);
      expect(inference[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(inference[0]?.data).toContain('"tools":[]');
      expect(inference[0]?.data).toContain('"text":"test"');
      expect(test.requests.some((request) => request.url.includes("client_version="))).toBe(true);
    }),
  );

  it.effect("does not send to a disabled account or another pooled account", () =>
    Effect.gen(function* () {
      const test = fixture(true);
      const helper = yield* makeCliproxyResetTimer.pipe(
        Effect.provideService(HttpClient.HttpClient, test.http),
      );
      expect((yield* helper.prepare(config, "second").pipe(Effect.result))._tag).toBe("Failure");
      expect(test.requests).toEqual([]);
    }),
  );
});
