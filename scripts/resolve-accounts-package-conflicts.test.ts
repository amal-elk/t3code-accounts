import { assert, describe, it } from "@effect/vitest";
import { mergeAccountsReleaseManifest } from "./resolve-accounts-package-conflicts.ts";

describe("Accounts release manifest merge", () => {
  it("keeps fork identity while accepting upstream version and dependency updates", () => {
    const base = {
      version: "0.0.44",
      productName: "T3 Code (Alpha)",
      dependencies: { electron: "44.4.2" },
    };
    const merged = mergeAccountsReleaseManifest(
      "apps/desktop/package.json",
      base,
      { ...base, version: "0.0.44-accounts.1", productName: "T3 Accounts" },
      { ...base, version: "0.0.45", dependencies: { electron: "44.5.0" } },
    );
    assert.deepEqual(merged, {
      version: "0.0.45",
      productName: "T3 Accounts",
      dependencies: { electron: "44.5.0" },
    });
  });

  it("preserves fork-only fields and upstream removals", () => {
    const merged = mergeAccountsReleaseManifest(
      "apps/server/package.json",
      { version: "0.0.44", obsolete: true },
      { version: "0.0.44-accounts.1", obsolete: true, description: "fork" },
      { version: "0.0.45" },
    );
    assert.deepEqual(merged, { version: "0.0.45", description: "fork" });
  });

  it("leaves competing dependency edits for manual resolution", () => {
    assert.throws(
      () =>
        mergeAccountsReleaseManifest(
          "apps/desktop/package.json",
          { dependencies: { electron: "44.4.2" } },
          { dependencies: { electron: "44.4.3" } },
          { dependencies: { electron: "44.5.0" } },
        ),
      "Manual resolution required for apps/desktop/package.json: dependencies",
    );
  });
});
