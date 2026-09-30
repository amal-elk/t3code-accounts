// @effect-diagnostics nodeBuiltinImport:off - Resolves only Git's conflicted release-manifest blobs before installation.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const RELEASE_MANIFESTS = new Set([
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
]);

export function mergeAccountsReleaseManifest(
  path: string,
  base: Readonly<Record<string, unknown>>,
  fork: Readonly<Record<string, unknown>>,
  upstream: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (!RELEASE_MANIFESTS.has(path)) {
    throw new Error(`Not a releasable package manifest: ${path}`);
  }
  const result: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(upstream), ...Object.keys(fork), ...Object.keys(base)]);
  for (const key of keys) {
    let source: Readonly<Record<string, unknown>>;
    if (key === "version") {
      source = upstream;
    } else if (path === "apps/desktop/package.json" && key === "productName") {
      source = fork;
    } else if (NodeUtil.isDeepStrictEqual(fork[key], upstream[key])) {
      source = fork;
    } else if (NodeUtil.isDeepStrictEqual(fork[key], base[key])) {
      source = upstream;
    } else if (NodeUtil.isDeepStrictEqual(upstream[key], base[key])) {
      source = fork;
    } else {
      throw new Error(`Manual resolution required for ${path}: ${key}`);
    }
    if (Object.hasOwn(source, key)) result[key] = source[key];
  }
  return result;
}

if (import.meta.main) {
  const files = NodeChildProcess.execFileSync("git", ["diff", "--name-only", "--diff-filter=U"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    if (!RELEASE_MANIFESTS.has(file)) continue;
    const blobs = [1, 2, 3].map((stage) =>
      decodeManifest(
        NodeChildProcess.execFileSync("git", ["show", `:${stage}:${file}`], { encoding: "utf8" }),
      ),
    );
    const merged = mergeAccountsReleaseManifest(file, blobs[0]!, blobs[1]!, blobs[2]!);
    NodeFS.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
    // Confirm a real manifest before resolving its index entry.
    decodeManifest(NodeFS.readFileSync(file, "utf8"));
    NodeChildProcess.execFileSync("git", ["add", "--", file]);
  }
}
