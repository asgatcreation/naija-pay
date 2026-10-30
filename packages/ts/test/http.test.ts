import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HttpClient, type LogEvent } from "../src/core/http.ts";
import {
  AuthenticationError,
  DuplicateReferenceError,
  InsufficientFundsError,
  NetworkError,
  NotFoundError,
  PayoutStatusUnknownError,
  ProviderDownError,
  RateLimitedError,
  ValidationError,
} from "../src/core/errors.ts";

/** Builds a fake fetch that replays the given responses in order. */
function fakeFetch(
  responses: ({ status: number; body?: unknown; headers?: Record<string, string> } | Error)[],
) {
  const calls: { url: string; init: RequestInit }[] = [];
  let i = 0;
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body ?? {});
    return new Response(body, {
      status: next.status,
      headers: { "content-type": "application/json", ...next.headers },
    });
  };
  return { fn: fn as unknown as typeof globalThis.fetch, calls, attempts: () => i };
}

/** A client whose backoff never actually sleeps, and whose jitter is deterministic. */
function client(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<Parameters<typeof HttpClient.prototype.request>[0]> = {},
  options: Record<string, unknown> = {},
) {
  const slept: number[] = [];
  const c = new HttpClient({
    provider: "testprovider",
    baseUrl: "https://api.test.example/v1",
    headers: { authorization: "Bearer sk_test_EXAMPLE123" },
    fetch: fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    requestIdHeader: "x-request-id",
    ...options,
  });
  c.random = () => 0.5;
  void overrides;
  return { c, slept };
}

describe("retrying safe requests", () => {
  test("retries a 503 and succeeds, reporting the attempt count", async () => {
    const f = fakeFetch([{ status: 503 }, { status: 503 }, { status: 200, body: { ok: true } }]);
    const { c, slept } = client(f.fn);

    const response = await c.request({ method: "GET", path: "/transaction", safety: "safe" });

    assert.equal(response.status, 200);
    assert.equal(response.attempts, 3);
    assert.equal(f.attempts(), 3);
    assert.equal(slept.length, 2, "should have backed off between attempts");
    assert.ok(slept[1]! >= slept[0]!, "backoff should not shrink");
  });

  test("gives up after the configured attempts and raises the last error", async () => {
    const f = fakeFetch([{ status: 503 }]);
    const { c } = client(f.fn, {}, { retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 } });

    await assert.rejects(
      c.request({ method: "GET", path: "/x", safety: "safe" }),
      ProviderDownError,
    );
    assert.equal(f.attempts(), 2);
  });

  test("does not retry errors that are not retryable", async () => {
    const f = fakeFetch([{ status: 400, body: { message: "amount is required" } }]);
    const { c } = client(f.fn);

    await assert.rejects(c.request({ method: "GET", path: "/x", safety: "safe" }), ValidationError);
    assert.equal(f.attempts(), 1, "a validation error will fail identically on a retry");
  });

  test("honours Retry-After on a 429 instead of its own backoff", async () => {
    const f = fakeFetch([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200, body: {} },
    ]);
    const { c, slept } = client(f.fn);

    await c.request({ method: "GET", path: "/x", safety: "safe" });
    assert.deepEqual(slept, [2_000]);
  });

  test("retries a transport failure", async () => {
    const f = fakeFetch([new TypeError("fetch failed"), { status: 200, body: {} }]);
    const { c } = client(f.fn);

    const response = await c.request({ method: "GET", path: "/x", safety: "safe" });
    assert.equal(response.attempts, 2);
  });
});

