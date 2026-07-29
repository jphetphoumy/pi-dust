import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCreditsJson } from "../src/dust-credits.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import { useTempAgentDir } from "./helpers/dust-fixtures.js";

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe("fetchCreditsJson", () => {
  useTempAgentDir();

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("retries once with the refreshed token after a 401", async () => {
    const runtime = new DustSessionRuntime();
    const fetchMock = vi.fn((_url: string, init?: { headers: Record<string, string> }) =>
      Promise.resolve(
        init?.headers.Authorization === "Bearer fresh"
          ? jsonResponse({ ok: true })
          : jsonResponse({}, 401),
      ));
    globalThis.fetch = fetchMock as never;

    vi.spyOn(runtime, "currentAccessToken")
      .mockReturnValueOnce("stale-token")
      .mockReturnValueOnce("fresh");
    vi.spyOn(runtime, "refreshAccessToken").mockResolvedValue(true);

    const result = await fetchCreditsJson(runtime, "https://x/api/w/w1/credits/my-usage");

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up without a second request when a successful refresh still yields no token", async () => {
    // Guards a case `refreshAccessToken()`'s boolean return can't itself rule
    // out: it reports success (the WorkOS call went through) but the token it
    // just published has already dropped out of `currentAccessToken()` — e.g.
    // an already-expired `expires` on the refresh response. Retrying with an
    // empty Authorization header would be worse than not retrying at all.
    const runtime = new DustSessionRuntime();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({}, 401)));
    globalThis.fetch = fetchMock as never;

    vi.spyOn(runtime, "currentAccessToken")
      .mockReturnValueOnce("stale-token")
      .mockReturnValueOnce("");
    vi.spyOn(runtime, "refreshAccessToken").mockResolvedValue(true);

    const result = await fetchCreditsJson(runtime, "https://x/api/w/w1/credits/my-usage");

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the refresh itself fails", async () => {
    const runtime = new DustSessionRuntime();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({}, 401)));
    globalThis.fetch = fetchMock as never;

    vi.spyOn(runtime, "currentAccessToken").mockReturnValue("stale-token");
    vi.spyOn(runtime, "refreshAccessToken").mockResolvedValue(false);

    const result = await fetchCreditsJson(runtime, "https://x/api/w/w1/credits/my-usage");

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("makes no request when there is no token to start with", async () => {
    const runtime = new DustSessionRuntime();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as never;
    vi.spyOn(runtime, "currentAccessToken").mockReturnValue("");

    const result = await fetchCreditsJson(runtime, "https://x/api/w/w1/credits/my-usage");

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
