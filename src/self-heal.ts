/**
 * ⚕️ Self-Heal Engine — Autonomous AI Code Maintenance System
 *
 * Continuously analyzes, fixes, and upgrades the Shadow-Vox codebase.
 *
 * Features:
 *   • Local static analysis (zero external dependencies)
 *   • Optional HuggingFace Inference API integration (free tier, no key needed)
 *   • TypeScript error parsing & auto-fix
 *   • Code quality pattern detection
 *   • Auto-upgrade code patterns
 *   • CI-ready JSON output
 *
 * Usage:
 *   bunx tsx src/self-heal.ts           # Run full diagnostic (read-only)
 *   bunx tsx src/self-heal.ts --fix      # Run diagnostic + apply auto-fixes
 *   bunx tsx src/self-heal.ts --upgrade  # Full diagnostic + auto-fixes + code upgrades
 *   bunx tsx src/self-heal.ts --ci       # CI-friendly JSON output
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, relative, resolve, basename, dirname } from "path";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AnalysisIssue {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  suggestion?: string;
  autoFixAvailable: boolean;
}

export interface AnalysisReport {
  timestamp: string;
  summary: {
    filesScanned: number;
    totalIssues: number;
    errors: number;
    warnings: number;
    infos: number;
    autoFixable: number;
    autoFixed: number;
  };
  issues: AnalysisIssue[];
  typeErrors: AnalysisIssue[];
  testFailures: string[];
  codeHealth: {
    unusedImports: number;
    missingErrorHandling: number;
    hardcodedValues: number;
    anyTypes: number;
    codeDuplication: number;
    documentationGaps: number;
  };
  upgradeApplied: boolean;
  errors: string[];
}

// ─── Configuration ───────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");

const SRC_DIRS = ["src", "dashboard"];

const PYTHON_DIRS = ["python"];

const IGNORED_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /_generated/,
  /\.wav$/,
  /\.pcm$/,
];

const FILE_EXTENSIONS = [".ts", ".js", ".html", ".css", ".py", ".json"];

// Patterns that indicate missing error handling
const MISSING_TRY_CATCH_PATTERNS = [
  { pattern: /async\s+\w+\s*\(/, checkNext: /(?!\s*\{[^}]*try\b)/ },
];

// Hardcoded values that should be env vars
const HARDCODED_PATTERNS = [
  { pattern: /"https?:\/\/[^"]*"/, severity: "warning" as const },
  { pattern: /const\s+\w+\s*=\s*["'][a-zA-Z0-9_]{32,}["']/, severity: "error" as const },
  { pattern: /password\s*[:=]\s*["'][^"']+["']/i, severity: "error" as const },
  { pattern: /secret\s*[:=]\s*["'][^"']+["']/i, severity: "error" as const },
  { pattern: /token\s*[:=]\s*["'][^"']+["']/i, severity: "warning" as const },
  { pattern: /api[_-]?key\s*[:=]\s*["'][^"']+["']/i, severity: "error" as const },
];

// Patterns indicating `any` type usage
const ANY_TYPE_PATTERNS = [
  /:\s*any\b/,
  /as\s+any\b/,
  /<any>/,
  /\[\]:\s*any/,
];

// Known fix templates
const FIX_TEMPLATES: Record<string, (file: string, line: number) => string | null> = {
  "missing-try-catch": (file, line) => {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    if (line >= lines.length) return null;
    
    const indent = lines[line - 1]?.match(/^\s*/)?.[0] || "  ";
    const funcLine = lines[line - 1];
    
    return `try {\n${indent}${funcLine}\n${indent}} catch (err) {\n${indent}  console.error(\`Error in ${basename(file)}:\`, err);\n${indent}}`;
  },
};

// ─── Analyzers ───────────────────────────────────────────────────────────────

/**
 * Collect all source files recursively
 */
