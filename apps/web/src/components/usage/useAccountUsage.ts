import { IsoDateTime, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  accountIdentity,
  primaryAccountWindow,
  type AccountRow,
} from "@t3tools/client-runtime/accounts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";

const UsageReading = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: Schema.Array(ServerProviderUsageWindow),
});
const UsageHistory = Schema.Record(Schema.String, UsageReading);
const EMPTY_HISTORY: typeof UsageHistory.Type = {};
const STORAGE_KEY = "t3accounts:usage-history:v1";
const historyKey = (account: AccountRow) =>
  JSON.stringify([account.environmentId, accountIdentity(account.service, account.label)]);

/** Display history never restores auth, trigger routes, or spent reset credits. */
export function useAccountUsage(accounts: readonly AccountRow[]) {
  const [history, setHistory] = useLocalStorage(STORAGE_KEY, EMPTY_HISTORY, UsageHistory);
  useEffect(() => {
    const next = { ...history };
    let changed = false;
    for (const account of accounts) {
      const key = historyKey(account);
      const limits = account.limits;
      if (limits?.unavailable?.reason === "unsupported") {
        if (next[key]) {
          delete next[key];
          changed = true;
        }
      } else if (limits && !limits.unavailable && primaryAccountWindow(limits)) {
        const reading = { checkedAt: limits.checkedAt, windows: limits.windows };
        if (
          (!next[key] || Date.parse(reading.checkedAt) >= Date.parse(next[key].checkedAt)) &&
          JSON.stringify(next[key]) !== JSON.stringify(reading)
        ) {
          next[key] = reading;
          changed = true;
        }
      }
    }
    if (changed) setHistory(next);
  }, [accounts, history, setHistory]);

  return (account: AccountRow) => {
    const current = account.limits;
    const unsupported = current?.unavailable?.reason === "unsupported";
    const reading = unsupported
      ? undefined
      : primaryAccountWindow(current)
        ? current
        : history[historyKey(account)];
    return {
      reading,
      main: primaryAccountWindow(reading),
      lastKnown: Boolean(reading && (reading !== current || current?.unavailable)),
      missingLabel: account.live ? "Unavailable" : "Not connected",
    };
  };
}
