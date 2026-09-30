import type { LinearAccountAlert, LinearAccountsSnapshot } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const QUERY = `query AccountsBilling($after: String) {
  organization { id name subscription { nextBillingAt type } }
  usageAlerts(first: ${PAGE_SIZE}, after: $after) {
    nodes { id type metadata createdAt resolvedAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

const GraphQlResponse = Schema.Struct({
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        organization: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              subscription: Schema.NullOr(
                Schema.Struct({
                  nextBillingAt: Schema.NullOr(Schema.String),
                  type: Schema.String,
                }),
              ),
            }),
          ),
        ),
        usageAlerts: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  id: Schema.String,
                  type: Schema.String,
                  metadata: Schema.Record(Schema.String, Schema.Json),
                  createdAt: Schema.String,
                  resolvedAt: Schema.NullOr(Schema.String),
                }),
              ),
              pageInfo: Schema.Struct({
                hasNextPage: Schema.Boolean,
                endCursor: Schema.NullOr(Schema.String),
              }),
            }),
          ),
        ),
      }),
    ),
  ),
});

class LinearReadError extends Schema.TaggedError<LinearReadError>()("LinearReadError", {
  detail: Schema.String,
}) {}

export class LinearAccounts extends Context.Service<
  LinearAccounts,
  { readonly read: Effect.Effect<LinearAccountsSnapshot> }
>()("t3/usage/LinearAccounts") {
  static readonly layer = Layer.effect(
    LinearAccounts,
    Effect.suspend(() => makeLinearAccounts),
  );
}

export const makeLinearAccounts = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const key = yield* Config.Redacted("T3ACCOUNTS_LINEAR_API_KEY").pipe(Config.option);

  const read = Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (Option.isNone(key) || !Redacted.value(key.value).trim()) {
      return {
        checkedAt,
        alerts: [],
        unavailable:
          "Set T3ACCOUNTS_LINEAR_API_KEY on this environment's server to connect Linear.",
      } satisfies LinearAccountsSnapshot;
    }

    let workspace: LinearAccountsSnapshot["workspace"];
    const alerts = new Map<string, LinearAccountAlert>();
    const cursors = new Set<string>();
    let after: string | null = null;
    let unavailable: string | undefined;

    const fetchPages = Effect.gen(function* () {
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = yield* client
          .execute(
            HttpClientRequest.post("https://api.linear.app/graphql").pipe(
              // Personal API keys use the key directly; OAuth's Bearer prefix is not implied.
              HttpClientRequest.setHeader("Authorization", Redacted.value(key.value)),
              HttpClientRequest.bodyJsonUnsafe({ query: QUERY, variables: { after } }),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(GraphQlResponse)),
            Effect.mapError(
              () => new LinearReadError({ detail: "Linear billing and alerts could not be read." }),
            ),
          );
        if (body.errors?.length) {
          unavailable =
            "Linear could not return all requested billing and alert fields. Check the API key's permissions.";
        }
        if (body.data?.organization) {
          const organization = body.data.organization;
          workspace = {
            id: organization.id,
            name: organization.name,
            ...(organization.subscription?.nextBillingAt
              ? { nextBillingAt: organization.subscription.nextBillingAt }
              : {}),
          };
        }
        const connection = body.data?.usageAlerts;
        if (!body.data?.organization || !connection) {
          unavailable ??=
            "Linear did not return workspace billing and alerts. Check the API key's permissions.";
        }
        if (!connection) return;
        for (const alert of connection.nodes) {
          alerts.set(alert.id, {
            id: alert.id,
            type: alert.type,
            createdAt: alert.createdAt,
            metadata: alert.metadata,
            ...(alert.resolvedAt ? { resolvedAt: alert.resolvedAt } : {}),
          });
        }
        if (!connection.pageInfo.hasNextPage) return;
        const cursor = connection.pageInfo.endCursor;
        if (!cursor || cursors.has(cursor)) {
          return yield* new LinearReadError({
            detail: "Linear returned an incomplete alert list because pagination did not advance.",
          });
        }
        cursors.add(cursor);
        after = cursor;
      }
      unavailable =
        "Linear alert history was limited to 10 pages (up to 500 alerts). Additional alert snapshots are omitted.";
    });

    yield* fetchPages.pipe(
      Effect.timeout("20 seconds"),
      Effect.catch((error) => {
        unavailable =
          error._tag === "LinearReadError"
            ? error.detail
            : "The Linear billing and alerts request timed out.";
        return Effect.void;
      }),
    );
    return {
      checkedAt,
      ...(workspace ? { workspace } : {}),
      alerts: [...alerts.values()],
      ...(unavailable ? { unavailable } : {}),
    } satisfies LinearAccountsSnapshot;
  });

  return LinearAccounts.of({ read });
});