function collectSourceFiles(): string[] {
  const files: string[] = [];
  
  for (const dir of SRC_DIRS) {
    collectFiles(resolve(ROOT, dir), files);
  }
  for (const dir of PYTHON_DIRS) {
    collectFiles(resolve(ROOT, dir), files);
  }
  
  // Root files
  for (const f of ["package.json", "tsconfig.json", ".env.example", "README.md"]) {
    const p = resolve(ROOT, f);
    if (existsSync(p)) files.push(p);
  }
  
  return files;
}

function collectFiles(dir: string, acc: string[]): void {
  if (!existsSync(dir)) return;
  const entries = execSync(`ls -1 "${dir}"`, { encoding: "utf-8" }).split("\n").filter(Boolean);
  
  for (const entry of entries) {
    const full = join(dir, entry);
    if (IGNORED_PATTERNS.some((p) => p.test(full))) continue;
    
    const stat = existsSync(full) ? execSync(`stat -c%F "${full}"`, { encoding: "utf-8" }).trim() : "";
    if (stat === "directory") {
      collectFiles(full, acc);
    } else if (FILE_EXTENSIONS.some((ext) => full.endsWith(ext))) {
      acc.push(full);
    }
  }
}

/**
 * Run TypeScript compiler check
 */
function checkTypeScriptErrors(): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];
  
  try {
    const output = execSync("bun tsc -b --noEmit 2>&1", {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 30000,
    });
    return issues; // No errors
  } catch (err: any) {
    const output = err.stdout || err.message || "";
    const lines = output.split("\n");
    
    let currentFile = "";
    for (const line of lines) {
      // Parse TypeScript error format: src/file.ts(123,45): error TS2345: Message
      const tsMatch = line.match(/^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
      if (tsMatch) {
        issues.push({
          file: tsMatch[1],
          line: parseInt(tsMatch[2]),
          column: parseInt(tsMatch[3]),
          severity: tsMatch[4] === "error" ? "error" : "warning",
          code: tsMatch[5],
          message: tsMatch[6],
          suggestion: generateTSSuggestion(tsMatch[5], tsMatch[6]),
          autoFixAvailable: isTSAutoFixable(tsMatch[5]),
        });
      }
    }
  }
  
  return issues;
}

/**
 * Generate fix suggestions for TypeScript errors
 */
function generateTSSuggestion(code: string, message: string): string | undefined {
  const suggestions: Record<string, string> = {
    "TS2304": `Cannot find name — check import or declare the variable.`,
    "TS2322": `Type mismatch — add explicit type annotation or fix the value type.`,
    "TS2339": `Property does not exist — check the type definition or add optional chaining (?.).`,
    "TS2345": `Argument type mismatch — ensure the passed value matches the parameter type.`,
    "TS2554": `Wrong number of arguments — check the function signature.`,
    "TS6133": `Unused variable — prefix with underscore (_) or remove it.`,
    "TS6196": `Unused export — remove the export keyword or use the export.`,
    "TS7006": `Parameter implicitly has 'any' type — add explicit type annotation.`,
    "TS7031": `Binding element implicitly has 'any' type — add type annotation.`,
    "TS7053": `Element implicitly has 'any' type — add index signature or type assertion.`,
  };
  
  return suggestions[code] || undefined;
}

function isTSAutoFixable(code: string): boolean {
  const autoFixable = ["TS6133", "TS6196", "TS7006", "TS7031", "TS7053"];
  return autoFixable.includes(code);
}

/**
 * Run test suite and parse failures
 */
function checkTestFailures(): string[] {
  const failures: string[] = [];
  
  try {
    const output = execSync("bun test 2>&1", {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 60000,
    });
    
    // Parse test output for failures
    const lines = output.split("\n");
    let inFailure = false;
    for (const line of lines) {
      if (line.includes("FAIL") || line.includes("✗") || line.includes("×")) {
        inFailure = true;
        failures.push(line.trim());
      } else if (inFailure && line.trim() && !line.startsWith(" ")) {
        inFailure = false;
      } else if (inFailure) {
        failures.push(line.trim());
      }
    }
  } catch (err: any) {
    failures.push(`Test suite crashed: ${err.message}`);
  }
  
  return failures;
}