describe("money-moving requests are never retried", () => {
  test("a 503 becomes PayoutStatusUnknownError, not a retry", async () => {
    const f = fakeFetch([{ status: 503 }, { status: 200, body: { ok: true } }]);
    const { c } = client(f.fn);

    await assert.rejects(
      c.request({
        method: "POST",
        path: "/transfer",
        safety: "money-moving",
        reference: "payout_01HQ",
        body: { amount: 500 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PayoutStatusUnknownError);
        assert.equal(error.retryable, false, "retrying a payout could pay twice");
        assert.equal(error.reference, "payout_01HQ");
        assert.match(error.message, /must NOT be retried/);
        assert.match(error.message, /query the status by reference/);
        return true;
      },
    );

    assert.equal(f.attempts(), 1, "the payout must be sent exactly once");
  });

  test("a transport failure becomes PayoutStatusUnknownError", async () => {
    const f = fakeFetch([new TypeError("socket hang up")]);
    const { c } = client(f.fn);

    await assert.rejects(
      c.request({
        method: "POST",
        path: "/transfer",
        safety: "money-moving",
        reference: "payout_01HQ",
      }),
      (error: unknown) => {
        assert.ok(error instanceof PayoutStatusUnknownError);
        assert.equal(error.reference, "payout_01HQ");
        return true;
      },
    );
    assert.equal(f.attempts(), 1);
  });

  test("falls back to the idempotency key when no reference is given", async () => {
    const f = fakeFetch([new TypeError("boom")]);
    const { c } = client(f.fn);

    await assert.rejects(
      c.request({
        method: "POST",
        path: "/transfer",
        safety: "money-moving",
        idempotencyKey: "idem_123",
      }),
      (error: unknown) => {
        assert.ok(error instanceof PayoutStatusUnknownError);
        assert.equal(error.reference, "idem_123");
        return true;
      },
    );
  });

  test("a 4xx on a money-moving request is still an ordinary typed error", async () => {
    // A rejected payout definitely did not happen, so it is safe to report plainly.
    const f = fakeFetch([{ status: 400, body: { message: "insufficient balance" } }]);
    const { c } = client(f.fn, {}, {
      classifyError: (status: number) =>
        status === 400 ? { error: InsufficientFundsError } : undefined,
    });

    await assert.rejects(
      c.request({ method: "POST", path: "/transfer", safety: "money-moving", reference: "p1" }),
      InsufficientFundsError,
    );
  });
});

describe("unsafe requests", () => {
  test("are not retried, but raise an ordinary network error", async () => {
    const f = fakeFetch([new TypeError("fetch failed")]);
    const { c } = client(f.fn);

    await assert.rejects(
      c.request({ method: "POST", path: "/customer", safety: "unsafe" }),
      NetworkError,
    );
    assert.equal(f.attempts(), 1);
  });
});

describe("error classification", () => {
  test("maps statuses onto typed errors by default", async () => {
    const cases: [number, unknown][] = [
      [401, AuthenticationError],
      [404, NotFoundError],
      [409, DuplicateReferenceError],
      [422, ValidationError],
      [429, RateLimitedError],
      [502, ProviderDownError],
    ];
    for (const [status, expected] of cases) {
      const f = fakeFetch([{ status }]);
      const { c } = client(f.fn, {}, { retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });
      await assert.rejects(
        c.request({ method: "GET", path: "/x", safety: "safe" }),
        expected as never,
        `status ${status}`,
      );
    }
  });

  test("keeps the provider's own message and code for support conversations", async () => {
    const f = fakeFetch([
      { status: 400, body: { message: "Invalid account number", code: "invalid_account" } },
    ]);
    const { c } = client(f.fn);

    await assert.rejects(
      c.request({ method: "GET", path: "/x", safety: "safe", operation: "banks.resolveAccount" }),
      (error: unknown) => {
        const e = error as ValidationError;
        assert.equal(e.providerMessage, "Invalid account number");
        assert.equal(e.providerCode, "invalid_account");
        assert.equal(e.provider, "testprovider");
        assert.equal(e.operation, "banks.resolveAccount");
        assert.equal(e.httpStatus, 400);
        return true;
      },
    );
  });

  test("an adapter's classifier overrides the status mapping", async () => {
    // Several providers return 200 with a failure in the body, or reuse 400 for
    // everything, so the adapter has the final say.
    const f = fakeFetch([{ status: 400, body: { code: "duplicate_reference" } }]);
    const { c } = client(f.fn, {}, {
      classifyError: (_status: number, body: unknown) =>
        (body as { code?: string })?.code === "duplicate_reference"
          ? { error: DuplicateReferenceError, message: "reference already used" }
          : undefined,
    });

    await assert.rejects(
      c.request({ method: "GET", path: "/x", safety: "safe" }),
      (error: unknown) => {
        assert.ok(error instanceof DuplicateReferenceError);
        assert.equal(error.message, "reference already used");
        return true;
      },
    );
  });

  test("survives a provider returning HTML instead of JSON", async () => {
    const f = fakeFetch([
      { status: 502, body: "<html><body>Bad Gateway</body></html>", headers: { "content-type": "text/html" } },
    ]);
    const { c } = client(f.fn, {}, { retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 } });

    await assert.rejects(
      c.request({ method: "GET", path: "/x", safety: "safe" }),
      ProviderDownError,
    );
  });

  test("captures the provider's request id", async () => {
    const f = fakeFetch([{ status: 404, headers: { "x-request-id": "req_abc123" } }]);
    const { c } = client(f.fn);

    await assert.rejects(c.request({ method: "GET", path: "/x", safety: "safe" }), (e: unknown) => {
      assert.equal((e as NotFoundError).requestId, "req_abc123");
      return true;
    });
  });
});

