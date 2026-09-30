import * as NodeOS from "node:os";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { it } from "@effect/vitest";
import { assert } from "vite-plus/test";

import { hydratePosixHome, resolveBaseDir } from "./os-jank.ts";

it.effect("isolates the fork's default home and honors an explicit sandbox", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    assert.equal(yield* resolveBaseDir(undefined), path.join(NodeOS.homedir(), ".t3-accounts"));
    assert.equal(yield* resolveBaseDir(" "), path.join(NodeOS.homedir(), ".t3-accounts"));
    assert.equal(
      yield* resolveBaseDir("~/accounts-sandbox"),
      path.join(NodeOS.homedir(), "accounts-sandbox"),
    );
  }).pipe(Effect.provide(NodePath.layer)),
);

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});