/**
 * Static code analysis — detect code quality issues
 */
function analyzeCodeQuality(file: string): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];
  
  if (!existsSync(file)) return issues;
  if (!FILE_EXTENSIONS.some((ext) => file.endsWith(ext))) return issues;
  
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const relPath = relative(ROOT, file);
    
    // Check for missing error handling in async functions
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      
      // Missing try/catch in async functions
      if (line.match(/async\s+\w+\s*\(/) && !content.includes(`try {`)) {
        // Only flag if the function doesn't have try at all
        const funcName = line.match(/async\s+(\w+)/)?.[1] || "function";
        if (!content.includes(`catch`)) {
          issues.push({
            file: relPath,
            line: lineNum,
            column: 1,
            severity: "warning",
            code: "missing-error-handling",
            message: `Async function '${funcName}' has no try/catch error handling`,
            suggestion: `Wrap the function body in try/catch or add .catch() handler`,
            autoFixAvailable: false,
          });
        }
      }
      
      // Hardcoded values
      for (const hp of HARDCODED_PATTERNS) {
        const match = line.match(hp.pattern);
        if (match && !line.trim().startsWith("//") && !line.trim().startsWith("*")) {
          issues.push({
            file: relPath,
            line: lineNum,
            column: line.indexOf(match[0]) + 1,
            severity: hp.severity,
            code: "hardcoded-value",
            message: `Potential hardcoded ${match[0].length > 40 ? match[0].substring(0, 40) + "..." : match[0]}`,
            suggestion: `Move to .env file and access via process.env`,
            autoFixAvailable: false,
          });
        }
      }
      
      // `any` type usage
      for (const ap of ANY_TYPE_PATTERNS) {
        const match = line.match(ap);
        if (match) {
          issues.push({
            file: relPath,
            line: lineNum,
            column: line.indexOf(match[0]) + 1,
            severity: "warning",
            code: "any-type",
            message: `Usage of 'any' type — consider using a more specific type`,
            suggestion: `Replace 'any' with the actual type or use 'unknown' if type is truly unknown`,
            autoFixAvailable: false,
          });
        }
      }
      
      // Console.log in production code (not test files)
      if (line.match(/console\.(log|dir)\s*\(/) && !relPath.includes("test/") && !line.trim().startsWith("//")) {
        issues.push({
          file: relPath,
          line: lineNum,
          column: line.indexOf("console") + 1,
          severity: "info",
          code: "console-log",
          message: `Console.${line.match(/console\.(\w+)/)?.[1] || "log"} in production code`,
          suggestion: `Use a proper logging library or remove before production`,
          autoFixAvailable: false,
        });
      }
    }
    
    // Check for duplicate code blocks (simple heuristic: repeated 5+ line blocks)
    const blockMap = new Map<string, number[]>();
    for (let i = 0; i < lines.length - 4; i++) {
      const block = lines.slice(i, i + 5).join("\n").trim();
      if (block.length > 50) {
        if (blockMap.has(block)) {
          blockMap.get(block)!.push(i + 1);
        } else {
          blockMap.set(block, [i + 1]);
        }
      }
    }
    
    for (const [block, lineNumbers] of blockMap) {
      if (lineNumbers.length > 1) {
        issues.push({
          file: relPath,
          line: lineNumbers[0],
          column: 1,
          severity: "info",
          code: "code-duplication",
          message: `Code block duplicated at lines ${lineNumbers.join(", ")}`,
          suggestion: `Extract the duplicate code into a shared function`,
          autoFixAvailable: false,
        });
      }
    }
    
  } catch (err) {
    // Skip files that can't be read
  }
  
  return issues;
}

/**
 * Analyze documentation coverage
 */
