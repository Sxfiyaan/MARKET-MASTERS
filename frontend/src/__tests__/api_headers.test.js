import { supabase } from "@/lib/supabase";
import { api, http } from "@/lib/api";

jest.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
    },
    from: jest.fn(),
  },
}));

describe("API Request Headers & Supabase Contract", () => {
  const originalEnvKey = process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY;
  let originalAdapter;

  beforeAll(() => {
    originalAdapter = http.defaults.adapter;
  });

  afterAll(() => {
    http.defaults.adapter = originalAdapter;
    process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY = originalEnvKey;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.REACT_APP_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_token_12345";
  });

  test("public registration strips stale session and sends only apikey, never Authorization", async () => {
    // Simulate stale session in browser storage
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: "stale-expired-user-jwt" } },
    });

    let capturedHeaders = null;
    http.defaults.adapter = async (config) => {
      capturedHeaders = config.headers;
      return {
        data: { ok: true },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };

    await api.post("/auth/register-team", {
      team_name: "Test",
      leader_email: "test@example.com",
    }, {
      // Simulate existing Authorization on caller config
      headers: { Authorization: "Bearer stale-token-from-caller" },
    });

    expect(capturedHeaders).not.toBeNull();
    // 1. apikey header must be present matching publishable key
    const apikey = capturedHeaders.apikey || (capturedHeaders.get && capturedHeaders.get("apikey"));
    expect(apikey).toBe("sb_publishable_test_token_12345");

    // 2. Authorization header must be completely stripped/absent for public registration
    const authHeader = capturedHeaders.Authorization || capturedHeaders.authorization || (capturedHeaders.get && capturedHeaders.get("authorization"));
    expect(authHeader).toBeFalsy();
  });

  test("protected route sends user session JWT in Authorization and publishable key in apikey", async () => {
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { access_token: "active-user-jwt-valid" } },
    });

    let capturedHeaders = null;
    http.defaults.adapter = async (config) => {
      capturedHeaders = config.headers;
      return {
        data: { status: "ACTIVE" },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };

    await api.post("/rounds/1/submit", { answer: "A" });

    expect(capturedHeaders).not.toBeNull();
    const apikey = capturedHeaders.apikey || (capturedHeaders.get && capturedHeaders.get("apikey"));
    expect(apikey).toBe("sb_publishable_test_token_12345");

    const authHeader = capturedHeaders.Authorization || (capturedHeaders.get && capturedHeaders.get("Authorization"));
    expect(authHeader).toBe("Bearer active-user-jwt-valid");
  });

  test("protected route with no active session sends apikey and no Authorization header", async () => {
    supabase.auth.getSession.mockResolvedValue({
      data: { session: null },
    });

    let capturedHeaders = null;
    http.defaults.adapter = async (config) => {
      capturedHeaders = config.headers;
      return {
        data: { phase: "WAITING" },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };

    await api.get("/rounds/1/status");

    expect(capturedHeaders).not.toBeNull();
    const apikey = capturedHeaders.apikey || (capturedHeaders.get && capturedHeaders.get("apikey"));
    expect(apikey).toBe("sb_publishable_test_token_12345");

    const authHeader = capturedHeaders.Authorization || capturedHeaders.authorization || (capturedHeaders.get && capturedHeaders.get("Authorization"));
    expect(authHeader).toBeFalsy();
  });
});
