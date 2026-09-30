// @effect-diagnostics nodeBuiltinImport:off - fixture JWTs exercise native auth decoding.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ClaudeSettings, CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  codexResetTimerBody,
  didCodexInferenceComplete,
  makeCodexResetTimerInference,
  makeClaudeResetTimerInference,
} from "./ResetTimerInference.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../ClaudeModelCatalog.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      model: Schema.String,
      store: Schema.Boolean,
      tools: Schema.Array(Schema.Unknown),
      tool_choice: Schema.String,
      reasoning: Schema.Struct({ effort: Schema.String }),
      input: Schema.Array(
        Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
      ),
    }),
  ),
);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reset-timer-fixture-" });
  const claims = Buffer.from(encodeJson({ email: "alice@example.com" })).toString("base64url");
  yield* fs.writeFileString(
    `${home}/auth.json`,
    encodeJson({
      tokens: {
        access_token: "fixture-access-token",
        id_token: `header.${claims}.signature`,
        account_id: "fixture-account-id",
      },
    }),
  );
  return yield* decodeCodexSettings({ homePath: home });
});

describe("reset timer inference", () => {
  it("requires a completed SSE event rather than just output or HTTP success", () => {
    expect(
      didCodexInferenceComplete('data: {"type":"response.output_text.delta","delta":"hello"}\n'),
    ).toBe(false);
    expect(didCodexInferenceComplete('data: {"type":"response.failed"}\n')).toBe(false);
    expect(
      didCodexInferenceComplete(
        'event: response.completed\ndata: {"type": "response.completed"}\n',
      ),
    ).toBe(true);
    expect(codexResetTimerBody("reported-luna").tools).toEqual([]);
  });

  it.effect(
    "pins the OAuth account and sends only a tool-free test to the reported small model",
    () =>
      Effect.gen(function* () {
        const config = yield* fixture;
        let requests = 0;
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            requests += 1;
            expect(request.url).toBe("https://chatgpt.com/backend-api/codex/responses");
            expect(request.headers.authorization).toBe("Bearer fixture-access-token");
            expect(request.headers["chatgpt-account-id"]).toBe("fixture-account-id");
            expect(request.body._tag).toBe("Uint8Array");
            if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body");
            const body = decodeBody(new TextDecoder().decode(request.body.body));
            expect(body.model).toBe("gpt-6-luna");
            expect(body.store).toBe(false);
            expect(body.tools).toEqual([]);
            expect(body.tool_choice).toBe("none");
            expect(body.reasoning.effort).toBe("low");
            expect(body.input[0]?.content[0]?.text).toBe("test");
            return HttpClientResponse.fromWeb(
              request,
              new Response('data: {"type":"response.completed"}\n'),
            );
          }),
        );
        const trigger = yield* makeCodexResetTimerInference(config, {}, "fixture").pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );
        yield* trigger({ model: "gpt-6-luna", expectedAccountEmail: "alice@example.com" });
        expect(requests).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an auth file that changed accounts before sending", () =>
    Effect.gen(function* () {
      const config = yield* fixture;
      let requests = 0;
      const http = HttpClient.make(() => {
        requests += 1;
        return Effect.die("A wrong account must never receive the message.");
      });
      const trigger = yield* makeCodexResetTimerInference(config, {}, "fixture").pipe(
        Effect.provideService(HttpClient.HttpClient, http),
      );
      const result = yield* trigger({
        model: "gpt-6-luna",
        expectedAccountEmail: "bob@example.com",
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(requests).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const email of ["alice@example.com", "bob@example.com"]) {
    it.effect(`checks the Claude login immediately before inference (${email})`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-reset-fixture-" });
        const marker = `${home}/inference-ran`;
        const binaryPath = writeFakeCli({
          directory: `${home}/bin`,
          name: "claude",
          env: { T3_FIXTURE_EMAIL: email, T3_FIXTURE_MARKER: marker, T3_FIXTURE_CONFIG: home },
          source: [
            'import { writeFileSync } from "node:fs";',
            "const args = process.argv.slice(2);",
            "if (process.env.CLAUDE_CONFIG_DIR !== process.env.T3_FIXTURE_CONFIG) process.exit(10);",
            'if (args[0] === "auth") {',
            '  process.stdout.write(JSON.stringify({loggedIn:true, email:process.env.T3_FIXTURE_EMAIL, apiProvider:"firstParty", authMethod:"claude.ai"}));',
            "  process.exit(0);",
            "}",
            'if (!args.includes("-p")) process.exit(11);',
            'if (args[args.indexOf("--tools") + 1] !== "") process.exit(12);',
            'if (!args.includes("--strict-mcp-config") || !args.includes("--disable-slash-commands")) process.exit(13);',
            'if (JSON.parse(args[args.indexOf("--settings") + 1]).disableAllHooks !== true) process.exit(14);',
            'if (!args.includes("--no-session-persistence") || args[args.indexOf("--setting-sources") + 1] !== "") process.exit(15);',
            'if (args[args.indexOf("--permission-mode") + 1] !== "dontAsk") process.exit(16);',
            "if (process.cwd() === process.env.T3_FIXTURE_CONFIG) process.exit(17);",
            'let text = ""; for await (const chunk of process.stdin) text += chunk;',
            'if (text !== "test") process.exit(18);',
            'writeFileSync(process.env.T3_FIXTURE_MARKER, "ok");',
          ].join("\n"),
        });
        const config = yield* decodeClaudeSettings({ binaryPath, homePath: home });
        const trigger = yield* makeClaudeResetTimerInference(
          config,
          process.env,
          "claude-fixture",
          Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
        );
        const result = yield* trigger({
          model: "claude-haiku-4-5",
          expectedAccountEmail: "alice@example.com",
        }).pipe(Effect.result);
        expect(result._tag).toBe(email === "alice@example.com" ? "Success" : "Failure");
        expect(yield* fs.exists(marker)).toBe(email === "alice@example.com");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
});
