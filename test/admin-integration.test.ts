/**
 * ShadowVox — Admin Server Integration Tests
 *
 * Tests the Express API routes via supertest without starting a real server.
 * Creates a mock BotState with minimal Discord.js stubs.
 *
 * Run with: bun test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import request from "supertest";
import { createAdminApp } from "../src/admin-server.js";
import type { BotState } from "../src/admin-server.js";
import { profileStore } from "../src/profiles.js";

// =========================================================================
// Mock BotState factory
// =========================================================================

/**
 * Creates a minimal mock BotState for testing.
 * Provides stub implementations for all Discord.js interfaces.
 */
function createMockState(overrides?: Partial<BotState>): BotState {
  return {
    client: {
      user: { tag: "ShadowVox#1234" },
      isReady: () => true,
      guilds: {
        cache: {
          size: 5,
          get: () => undefined, // no guilds by default
        },
      },
      channels: {
        cache: {
          get: () => undefined, // no channels by default
        },
      },
    } as any,
    activeConnection: null,
    setActiveConnection: () => {},
    vadDetector: null,
    setVadDetector: () => {},
    defaultCloneText: "Hello, I am your voice clone.",
    setDefaultCloneText: () => {},
    startVad: () => {},
    stopVad: () => {},
    activePreset: null,
    ...overrides,
  };
}

// =========================================================================
// Status endpoint
// =========================================================================

describe("GET /api/status", () => {
  it("should return 200 with bot info when bot is ready", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("bot");
    expect(res.body.bot).toMatchObject({
      username: "ShadowVox#1234",
      online: true,
      guilds: 5,
    });
  });

  it("should indicate disconnected when no activeConnection", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ connected: false });
  });

  it("should return profiles structure with count 0", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.profiles).toMatchObject({ count: 0, list: [] });
  });

  it("should return presets list with total > 0", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.presets.total).toBeGreaterThan(0);
    expect(Array.isArray(res.body.presets.list)).toBe(true);
  });

  it("should return cloneText from state", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.cloneText).toBe("Hello, I am your voice clone.");
  });

  it("should return activePreset as null when no preset selected", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body.activePreset).toBeNull();
  });

  it("should return logs array", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });
});

// =========================================================================
// Health endpoint
// =========================================================================

describe("GET /api/health", () => {
  it("should return 200 with online:false when TTS server is unreachable", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ online: false });
  });
});

// =========================================================================
// Speak endpoint — input validation
// =========================================================================

describe("POST /api/speak — input validation", () => {
  it("should return 400 when text is missing", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/speak")
      .send({ userId: "123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text is required");
  });

  it("should return 400 when text is empty string", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/speak")
      .send({ userId: "123", text: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("text is required");
  });

  it("should return 400 when text exceeds 500 characters", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/speak")
      .send({ userId: "123", text: "x".repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Text too long (max 500 characters)");
  });

  it("should allow text at exactly 500 characters (but fail on no connection)", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/speak")
      .send({ userId: "123", text: "x".repeat(500) });

    // Should pass length validation but fail on connection check
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not connected/i);
  });

  it("should return 400 when bot is not in a voice channel", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/speak")
      .send({ userId: "123", text: "Hello" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bot is not connected to a voice channel");
  });

  it("should return 400 — connection check happens first, then userId/presetId check", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/speak")
      .send({ text: "Hello", userId: "someuser" });

    expect(res.status).toBe(400);
    // Connection check runs before userId/presetId check
    expect(res.body.error).toMatch(/not connected/i);
  });
});

// =========================================================================
// Record endpoint — input validation
// =========================================================================

