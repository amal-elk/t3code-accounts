import * as NodeOS from "node:os";

import { ProviderInstanceId, type ClaudeSettings, type CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { expandHomePath } from "../../pathExpansion.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  getClaudeCatalogModelCapabilities,
  resolveClaudeCatalogApiModelId,
  type ClaudeModelCatalog,
} from "../ClaudeModelCatalog.ts";
import { makeClaudeEnvironment } from "./ClaudeHome.ts";

const NativeCodexAuth = Schema.Struct({
  tokens: Schema.Struct({
    access_token: Schema.NonEmptyString,
    id_token: Schema.NonEmptyString,
    account_id: Schema.optional(Schema.NonEmptyString),
  }),
});
const IdentityClaims = Schema.Struct({ email: Schema.NonEmptyString });
const ClaudeAuthStatus = Schema.Struct({
  loggedIn: Schema.Boolean,
  email: Schema.optional(Schema.String),
  authMethod: Schema.optional(Schema.String),
  apiProvider: Schema.optional(Schema.String),
});
const ResponseEvent = Schema.Struct({ type: Schema.String });
const parseEvent = Schema.decodeUnknownOption(Schema.fromJsonString(ResponseEvent));
const isProviderDriverError = Schema.is(ProviderDriverError);
const decodeNativeCodexAuth = Schema.decodeEffect(Schema.fromJsonString(NativeCodexAuth));
const decodeIdentityClaims = Schema.decodeEffect(Schema.fromJsonString(IdentityClaims));
const decodeClaudeAuthStatus = Schema.decodeEffect(Schema.fromJsonString(ClaudeAuthStatus));

/** The provider streams a settled outcome; HTTP 200 alone is not completion. */
export function didCodexInferenceComplete(body: string): boolean {
  return body.split(/\r?\n/).some((line) => {
    if (!line.startsWith("data:")) return false;
    const event = parseEvent(line.slice(5).trim());
    return Option.isSome(event) && event.value.type === "response.completed";
  });
}

/** No workspace, hooks, tools, session history, or model fallback enters this request. */
export function codexResetTimerBody(model: string) {
  return {
    model,
    instructions: "Reply briefly to the user's message.",
    input: [{ role: "user", content: [{ type: "input_text", text: "test" }] }],
    reasoning: { effort: "low" },
    tools: [],
    tool_choice: "none",
    parallel_tool_calls: false,
    store: false,
    stream: true,
  };
}

export const makeCodexResetTimerInference = Effect.fn("makeCodexResetTimerInference")(function* (
  config: CodexSettings,
  environment: NodeJS.ProcessEnv,
  instanceId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const authPath = path.join(
    config.homePath.trim()
      ? expandHomePath(config.homePath)
      : environment.CODEX_HOME?.trim() || path.join(NodeOS.homedir(), ".codex"),
    "auth.json",
  );
  return Effect.fn("Codex.triggerResetTimer")(function* (input: {
    readonly model: string;
    readonly expectedAccountEmail: string;
  }) {
    const operation = Effect.gen(function* () {
      const auth = yield* fs.readFileString(authPath).pipe(Effect.flatMap(decodeNativeCodexAuth));
      const claimsJson = yield* Effect.try(() =>
        Buffer.from(auth.tokens.id_token.split(".")[1] ?? "", "base64url").toString("utf8"),
      );
      const claims = yield* decodeIdentityClaims(claimsJson);
      if (claims.email.trim().toLowerCase() !== input.expectedAccountEmail.trim().toLowerCase()) {
        return yield* new ProviderDriverError({
          driver: "codex",
          instanceId,
          detail: "The Codex login changed. Refresh the account before triggering its timer.",
        });
      }
      const request = HttpClientRequest.post(
        "https://chatgpt.com/backend-api/codex/responses",
      ).pipe(
        HttpClientRequest.bearerToken(auth.tokens.access_token),
        HttpClientRequest.setHeader("OpenAI-Beta", "responses=experimental"),
        HttpClientRequest.setHeader("originator", "codex_cli_rs"),
        HttpClientRequest.bodyJsonUnsafe(codexResetTimerBody(input.model)),
      );
      const response = yield* http.execute(
        auth.tokens.account_id
          ? request.pipe(HttpClientRequest.setHeader("Chatgpt-Account-Id", auth.tokens.account_id))
          : request,
      );
      yield* HttpClientResponse.filterStatusOk(response);
      const body = yield* response.text;
      if (!didCodexInferenceComplete(body)) {
        return yield* new ProviderDriverError({
          driver: "codex",
          instanceId,
          detail: "Codex did not confirm completion. Refresh its limits before retrying.",
        });
      }
    });
    return yield* operation.pipe(
      Effect.timeout("60 seconds"),
      Effect.mapError((cause) =>
        isProviderDriverError(cause)
          ? cause
          : new ProviderDriverError({
              driver: "codex",
              instanceId,
              detail:
                "Codex could not confirm the test message. Native OAuth credentials must be readable from this instance's auth.json. Refresh its limits before retrying.",
            }),
      ),
    );
  });
});