function analyzeDocumentation(file: string): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];
  
  if (!existsSync(file)) return issues;
  if (!file.endsWith(".ts")) return issues;
  
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const relPath = relative(ROOT, file);
    
    // Check exported functions for JSDoc
    const funcRegex = /^export\s+(async\s+)?function\s+(\w+)/;
    const constFuncRegex = /^export\s+(const|let|var)\s+(\w+)\s*[:=]\s*(async\s+)?\(/;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      
      const funcMatch = line.match(funcRegex) || line.match(constFuncRegex);
      if (funcMatch) {
        const funcName = funcMatch[2];
        // Check if previous line is a JSDoc comment
        const prevLine = lines[i - 1]?.trim() || "";
        const prevPrevLine = lines[i - 2]?.trim() || "";
        
        if (!prevLine.startsWith("*") && !prevLine.startsWith("/**") && !prevPrevLine.startsWith("/**")) {
          issues.push({
            file: relPath,
            line: lineNum,
            column: 1,
            severity: "info",
            code: "missing-docs",
            message: `Exported function '${funcName}' has no JSDoc comment`,
            suggestion: `Add /** Description, @param, @returns */ documentation`,
            autoFixAvailable: false,
          });
        }
      }
    }
  } catch (err) {
    // Skip
  }
  
  return issues;
}

/**
 * Check for unused imports (simple heuristic)
 */
function checkUnusedImports(file: string): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];
  
  if (!existsSync(file) || !file.endsWith(".ts")) return issues;
  
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const relPath = relative(ROOT, file);
    
    const importRegex = /import\s+\{\s*([^}]+)\}\s+from\s+["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    
    while ((match = importRegex.exec(content)) !== null) {
      const imports = match[1].split(",").map((s) => s.trim());
      const importLine = match[0];
      const lineNum = content.substring(0, match.index).split("\n").length;
      
      for (const imp of imports) {
        // Strip 'type' keyword from type-only imports
        const clean = imp.replace(/^\s*type\s+/, "").trim();
        const name = clean.split(" as ").pop()?.trim() || clean;
        if (!name) continue;
        
        // Check if the import is used elsewhere in the file
        const usageRegex = new RegExp(`\\b${escapeRegex(name)}\\b`, "g");
        let count = 0;
        let usageMatch: RegExpExecArray | null;
        while ((usageMatch = usageRegex.exec(content)) !== null) {
          count++;
        }
        
        // Each import creates at least one occurrence (the import itself)
        if (count <= 1) {
          issues.push({
            file: relPath,
            line: lineNum,
            column: importLine.indexOf(name) + 1,
            severity: "warning",
            code: "unused-import",
            message: `Unused import: '${name}'`,
            suggestion: `Remove the import '${name}' from the import statement`,
            autoFixAvailable: true,
          });
        }
      }
    }
  } catch (err) {
    // Skip
  }
  
  return issues;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Check Python files for issues
 */
