import { describe, expect, it } from "vitest";
import { isDaemonUnreachable, throwOnRejection, toIndexerResultShape } from "./daemonAccount";
import type { IndexerGetTransactionResultResponse, TransactionWaitResultResponse } from "@tari-project/ootle-ts-bindings";

describe("isDaemonUnreachable", () => {
  it("treats a bare TypeError (browser fetch failure) as unreachable", () => {
    expect(isDaemonUnreachable(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("treats a non-Error value as not unreachable (nothing to classify)", () => {
    expect(isDaemonUnreachable("some string")).toBe(false);
    expect(isDaemonUnreachable(undefined)).toBe(false);
    expect(isDaemonUnreachable(null)).toBe(false);
  });

  it("treats a real RPC error (method + code in cause) as NOT unreachable", () => {
    const rpcError = new Error("RPC Error 401: Access denied", { cause: { method: "accounts.list", code: 401, message: "Access denied" } });
    expect(isDaemonUnreachable(rpcError)).toBe(false);
  });

  it("treats a Node errno-style cause (has code but no method) as unreachable", () => {
    // Regression: Node's fetch() sets .cause to the underlying errno error (e.g. ECONNREFUSED),
    // which also has a `.code` — checking for `code` alone previously misclassified this as a real
    // RPC error instead of a connectivity failure.
    const nodeFetchError = new Error("fetch failed", { cause: { code: "ECONNREFUSED", errno: -4078 } });
    expect(isDaemonUnreachable(nodeFetchError)).toBe(true);
  });

  it("treats our own withTimeout() timeout error as unreachable", () => {
    expect(isDaemonUnreachable(new Error("Timed out after 15000ms while connecting to the daemon."))).toBe(true);
  });
});

describe("throwOnRejection", () => {
  it("does not throw for an Accept outcome", () => {
    expect(() => throwOnRejection("tx1", { Accept: {} } as never)).not.toThrow();
  });

  it("throws a clear message for a Reject outcome", () => {
    expect(() => throwOnRejection("tx1", { Reject: "SomeReason" } as never)).toThrow("Transaction tx1 was rejected");
  });

  it("throws a clear message for an AcceptFeeRejectRest outcome", () => {
    expect(() => throwOnRejection("tx1", { AcceptFeeRejectRest: [{}, "SomeReason"] } as never)).toThrow(
      "Transaction tx1 accepted the fee but rejected the rest"
    );
  });
});

describe("toIndexerResultShape", () => {
  it("maps a null result to Pending", () => {
    const response = { transaction_id: "tx1", result: null, status: "Pending", final_fee: 0n, timed_out: false } as TransactionWaitResultResponse;
    expect(toIndexerResultShape(response)).toEqual({ result: "Pending" });
  });

  it("wraps a finalized result into OotleAccount's IndexerGetTransactionResultResponse shape", () => {
    const finalize = {
      transaction_hash: "hash1",
      events: [],
      logs: [],
      execution_results: [],
      result: { Accept: {} },
      fee_receipt: {},
    } as never;
    const response = {
      transaction_id: "tx1",
      result: finalize,
      status: "Accepted",
      final_fee: 629n,
      timed_out: false,
    } as TransactionWaitResultResponse;

    const shaped = toIndexerResultShape(response).result as Extract<IndexerGetTransactionResultResponse["result"], { Finalized: unknown }>;
    expect("Finalized" in shaped).toBe(true);
    if ("Finalized" in shaped) {
      expect(shaped.Finalized.final_decision).toBe("Commit");
      expect(shaped.Finalized.execution_result?.finalize).toBe(finalize);
      expect(shaped.Finalized.abort_details).toBeNull();
    }
  });
});
