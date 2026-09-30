import type { ServerProviderModel } from "@t3tools/contracts";

/** Restrict automatic selection to a reported small model; never default to a larger one. */
export function selectResetTimerModel(
  driver: string,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProviderModel | undefined {
  return models.find((model) => {
    if (model.isCustom || model.isLegacy) return false;
    if (driver === "claudeAgent") return /(?:^|[-_])haiku(?:$|[-_])/i.test(model.slug);
    if (driver !== "codex" || !/(?:^|[-_])(?:luna|mini)(?:$|[-_])/i.test(model.slug)) return false;
    const reasoning = model.capabilities?.optionDescriptors?.find(
      (option) => option.id === "reasoningEffort",
    );
    return reasoning?.type === "select" && reasoning.options.some((choice) => choice.id === "low");
  });
}