function analyzePythonFile(file: string): AnalysisIssue[] {
  const issues: AnalysisIssue[] = [];
  
  if (!existsSync(file) || !file.endsWith(".py")) return issues;
  
  try {
    const content = readFileSync(file, "utf-8");
    const lines = content.split("\n");
    const relPath = relative(ROOT, file);
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      
      // Bare except: clauses
      if (line.match(/^\s*except\s*:/)) {
        issues.push({
          file: relPath,
          line: lineNum,
          column: 1,
          severity: "warning",
          code: "bare-except",
          message: "Bare 'except:' clause catches all exceptions including SystemExit",
          suggestion: "Use 'except Exception:' or catch specific exception types",
          autoFixAvailable: false,
        });
      }
      
      // Hardcoded secrets in Python
      if (line.match(/^(PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*["']/i)) {
        issues.push({
          file: relPath,
          line: lineNum,
          column: 1,
          severity: "error",
          code: "hardcoded-secret",
          message: "Hardcoded credential in Python file",
          suggestion: "Use environment variables via os.environ.get()",
          autoFixAvailable: false,
        });
      }
      
      // Print statements (not in scripts)
      if (line.match(/^\s*print\(/) && lineNum > 10) {
        issues.push({
          file: relPath,
          line: lineNum,
          column: 1,
          severity: "info",
          code: "print-statement",
          message: "print() statement — consider using logging module",
          suggestion: "Replace with logging.info() or similar",
          autoFixAvailable: false,
        });
      }
    }
    
    // Check for missing __pycache__ ignores
    if (relPath === "python/tts_server.py" && !content.includes("uvicorn.run")) {
      issues.push({
        file: relPath,
        line: lines.length,
        column: 1,
        severity: "info",
        code: "missing-entry",
        message: "No uvicorn.run() entry point found",
        suggestion: "Add the standard __name__ == '__main__' block",
        autoFixAvailable: false,
      });
    }
    
  } catch (err) {
    // Skip
  }
  
  return issues;
}

/**
 * Check for outdated dependencies
 */
function checkDependencies(): string[] {
  const warnings: string[] = [];
  const pkgPath = resolve(ROOT, "package.json");
  
  if (!existsSync(pkgPath)) return warnings;
  
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    
    // Check for known deprecated or problematic packages
    const knownIssues: Record<string, string> = {
      "prism-media": "Consider updating to latest version for Discord.js compatibility",
      "@discordjs/voice": "Ensure this matches your discord.js version",
    };
    
    for (const [dep, msg] of Object.entries(knownIssues)) {
      if (dep in allDeps) {
        warnings.push(`${dep}: ${msg}`);
      }
    }
    
    // Check for peer dependency conflicts
    if (allDeps["discord.js"] && allDeps["@discordjs/voice"]) {
      warnings.push("Verify discord.js and @discordjs/voice versions are compatible");
    }
  } catch {
    warnings.push("Could not parse package.json");
  }
  
  return warnings;
}

// ─── Auto-Fix Engine ─────────────────────────────────────────────────────────

/**
 * Apply auto-fixes to the codebase
 */
function applyAutoFixes(report: AnalysisReport): number {
  let fixedCount = 0;
  
  // Fix unused imports
  for (const issue of report.issues) {
    if (!issue.autoFixAvailable) continue;
    
    if (issue.code === "unused-import" && issue.file.endsWith(".ts")) {
      const fullPath = resolve(ROOT, issue.file);
      if (!existsSync(fullPath)) continue;
      
      try {
        const content = readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        const lineIdx = issue.line - 1;
        
        if (lineIdx < 0 || lineIdx >= lines.length) continue;
        
        const importLine = lines[lineIdx];
        const importMatch = importLine.match(/import\s+\{\s*([^}]+)\}\s+from/);
        
        if (importMatch) {
          const allImports = importMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
          const unusedName = extractUnusedName(issue.message);
          
          if (unusedName) {
            const filtered = allImports.filter((imp) => {
              const name = imp.split(" as ").pop()?.trim() || imp;
              return name !== unusedName;
            });
            
            if (filtered.length === 0) {
              // Remove entire import line
              lines.splice(lineIdx, 1);
            } else if (filtered.length === allImports.length - 1 && allImports.length > 1) {
              // Remove just the unused import
              const remainingImports = filtered.join(", ");
              lines[lineIdx] = importLine.replace(/\{[^}]+\}/, `{ ${remainingImports} }`);
            }
            
            writeFileSync(fullPath, lines.join("\n"), "utf-8");
            fixedCount++;
          }
        }
      } catch {
        // Skip if fix fails
      }
    }
  }
  
  return fixedCount;
}

function extractUnusedName(message: string): string | null {
  const match = message.match(/'([^']+)'/);
  return match ? match[1] : null;
}

/**
 * Apply code upgrades (modern syntax, better patterns)
 */
