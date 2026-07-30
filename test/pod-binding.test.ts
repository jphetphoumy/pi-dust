import { afterEach, describe, expect, it, vi } from "vitest";
import { privateApiBaseUrl } from "../src/dust-auth.js";
import { creditsBaseUrl } from "../src/dust-credits.js";
import { podApiFor } from "../src/dust-pod-runtime.js";
import { DustSessionRuntime } from "../src/dust-runtime.js";
import {
  forgetPodBinding,
  getPodBinding,
  readDustState,
  savePodBinding,
} from "../src/dust-state.js";
import { makeSessionContext, readState, seedLoggedIn, useTempAgentDir } from "./helpers/dust-fixtures.js";

describe("pod bindings in the state file", () => {
  useTempAgentDir();

  it("round-trips a binding for a project root", () => {
    savePodBinding("/work/proj", {
      podId: "vlt_1",
      name: "proj",
      seen: { "main.py": { podMs: 7, hash: "h" } },
    });

    expect(getPodBinding("/work/proj")).toEqual({
      podId: "vlt_1",
      name: "proj",
      seen: { "main.py": { podMs: 7, hash: "h" } },
    });
  });

  it("returns null for a root that was never ingested", () => {
    expect(getPodBinding("/work/other")).toBeNull();
  });

  it("keeps bindings for other roots when one is saved", () => {
    savePodBinding("/work/a", { podId: "vlt_a", name: "a", seen: {} });
    savePodBinding("/work/b", { podId: "vlt_b", name: "b", seen: {} });

    expect(getPodBinding("/work/a")?.podId).toBe("vlt_a");
    expect(getPodBinding("/work/b")?.podId).toBe("vlt_b");
  });

  it("forgets one binding without disturbing the others", () => {
    savePodBinding("/work/a", { podId: "vlt_a", name: "a", seen: {} });
    savePodBinding("/work/b", { podId: "vlt_b", name: "b", seen: {} });

    forgetPodBinding("/work/a");

    expect(getPodBinding("/work/a")).toBeNull();
    expect(getPodBinding("/work/b")?.podId).toBe("vlt_b");
  });

  it("is a no-op when forgetting a root that has no binding", () => {
    savePodBinding("/work/a", { podId: "vlt_a", name: "a", seen: {} });

    forgetPodBinding("/work/never");

    expect(getPodBinding("/work/a")?.podId).toBe("vlt_a");
  });

  it("survives a state reload, since pods is a persisted state key", () => {
    // `pods` has to be listed in STATE_KEYS or `pickStateFields` silently drops
    // it on every read, and every session would re-ingest from scratch.
    savePodBinding("/work/proj", { podId: "vlt_1", name: "proj", seen: {} });

    expect(readDustState().pods?.["/work/proj"]?.podId).toBe("vlt_1");
    expect((readState().pods as Record<string, unknown>)["/work/proj"]).toBeDefined();
  });

  it("is not clobbered by a credential persist, which drops non-state fields", () => {
    savePodBinding("/work/proj", { podId: "vlt_1", name: "proj", seen: {} });

    seedLoggedIn({ access: "a", refresh: "r", expires: 1, workspaceId: "ws-1" });

    // seedLoggedIn rewrites the file wholesale, as a fresh login does; the
    // binding is expected to be gone. This pins the behaviour so a future
    // change that starts preserving it is a deliberate one.
    expect(getPodBinding("/work/proj")).toBeNull();
  });
});

describe("podApiFor", () => {
  useTempAgentDir();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function runtimeWith(credentials: Record<string, unknown> | null): DustSessionRuntime {
    const runtime = new DustSessionRuntime();
    runtime.sessionContext = makeSessionContext({
      getCredentials: () => credentials as never,
    });
    return runtime;
  }

  it("targets the private API base for the credential's region", () => {
    const api = podApiFor(runtimeWith({ workspaceId: "ws-1", region: "europe-west1" }));

    expect(api.baseUrl).toBe("https://eu.dust.tt/api/w/ws-1");
    expect(api.baseUrl).toBe(privateApiBaseUrl("europe-west1", "ws-1"));
  });

  it("shares one private-API base with the credits client", () => {
    expect(creditsBaseUrl("us-central1", "ws-1")).toBe(privateApiBaseUrl("us-central1", "ws-1"));
  });

  it("reads the token per request rather than capturing it once", () => {
    // An ingest of a few hundred files outlives a ~15 minute access token, so a
    // captured header would start failing partway through.
    const runtime = runtimeWith({ workspaceId: "ws-1", region: "us-central1" });
    const token = vi.spyOn(runtime, "currentAccessToken")
      .mockReturnValueOnce("first")
      .mockReturnValueOnce("second");
    const api = podApiFor(runtime);

    expect(api.getAuthHeaders().Authorization).toBe("Bearer first");
    expect(api.getAuthHeaders().Authorization).toBe("Bearer second");
    expect(token).toHaveBeenCalledTimes(2);
  });

  it("omits the Authorization header entirely when no token is available", () => {
    const runtime = runtimeWith({ workspaceId: "ws-1", region: "us-central1" });
    vi.spyOn(runtime, "currentAccessToken").mockReturnValue("");

    expect(podApiFor(runtime).getAuthHeaders().Authorization).toBeUndefined();
  });

  it("delegates refresh to the runtime's shared single-flight", async () => {
    const runtime = runtimeWith({ workspaceId: "ws-1", region: "us-central1" });
    const refresh = vi.spyOn(runtime, "refreshAccessToken").mockResolvedValue(true);

    await podApiFor(runtime).refreshAuth?.();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refuses to build an API for a logged-out session", () => {
    expect(() => podApiFor(runtimeWith(null))).toThrow(/Not logged in/);
    expect(() => podApiFor(runtimeWith({ region: "us-central1" }))).toThrow(/Not logged in/);
  });
});