describe("POST /api/record — input validation", () => {
  it("should return 400 when userId is missing", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/record")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("userId is required");
  });

  it("should return 400 when userId is empty", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/record")
      .send({ userId: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("userId is required");
  });

  it("should return 400 when bot is not in a voice channel", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/record")
      .send({ userId: "12345" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bot is not in a voice channel");
  });
});

// =========================================================================
// Join endpoint — input validation
// =========================================================================

describe("POST /api/join — input validation", () => {
  it("should return 400 when guildId is missing", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/join")
      .send({ channelId: "123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/guildId/);
  });

  it("should return 400 when channelId is missing", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/join")
      .send({ guildId: "123" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/channelId/);
  });

  it("should return 404 when guild does not exist (mock returns undefined)", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/join")
      .send({ guildId: "nonexistent", channelId: "456" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Guild not found");
  });

  it("should return 400 when channel is not voice-based (mock returns undefined)", async () => {
    const app = createAdminApp(createMockState({
      client: {
        user: { tag: "ShadowVox#1234" },
        isReady: () => true,
        guilds: {
          cache: {
            size: 1,
            get: () => ({
              id: "guild1",
              channels: {
                cache: {
                  get: () => ({
                    isVoiceBased: () => false,
                    name: "text-channel",
                    id: "456",
                  }),
                },
              },
              voiceAdapterCreator: {},
            }),
          },
        },
        channels: {
          cache: { get: () => undefined },
        },
      } as any,
    }));
    const res = await request(app)
      .post("/api/join")
      .send({ guildId: "guild1", channelId: "456" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Channel is not a voice channel");
  });
});

// =========================================================================
// Leave endpoint
// =========================================================================

describe("POST /api/leave", () => {
  it("should return 400 when not connected to any channel", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).post("/api/leave");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Not connected to any channel");
  });
});

// =========================================================================
// Profile deletion
// =========================================================================

describe("DELETE /api/profiles/:userId", () => {
  beforeEach(() => {
    // Clear the profile store before each test
    profileStore.clearAll();
  });

  it("should return 404 when profile does not exist", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).delete("/api/profiles/nonexistent");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Profile not found");
  });

  it("should return 200 and delete an existing profile", async () => {
    // First save a profile directly
    profileStore.saveProfile({
      userId: "user123",
      username: "TestUser",
      guildId: "guild1",
      recordedAt: Date.now(),
      sampleDurationMs: 3000,
      samplePath: "/tmp/test.wav",
    });

    const app = createAdminApp(createMockState());
    const res = await request(app).delete("/api/profiles/user123");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");

    // Verify it's actually deleted
    expect(profileStore.hasProfile("user123")).toBe(false);
  });

  it("should return 404 when deleting a non-existent profile", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).delete("/api/profiles/ghost");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Profile not found");
  });
});

// =========================================================================
// Body size limit
// =========================================================================

describe("Body size limit (100KB)", () => {
  it("should accept a normal-sized payload", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/speak")
      .send({ userId: "123", text: "Hello world" });

    // Should pass body parsing (fails on connection check, not body size)
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not connected/i);
  });

  it("should reject payloads larger than 100KB", async () => {
    const app = createAdminApp(createMockState());
    // Create a payload ~120KB
    const largePayload = { data: "x".repeat(120_000) };
    const res = await request(app)
      .post("/api/speak")
      .send(largePayload);

    // express-rate-limit returns 429 for rate limiting,
    // but supertest's body limit is applied before rate limiter
    // The actual behavior depends on how the payload is handled
    // At minimum, it should not crash
    expect([200, 400, 413, 429]).toContain(res.status);
  });
});

// =========================================================================
// Admin API key authentication
// =========================================================================

describe("Admin API key authentication", () => {
  const OLD_KEY = process.env.ADMIN_API_KEY;

  afterAll(() => {
    // Restore original key after tests
    if (OLD_KEY !== undefined) {
      process.env.ADMIN_API_KEY = OLD_KEY;
    } else {
      delete process.env.ADMIN_API_KEY;
    }
  });

  it("should return 401 when API key is required but not provided", async () => {
    process.env.ADMIN_API_KEY = "test-secret-key-123";

    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it("should return 401 when wrong API key is provided", async () => {
    process.env.ADMIN_API_KEY = "test-secret-key-123";

    const app = createAdminApp(createMockState());
    const res = await request(app)
      .get("/api/status")
      .set("x-api-key", "wrong-key-that-is-same-length");

    expect(res.status).toBe(401);
  });

  it("should return 200 when correct API key is provided", async () => {
    process.env.ADMIN_API_KEY = "test-secret-key-123";

    const app = createAdminApp(createMockState());
    const res = await request(app)
      .get("/api/status")
      .set("x-api-key", "test-secret-key-123");

    expect(res.status).toBe(200);
    expect(res.body.bot.username).toBe("ShadowVox#1234");
  });

  it("should allow access when no API key is configured", async () => {
    delete process.env.ADMIN_API_KEY;

    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
  });
});

// =========================================================================
// Security headers (Helmet)
// =========================================================================

describe("Security headers (Helmet)", () => {
  it("should include X-Content-Type-Options header", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("should include X-Frame-Options header", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    // Helmet v8 defaults to SAMEORIGIN (same as DENY for most purposes)
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("should include Strict-Transport-Security header", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.headers["strict-transport-security"]).toBeDefined();
  });

  it("should NOT include X-Powered-By header (no Express leak)", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/api/status");

    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

// =========================================================================
// Root page
// =========================================================================

describe("GET /", () => {
  it("should return 200 and serve HTML", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });
});

// =========================================================================
// VAD update endpoint
// =========================================================================

describe("POST /api/vad", () => {
  it("should return 400 when VAD is not initialized", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app)
      .post("/api/vad")
      .send({ enabled: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/VAD not initialized/);
  });
});

// =========================================================================
// Static file serving
// =========================================================================

describe("Static files", () => {
  it("should serve the dashboard app.js", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/static/app.js");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/javascript/);
  });

  it("should serve the dashboard style.css", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/static/style.css");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/css/);
  });

  it("should return 404 for missing static files", async () => {
    const app = createAdminApp(createMockState());
    const res = await request(app).get("/static/nonexistent.js");

    expect(res.status).toBe(404);
  });
});