function applyCodeUpgrades(): number {
  let upgradedCount = 0;
  const files = collectSourceFiles().filter((f) => f.endsWith(".ts"));
  
  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      let upgraded = content;
      
      // Upgrade 1: Replace var with const/let
      upgraded = upgraded.replace(/\bvar\s+(\w+)\s*=/g, "const $1 =");
      
      // Upgrade 2: Replace .then() chains with async/await where safe
      // (simple pattern — deep analysis would need AST)
      
      // Upgrade 3: Add .js extension to local imports (ESM compat)
      upgraded = upgraded.replace(
        /(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
        (match, prefix, path, suffix) => {
          // Only add .js if no extension already
          if (path.endsWith(".js") || path.endsWith(".ts") || path.endsWith(".json")) return match;
          // Don't add .js to npm packages (starts with letter)
          if (path.match(/^\.\.?\//)) {
            return `${prefix}${path}.js${suffix}`;
          }
          return match;
        }
      );
      
      if (upgraded !== content) {
        writeFileSync(file, upgraded, "utf-8");
        upgradedCount++;
      }
    } catch {
      // Skip
    }
  }
  
  return upgradedCount;
}

// ─── HuggingFace AI Connector (Optional, Free Tier) ──────────────────────────

interface HFSuggestion {
  file: string;
  line: number;
  suggestion: string;
  explanation: string;
}

/**
 * Use HuggingFace Inference API (free tier, no API key required for some models)
 * to get smart suggestions for complex issues
 */
async function queryHuggingFaceAI(issues: AnalysisIssue[]): Promise<HFSuggestion[]> {
  const suggestions: HFSuggestion[] = [];
  
  // Only query for complex issues that need AI reasoning
  const complexIssues = issues.filter(
    (i) => i.code === "missing-error-handling" || i.code === "any-type" || i.code === "hardcoded-value"
  );
  
  if (complexIssues.length === 0) return suggestions;
  
  const HF_MODEL = "codellama/CodeLlama-7b-hf";
  const HF_API = `https://api-inference.huggingface.co/models/${HF_MODEL}`;
  
  for (const issue of complexIssues.slice(0, 5)) {
    // Limit to 5 to avoid rate limits on free tier
    try {
      const prompt = createFixPrompt(issue);
      const response = await fetch(HF_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inputs: prompt,
          parameters: {
            max_new_tokens: 150,
            temperature: 0.2,
            return_full_text: false,
          },
        }),
      });
      
      if (response.ok) {
        const result: any = await response.json();
        const text = Array.isArray(result) ? result[0]?.generated_text || "" : result.generated_text || "";
        
        if (text.trim()) {
          suggestions.push({
            file: issue.file,
            line: issue.line,
            suggestion: text.trim().split("\n")[0],
            explanation: `AI-generated fix for '${issue.code}' issue`,
          });
        }
      }
    } catch {
      // HF API unavailable — graceful fallback
      continue;
    }
  }
  
  return suggestions;
}

function createFixPrompt(issue: AnalysisIssue): string {
  return `Fix this TypeScript issue in file ${issue.file} at line ${issue.line}:
Issue: ${issue.message}
Suggestion: ${issue.suggestion || "Provide a fix"}
Provide only the fixed code line(s), no explanation:`;
}

// ─── CI Report Generation ────────────────────────────────────────────────────

function generateCIReport(report: AnalysisReport): string {
  const ciReport = {
    passed: report.summary.errors === 0 && report.typeErrors.length === 0,
    timestamp: report.timestamp,
    summary: report.summary,
    criticalIssues: report.issues.filter((i) => i.severity === "error").length,
    typeErrors: report.typeErrors.length,
    testFailures: report.testFailures.length,
    codeHealth: report.codeHealth,
    issuesByFile: groupByFile(report.issues),
  };
  
  return JSON.stringify(ciReport, null, 2);
}

function groupByFile(issues: AnalysisIssue[]): Record<string, number> {
  const grouped: Record<string, number> = {};
  for (const issue of issues) {
    grouped[issue.file] = (grouped[issue.file] || 0) + 1;
  }
  return grouped;
}

// ─── Main Analyzer ───────────────────────────────────────────────────────────