export const makeClaudeResetTimerInference = Effect.fn("makeClaudeResetTimerInference")(function* (
  config: ClaudeSettings,
  environment: NodeJS.ProcessEnv,
  instanceId: string,
  models: Effect.Effect<ClaudeModelCatalog>,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const env = yield* makeClaudeEnvironment(config, environment);
  return Effect.fn("Claude.triggerResetTimer")(function* (input: {
    readonly model: string;
    readonly expectedAccountEmail: string;
  }) {
    const operation = Effect.gen(function* () {
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-accounts-trigger-" });
      const catalog = yield* models;
      const caps = getClaudeCatalogModelCapabilities(catalog, input.model);
      const effort = caps.optionDescriptors?.find((item) => item.id === "effort");
      const supportsLow =
        effort?.type === "select" && effort.options.some((item) => item.id === "low");
      const statusCommand = yield* resolveSpawnCommand(
        config.binaryPath || "claude",
        ["auth", "status", "--json"],
        { env },
      );
      const statusChild = yield* spawner.spawn(
        ChildProcess.make(statusCommand.command, statusCommand.args, {
          env,
          cwd,
          shell: statusCommand.shell,
          stdin: "ignore",
        }),
      );
      const [statusText, statusCode] = yield* Effect.all(
        [
          statusChild.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          ),
          statusChild.exitCode,
          Stream.runDrain(statusChild.stderr),
        ],
        { concurrency: "unbounded" },
      );
      const status = yield* decodeClaudeAuthStatus(statusText);
      if (
        statusCode !== 0 ||
        !status.loggedIn ||
        status.email?.trim().toLowerCase() !== input.expectedAccountEmail.trim().toLowerCase() ||
        (status.apiProvider !== undefined && status.apiProvider !== "firstParty") ||
        /api.?key/i.test(status.authMethod ?? "")
      ) {
        return yield* new ProviderDriverError({
          driver: "claudeAgent",
          instanceId,
          detail: "The Claude login changed. Refresh the account before triggering its timer.",
        });
      }
      const command = yield* resolveSpawnCommand(
        config.binaryPath || "claude",
        [
          "-p",
          "--model",
          resolveClaudeCatalogApiModelId(catalog, {
            instanceId: ProviderInstanceId.make(instanceId),
            model: input.model,
          }),
          ...(supportsLow ? ["--effort", "low"] : []),
          "--tools",
          "",
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--settings",
          '{"disableAllHooks":true,"alwaysThinkingEnabled":false}',
          "--setting-sources",
          "",
          "--no-session-persistence",
          "--permission-mode",
          "dontAsk",
          "--max-turns",
          "1",
        ],
        { env },
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          env,
          cwd,
          shell: command.shell,
          stdin: { stream: Stream.encodeText(Stream.make("test")) },
        }),
      );
      const [code] = yield* Effect.all(
        [child.exitCode, Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)],
        { concurrency: "unbounded" },
      );
      if (code !== 0) {
        return yield* new ProviderDriverError({
          driver: "claudeAgent",
          instanceId,
          detail: "Claude did not confirm the test message. Refresh its limits before retrying.",
        });
      }
    });
    return yield* operation.pipe(
      Effect.scoped,
      Effect.timeout("60 seconds"),
      Effect.mapError((cause) =>
        isProviderDriverError(cause)
          ? cause
          : new ProviderDriverError({
              driver: "claudeAgent",
              instanceId,
              detail:
                "Claude could not confirm the test message. Refresh its limits before retrying.",
            }),
      ),
    );
  });
});