describe("request construction", () => {
  test("builds the URL with query parameters, skipping undefined", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const { c } = client(f.fn);

    await c.request({
      method: "GET",
      path: "transaction",
      query: { page: 1, status: "success", from: undefined },
      safety: "safe",
    });

    const url = new URL(f.calls[0]!.url);
    assert.equal(url.pathname, "/v1/transaction");
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("status"), "success");
    assert.ok(!url.searchParams.has("from"));
  });

  test("sends the idempotency key under the provider's own header name", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const { c } = client(f.fn);

    await c.request({
      method: "POST",
      path: "/charge",
      safety: "safe",
      idempotencyKey: "idem_123",
      idempotencyHeader: "X-Idempotency-Key",
      body: { amount: 500 },
    });

    const headers = f.calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["X-Idempotency-Key"], "idem_123");
    assert.equal(headers["content-type"], "application/json");
    assert.equal(f.calls[0]!.init.body, JSON.stringify({ amount: 500 }));
  });

  test("resolves per-request auth headers, for token-based providers", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    let calls = 0;
    const { c } = client(f.fn, {}, {
      authorize: () => {
        calls++;
        return { authorization: "Bearer token-from-oauth" };
      },
    });

    await c.request({ method: "GET", path: "/x", safety: "safe" });
    const headers = f.calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer token-from-oauth");
    assert.equal(calls, 1);
  });

  test("falls back to the global fetch when none is injected", () => {
    // Node, Bun, Deno and browsers all provide one, so this must not throw.
    assert.doesNotThrow(
      () => new HttpClient({ provider: "x", baseUrl: "https://example.test" }),
    );
  });

  test("refuses a fetch that is not callable, rather than failing at request time", () => {
    assert.throws(
      () =>
        new HttpClient({
          provider: "x",
          baseUrl: "https://example.test",
          fetch: {} as never,
        }),
      /no fetch implementation available/,
    );
  });
});

describe("logging", () => {
  test("never leaks a credential or an identifier into a log event", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const events: LogEvent[] = [];
    const { c } = client(f.fn, {}, { onLog: (e: LogEvent) => events.push(e) });

    await c.request({
      method: "GET",
      path: "/dedicated_account/0123456789",
      safety: "safe",
      operation: "virtualAccounts.get",
    });

    assert.equal(events.length, 1);
    const serialised = JSON.stringify(events);
    assert.ok(!serialised.includes("sk_test_EXAMPLE123"), "key leaked into a log event");
    assert.ok(!serialised.includes("0123456789"), "account number leaked into a log event");
    assert.equal(events[0]!.outcome, "success");
    assert.equal(events[0]!.operation, "virtualAccounts.get");
  });

  test("records each attempt, marking the ones that are retrying", async () => {
    const f = fakeFetch([{ status: 503 }, { status: 200, body: {} }]);
    const events: LogEvent[] = [];
    const { c } = client(f.fn, {}, { onLog: (e: LogEvent) => events.push(e) });

    await c.request({ method: "GET", path: "/x", safety: "safe" });

    assert.equal(events.length, 2);
    assert.equal(events[0]!.outcome, "retrying");
    assert.equal(events[0]!.attempt, 1);
    assert.equal(events[1]!.outcome, "success");
    assert.equal(events[1]!.attempt, 2);
  });
});