export async function runFullDiagnostic(options: {
  fix?: boolean;
  upgrade?: boolean;
  ci?: boolean;
} = {}): Promise<AnalysisReport> {
  const startTime = Date.now();
  const errors: string[] = [];
  
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   ⚕️  Shadow-Vox Self-Heal Engine v2.0        ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log(`\n🔍 Starting diagnostic at ${new Date().toISOString()}`);
  
  // Step 1: Collect files
  console.log("\n📁 Scanning source files...");
  const files = collectSourceFiles();
  console.log(`   Found ${files.length} source files`);
  
  // Step 2: TypeScript error check
  console.log("\n📐 Checking TypeScript compilation...");
  const typeErrors = checkTypeScriptErrors();
  console.log(`   Found ${typeErrors.length} TypeScript error(s)`);
  if (typeErrors.length > 0) {
    for (const err of typeErrors) {
      console.log(`   ❌ ${err.file}:${err.line}:${err.column} - ${err.code}: ${err.message}`);
    }
  }
  
  // Step 3: Run tests
  console.log("\n🧪 Running test suite...");
  const testFailures = checkTestFailures();
  console.log(`   ${testFailures.length > 0 ? `❌ ${testFailures.length} failure(s)` : "✅ All tests pass"}`);
  
  // Step 4: Static analysis
  console.log("\n🔎 Running static code analysis...");
  const allIssues: AnalysisIssue[] = [];
  
  for (const file of files) {
    const qualityIssues = analyzeCodeQuality(file);
    const docIssues = analyzeDocumentation(file);
    const unusedImports = checkUnusedImports(file);
    const pythonIssues = analyzePythonFile(file);
    
    allIssues.push(...qualityIssues, ...docIssues, ...unusedImports, ...pythonIssues);
  }
  
  // Step 5: Dependency check
  console.log("\n📦 Checking dependencies...");
  const depWarnings = checkDependencies();
  for (const w of depWarnings) {
    console.log(`   ⚠️  ${w}`);
  }
  
  // Step 6: Compile health metrics
  const health = {
    unusedImports: allIssues.filter((i) => i.code === "unused-import").length,
    missingErrorHandling: allIssues.filter((i) => i.code === "missing-error-handling").length,
    hardcodedValues: allIssues.filter((i) => i.code === "hardcoded-value").length,
    anyTypes: allIssues.filter((i) => i.code === "any-type").length,
    codeDuplication: allIssues.filter((i) => i.code === "code-duplication").length,
    documentationGaps: allIssues.filter((i) => i.code === "missing-docs").length,
  };
  
  const issues = [...typeErrors, ...allIssues];
  const errorsCount = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const infos = issues.filter((i) => i.severity === "info").length;
  const autoFixable = issues.filter((i) => i.autoFixAvailable).length;
  
  const report: AnalysisReport = {
    timestamp: new Date().toISOString(),
    summary: {
      filesScanned: files.length,
      totalIssues: issues.length,
      errors: errorsCount,
      warnings,
      infos,
      autoFixable,
      autoFixed: 0,
    },
    issues,
    typeErrors,
    testFailures,
    codeHealth: health,
    upgradeApplied: false,
    errors,
  };
  
  // Step 7: Apply auto-fixes (if --fix)
  if (options.fix || options.upgrade) {
    console.log("\n🛠️  Applying auto-fixes...");
    const fixedCount = applyAutoFixes(report);
    report.summary.autoFixed = fixedCount;
    console.log(`   Fixed ${fixedCount} issue(s)`);
    
    if (fixedCount > 0) {
      console.log("   ⚠️  Re-running typecheck after fixes...");
      const remainingErrors = checkTypeScriptErrors();
      if (remainingErrors.length > 0) {
        console.log(`   ❌ ${remainingErrors.length} TypeScript error(s) remain`);
      } else {
        console.log("   ✅ TypeScript compilation clean after fixes");
      }
    }
  }
  
  // Step 8: Apply upgrades (if --upgrade)
  if (options.upgrade) {
    console.log("\n⬆️  Applying code upgrades...");
    const upgradedCount = applyCodeUpgrades();
    report.upgradeApplied = upgradedCount > 0;
    console.log(`   Upgraded ${upgradedCount} file(s)`);
  }
  
  // Step 9: Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(55));
  console.log("📊 DIAGNOSTIC SUMMARY");
  console.log("=".repeat(55));
  console.log(`   Files scanned:    ${report.summary.filesScanned}`);
  console.log(`   Total issues:     ${report.summary.totalIssues}`);
  console.log(`   Errors:           ${report.summary.errors}`);
  console.log(`   Warnings:         ${report.summary.warnings}`);
  console.log(`   Info:             ${report.summary.infos}`);
  console.log(`   Auto-fixable:     ${report.summary.autoFixable}`);
  console.log(`   Auto-fixed:       ${report.summary.autoFixed}`);
  console.log(`   TypeScript errs:  ${report.typeErrors.length}`);
  console.log(`   Test failures:    ${report.testFailures.length}`);
  console.log(`   Time elapsed:     ${elapsed}s`);
  
  console.log("\n📋 CODE HEALTH");
  console.log(`   Unused imports:        ${health.unusedImports}`);
  console.log(`   Missing error handling: ${health.missingErrorHandling}`);
  console.log(`   Hardcoded values:      ${health.hardcodedValues}`);
  console.log(`   'any' types:           ${health.anyTypes}`);
  console.log(`   Code duplication:      ${health.codeDuplication}`);
  console.log(`   Documentation gaps:    ${health.documentationGaps}`);
  console.log("=".repeat(55) + "\n");
  
  // Step 10: Try HuggingFace AI (optional, best-effort)
  if (!options.ci && issues.length > 0) {
    console.log("🤖 Attempting HuggingFace AI suggestions (free tier)...");
    try {
      const aiSuggestions = await queryHuggingFaceAI(issues);
      if (aiSuggestions.length > 0) {
        console.log(`   Got ${aiSuggestions.length} AI suggestion(s)`);
        for (const s of aiSuggestions) {
          console.log(`   💡 ${s.file}:${s.line} - ${s.suggestion}`);
        }
      } else {
        console.log("   ℹ️  No AI suggestions returned (model may be loading)");
      }
    } catch (err) {
      console.log("   ⚠️  HuggingFace AI unavailable (free tier rate limit or network)");
    }
  }
  
  // CI output
  if (options.ci) {
    const ciReport = generateCIReport(report);
    const ciPath = resolve(ROOT, "self-heal-report.json");
    writeFileSync(ciPath, ciReport, "utf-8");
    console.log(`\n📄 CI report written to ${ciPath}`);
  }
  
  return report;
}

// ─── CLI Entry Point ─────────────────────────────────────────────────────────

// Run directly via: bunx tsx src/self-heal.ts [--fix] [--upgrade] [--ci]
const args = process.argv.slice(2);
const isCLI = args.length > 0 || process.argv[1]?.includes("self-heal");

if (isCLI) {
  const options = {
    fix: args.includes("--fix") || args.includes("--upgrade"),
    upgrade: args.includes("--upgrade"),
    ci: args.includes("--ci"),
  };
  
  runFullDiagnostic(options)
    .then((report) => {
      // Exit with error code if issues found
      if (report.summary.errors > 0 || report.typeErrors.length > 0 || report.testFailures.length > 0) {
        process.exit(1);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error("Self-heal engine crashed:", err);
      process.exit(2);
    });
}

export default {
  runFullDiagnostic,
  collectSourceFiles,
  checkTypeScriptErrors,
  checkTestFailures,
  analyzeCodeQuality,
  analyzeDocumentation,
  checkUnusedImports,
  analyzePythonFile,
  checkDependencies,
  applyAutoFixes,
  applyCodeUpgrades,
  queryHuggingFaceAI,
};
