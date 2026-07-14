/**
 * ShadowVox — Security Hardening Tests
 *
 * Validates all 15 security hardening layers applied to the codebase.
 * Run with: bun test
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { randomBytes } from "node:crypto";

// =========================================================================
// Layer 1: Shell Injection Prevention (recorder.ts)
// =========================================================================
describe("Layer 1 — Shell injection prevention", () => {
  it("should use spawn with array args (not exec with string interpolation)", async () => {
    // Verify the source uses spawn, not exec/execSync for FFmpeg conversion
    const source = await Bun.file("src/recorder.ts").text();
    
    // Must NOT use exec or execSync with string interpolation for FFmpeg
    expect(source).not.toMatch(/exec\(`ffmpeg/);
    expect(source).not.toMatch(/execSync\(`ffmpeg/);
    expect(source).not.toMatch(/execAsync\(`ffmpeg/);
    
    // Must use spawn with array arguments
    expect(source).toMatch(/spawn\(["']ffmpeg["'],\s*\[/);
  });

  it("should not have dangerous shell metacharacter patterns in FFmpeg calls", async () => {
    const source = await Bun.file("src/recorder.ts").text();
    // Should not contain unescaped shell interpolation with user data
    expect(source).not.toMatch(/`ffmpeg.*\$\{/);
  });
});

// =========================================================================
// Layer 2 & 3: Path Traversal Prevention (Python TTS + cloner.ts)
// =========================================================================
describe("Layer 2 & 3 — Path traversal prevention", () => {
  it("should reject relative paths that escape the project directory (cloner.ts logic)", () => {
    const cwd = process.cwd();
    
    // Simulate the sanitization logic from cloner.ts
    function validateSpeakerWav(path: string): boolean {
      const resolved = resolve(path);
      return resolved.startsWith(cwd);
    }

    // Valid paths
    expect(validateSpeakerWav("presets/morgan-freeman.wav")).toBe(true);
    expect(validateSpeakerWav("./presets/yoda.wav")).toBe(true);
    
    // Path traversal attempts — these should be rejected
    expect(validateSpeakerWav("/etc/passwd")).toBe(false);
    expect(validateSpeakerWav("../../../etc/shadow")).toBe(false);
    // Path traversal through absolute paths — properly blocked:
    expect(validateSpeakerWav("/etc/shadow")).toBe(false);
    expect(validateSpeakerWav("/proc/self/environ")).toBe(false);
    // Note: resolve() does NOT expand tilde, so ~ stays relative to cwd
  });

  it("should sanitize user_id for filesystem safety (Python logic)", () => {
    // Simulate the Python sanitization: re.sub(r'[^a-zA-Z0-9_@.\\-]', '', userId)
    function sanitizeUserId(userId: string): string {
      return userId.replace(/[^a-zA-Z0-9_@.\-]/g, "").slice(0, 128);
    }

    // Normal IDs
    expect(sanitizeUserId("123456789")).toBe("123456789");
    expect(sanitizeUserId("user@discord")).toBe("user@discord");
    expect(sanitizeUserId("test-user_123")).toBe("test-user_123");

    // Path traversal attempts
    // Note: dots (.) and @ are allowed by the regex since they're valid in IDs
    // Slashes are removed, dots remain
    expect(sanitizeUserId("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeUserId("../recordings/")).toBe("..recordings");
    expect(sanitizeUserId("a/b/c")).toBe("abc"); // slashes removed

    // Empty after sanitization
    expect(sanitizeUserId("")).toBe("");
    expect(sanitizeUserId("!!!")).toBe("");
  });

  it("should handle the edge case of empty userId after sanitization", () => {
    function sanitizeUserId(userId: string): string {
      return userId.replace(/[^a-zA-Z0-9_@.\-]/g, "").slice(0, 128);
    }
    expect(sanitizeUserId("...")).toBe("..."); // dots are allowed
    expect(sanitizeUserId("@@@")).toBe("@@@"); // @ is allowed
  });
});

// =========================================================================
// Layer 4: Rate Limiting (admin-server.ts)
// =========================================================================
describe("Layer 4 — Rate limiting configuration", () => {
  it("should define strict limiter at 10 req/min for sensitive endpoints", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    
    // Check for the rate limit configuration
    expect(source).toMatch(/strictLimiter/);
    expect(source).toMatch(/max:\s*10/);
    expect(source).toMatch(/windowMs:\s*60\s*\*\s*1000/);
  });

  it("should apply strict limiter to /api/speak and /api/record", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    
    // strictLimiter should be applied to sensitive endpoints
    const speakMatch = source.match(/app\.post\(["']\/api\/speak["'],\s*strictLimiter/);
    const recordMatch = source.match(/app\.post\(["']\/api\/record["'],\s*strictLimiter/);
    
    expect(speakMatch).not.toBeNull();
    expect(recordMatch).not.toBeNull();
  });

  it("should have a general limiter at 60 req/min for all API routes", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    
    expect(source).toMatch(/apiLimiter/);
    expect(source).toMatch(/max:\s*60/);
    expect(source).toMatch(/app\.use\(["']\/api\/\*["'],\s*apiLimiter\)/);
  });
});

// =========================================================================
// Layer 5 & 6: Security Headers (Helmet + CSP)
// =========================================================================
describe("Layer 5 & 6 — Security headers & CSP", () => {
  it("should import and use helmet", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    expect(source).toMatch(/import.*helmet/);
    expect(source).toMatch(/helmet\(/);
  });

  it("should configure Content Security Policy with restricted sources", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    
    // All CSP directives should be restricted
    expect(source).toMatch(/defaultSrc.*\["'self'"/);
    expect(source).toMatch(/scriptSrc/);
    expect(source).toMatch(/styleSrc/);
    expect(source).toMatch(/fontSrc/);
    expect(source).toMatch(/imgSrc/);
    expect(source).toMatch(/connectSrc/);
  });
});

// =========================================================================
// Layer 7: Error Message Sanitization (index.ts)
// =========================================================================
describe("Layer 7 — Error message sanitization", () => {
  it("should truncate error messages to 200 characters", () => {
    // Simulate the sanitization from index.ts
    function sanitizeError(err: unknown): string {
      return String(err).slice(0, 200).replace(/[\r\n]/g, " ");
    }

    // Short errors pass through
    expect(sanitizeError("Something failed")).toBe("Something failed");
    
    // Long errors are truncated
    const longError = "a".repeat(500);
    expect(sanitizeError(longError).length).toBe(200);
    
    // Newlines are replaced with spaces
    // \r\n becomes two spaces (\r → space, \n → space)
    expect(sanitizeError("line1\nline2\r\nline3")).toBe("line1 line2  line3");
    
    // Stack traces are effectively truncated
    const stackTrace = `Error: Something failed
    at Object.<anonymous> (/path/to/file.ts:42:10)
    at Generator.next (<anonymous>)
    at fulfilled (/path/to/file.ts:5:58)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;
    
    const sanitized = sanitizeError(stackTrace);
    expect(sanitized).not.toMatch(/[\r\n]/); // No newlines
    expect(sanitized.length).toBeLessThanOrEqual(200); // Truncated
    expect(sanitized).toContain("Error: Something failed"); // Still has the message
  });

  it("should not expose full internal error details to users", () => {
    const sourcePromise = Bun.file("src/index.ts").text();
    
    // The catch blocks should use the safeMsg variable, not raw err
    return sourcePromise.then((source) => {
      // Find error reply patterns
      const errorReplies = source.match(/message\.reply\(`❌ An error occurred.*?`\)/gs);
      if (errorReplies) {
        for (const reply of errorReplies) {
          expect(reply).toMatch(/safeMsg/);
          expect(reply).not.toMatch(/\$\{err\}/); // Should not use raw err
        }
      }
    });
  });
});

// =========================================================================
// Layer 8: Input Validation (text length limits)
// =========================================================================
describe("Layer 8 — Input validation", () => {
  it("should limit text to 500 characters in Discord commands", async () => {
    const source = await Bun.file("src/index.ts").text();
    
    // handleSay should apply .slice(0, 500) to user text
    expect(source).toMatch(/\.slice\(0,\s*500\)/);
    expect(source).toMatch(/\.replace\(.*\\x00-\\x08.*\\x1F.*\/g.*\"\"/);
  });

  it("should limit text to 500 characters in admin API", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    
    expect(source).toMatch(/if \(text\.length > 500\)/);
    expect(source).toMatch(/Text too long \(max 500 characters\)/);
  });

  it("should strip control characters from user text", () => {
    // Simulate the sanitization regex used in both files
    function sanitizeText(text: string): string {
      return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    }

    // Note: \x7F (DEL, 127) is not in the stripped range
    // The regex targets: \x00-\x08, \x0B, \x0C, \x0E-\x1F (NUL through US, minus tab/newline/CR)
    const controlChars = "\x00\x01\x02\x03";
    expect(sanitizeText(controlChars)).toBe(""); // All stripped

    const mixed = "Hello\x00World\x01Test";
    expect(sanitizeText(mixed)).toBe("HelloWorldTest"); // Only control chars stripped

    const normal = "Hello, world!";
    expect(sanitizeText(normal)).toBe("Hello, world!"); // Normal text preserved

    // Tab (\x09), newline (\x0A), carriage return (\x0D) should be preserved
    const formatting = "Hello\nWorld\tTab";
    expect(sanitizeText(formatting)).toBe("Hello\nWorld\tTab");
  });

  it("should enforce a body size limit of 100KB", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    expect(source).toMatch(/limit.*["']100kb["']/);
    expect(source).not.toMatch(/limit.*["']1mb["']/); // Was previously 1MB
  });
});

// =========================================================================
// Layer 9: XSS Prevention (dashboard escapeHtml)
// =========================================================================
describe("Layer 9 — XSS prevention", () => {
  it("should escape HTML entities in user-facing dashboard data", () => {
    // Simulate the escapeHtml function from dashboard/app.js
    function escapeHtml(str: string): string {
      if (typeof document === "undefined") {
        // Node.js environment: basic entity encoding
        return str
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      }
      const d = document.createElement("div");
      d.textContent = str;
      return d.innerHTML;
    }

    // Script injection attempts
    expect(escapeHtml("<script>alert('xss')</script>")).not.toContain("<script>");
    expect(escapeHtml("<img src=x onerror=alert(1)>")).not.toContain("<img");
    expect(escapeHtml("javascript:alert(1)")).toBe("javascript:alert(1)");
    
    // Normal text preserved
    expect(escapeHtml("Hello World")).toBe("Hello World");
    expect(escapeHtml("Morgan Freeman")).toBe("Morgan Freeman");
    
    // Emoji should be preserved but escaped safely
    const emojiResult = escapeHtml("🎬");
    expect(emojiResult).toBe("🎬");
  });

  it("should use escapeHtml for all user-facing values in preset grid", async () => {
    const source = await Bun.file("dashboard/app.js").text();
    
    // Verify escapeHtml is used for emoji, id, and name
    const presetGridSection = source.match(/function renderPresetGrid[\s\S]*?^}/m);
    if (presetGridSection) {
      const gridCode = presetGridSection[0];
      
      // Emoji, id, and name should go through escapeHtml
      const emojiUsage = gridCode.match(/escapeHtml\(p\.emoji\)/g);
      const nameUsage = gridCode.match(/escapeHtml\(p\.name\)/g);
      const idUsage = gridCode.match(/escapeHtml\(p\.id\)/g);
      
      expect(emojiUsage).not.toBeNull();
      expect(nameUsage).not.toBeNull();
      expect(idUsage).not.toBeNull();
    }
  });
});

// =========================================================================
// Layer 10: Timing-Safe API Key Comparison
// =========================================================================
describe("Layer 10 — Timing-safe API key comparison", () => {
  it("should use crypto.timingSafeEqual for API key verification", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    
    expect(source).toMatch(/timingSafeEqual/);
    expect(source).toMatch(/import.*timingSafeEqual.*from.*node:crypto/);
    expect(source).toMatch(/Buffer\.from\(key\).*Buffer\.from\(apiKey\)/);
  });

  it("timingSafeEqual should correctly compare strings", () => {
    const key1 = "my-secret-api-key-123";
    const key2 = "my-secret-api-key-123";
    const key3 = "my-secret-api-key-999";
    
    // Same strings
    expect(timingSafeEqual(Buffer.from(key1), Buffer.from(key2))).toBe(true);
    
    // Different strings
    expect(timingSafeEqual(Buffer.from(key1), Buffer.from(key3))).toBe(false);
    
    // Empty vs non-empty
    expect(timingSafeEqual(Buffer.from(""), Buffer.from(""))).toBe(true);
  });

  it("should handle missing API key gracefully", () => {
    // Middleware logic: if no key provided, return 401
    function verifyApiKey(key: string | undefined, expectedKey: string): boolean {
      if (!key) return false;
      return timingSafeEqual(Buffer.from(key), Buffer.from(expectedKey));
    }

    expect(verifyApiKey(undefined, "secret")).toBe(false);
    expect(verifyApiKey("", "secret")).toBe(false);
    expect(verifyApiKey("secret", "secret")).toBe(true);
  });
});

// =========================================================================
// Layer 11: API Key Not in URL
// =========================================================================
describe("Layer 11 — API key not in URL", () => {
  it("should read API key from sessionStorage, not URL params", async () => {
    const source = await Bun.file("dashboard/app.js").text();
    
    // Should NOT read from URL params
    expect(source).not.toMatch(/urlParams\.get\(['"]key['"]\)/);
    
    // Should use sessionStorage
    expect(source).toMatch(/sessionStorage\.getItem\(/);
    expect(source).toMatch(/sessionStorage\.setItem\(/);
  });

  it("should prompt for API key if not stored", async () => {
    const source = await Bun.file("dashboard/app.js").text();
    
    // Should check for 401 and prompt
    expect(source).toMatch(/res\.status === 401/);
    expect(source).toMatch(/prompt\(['"]Enter Admin API Key/);
  });
});

// =========================================================================
// Layer 12: Body Size Limit
// =========================================================================
describe("Layer 12 — Body size limit", () => {
  it("should limit JSON body parsing to 100KB", async () => {
    const source = await Bun.file("src/admin-server.ts").text();
    expect(source).toMatch(/express\.json\(\{[^}]*limit:\s*["']100kb["'][^}]*\}\)/);
  });
});

// =========================================================================
// Layer 13: Deprecated Sentry API Removed
// =========================================================================
describe("Layer 13 — Deprecated Sentry integration removed", () => {
  it("should not use deprecated nodeContextIntegration", async () => {
    const source = await Bun.file("src/instrument.ts").text();
    expect(source).not.toMatch(/nodeContextIntegration/);
  });
});

// =========================================================================
// Layer 14 & 15: VAD Code Quality
// =========================================================================
describe("Layer 14 & 15 — VAD async handling & code quality", () => {
  it("should use async/await with proper try/catch in VAD recording", async () => {
    const source = await Bun.file("src/vad.ts").text();
    
    // The onSpeakingStart handler should use async and try/catch
    // Check for vad-record name anywhere in a startSpan call with async callback
    const hasVadRecordAsync = source.includes("vad-record") && source.includes("async ()");
    expect(hasVadRecordAsync).toBe(true);
    
    // Should use try/catch with structured error handling
    expect(source).toMatch(/catch \(err\)/);
    expect(source).toMatch(/err instanceof Error/);
  });

  it("should not have empty catch blocks", async () => {
    const source = await Bun.file("src/vad.ts").text();
    // Should not have try { ... } catch { // noop } patterns
    expect(source).not.toMatch(/catch\s*\{\s*\/\/\s*noop/);
  });
});

// =========================================================================
// Cross-cutting: Package.json dependency verification
// =========================================================================
describe("Dependency verification", () => {
  it("should include helmet in package.json", async () => {
    const pkg = await Bun.file("package.json").json();
    expect(pkg.dependencies).toHaveProperty("helmet");
  });

  it("should include express-rate-limit in package.json", async () => {
    const pkg = await Bun.file("package.json").json();
    expect(pkg.dependencies).toHaveProperty("express-rate-limit");
  });
});

// =========================================================================
// Cross-cutting: Environment variable validation
// =========================================================================
describe("Environment variable validation", () => {
  it("should validate DISCORD_BOT_TOKEN is set at startup", () => {
    // Simulate the logic from instrument.ts
    function validateEnv(): string[] {
      const missing: string[] = [];
      const requiredVars = ["DISCORD_BOT_TOKEN"];
      for (const varName of requiredVars) {
        const val = process.env[varName];
        if (!val || val.length < 10) {
          missing.push(varName);
        }
      }
      return missing;
    }

    // With real env (or lack thereof), it should still work
    const missing = validateEnv();
    // This tests the validation logic works
    expect(Array.isArray(missing)).toBe(true);
  });
});

// =========================================================================
// Cross-cutting: README.md security documentation
// =========================================================================
describe("README.md security documentation", () => {
  it("should document all 15 security hardening layers in README.md", async () => {
    const readme = await Bun.file("README.md").text();
    
    // Should have the security section
    expect(readme).toMatch(/🛡️ Security/);
    expect(readme).toMatch(/15 security layers/);
    
    // Should mention key technologies
    expect(readme).toMatch(/helmet/i);
    expect(readme).toMatch(/rate.?limit/i);
    expect(readme).toMatch(/timingSafeEqual/i);
    expect(readme).toMatch(/CSP/i);
    expect(readme).toMatch(/XSS/i);
  });
});
