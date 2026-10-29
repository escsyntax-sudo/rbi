import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { GitHubClient, GitHubError, RateLimitError } from "./github.js";
import { renderJson, renderMarkdown, summarise } from "./report.js";
import { DEFAULTS, scanOwner, scanRepos } from "./scan.js";

const VERSION = "0.1.0";

const HELP = `rbi ${VERSION}

Repository debt inspector. Scans GitHub repositories for branches and open pull
requests that are older than the configured SLA, then writes a Markdown report.

Usage:
  rbi scan --org NAME [options]
  rbi scan --repo OWNER/NAME [--repo OWNER/NAME ...] [options]
  rbi --help

Options:
  --org NAME              Organization or user to scan.
  --repo OWNER/NAME       Scan one repository. Repeat for more.
  --branch-sla DAYS       Branch age limit (default: ${DEFAULTS.branchSlaDays}).
  --pr-sla DAYS           Pull request age limit (default: ${DEFAULTS.prSlaDays}).
  --pr-idle-sla DAYS      Also flag pull requests without updates for this long.
  --max-repos N           Stop after this many repositories (default: ${DEFAULTS.maxRepos}).
  --max-branches N        Branch limit per repository (default: ${DEFAULTS.maxBranches}).
  --max-pulls N           Open pull request limit per repository (default: ${DEFAULTS.maxPulls}).
  --concurrency N         Repositories scanned in parallel (default: ${DEFAULTS.concurrency}).
  --exclude GLOB          Skip repositories matching a glob. Repeatable.
  --include-archived      Include archived repositories.
  --exclude-forks         Skip forks.
  --owner-type TYPE       auto, org, or user (default: auto).
  --format FORMAT         markdown or json (default: markdown).
  --out FILE              Write the report to a file instead of stdout.
  --token TOKEN           GitHub token. Defaults to GITHUB_TOKEN or GH_TOKEN.
  --api-url URL           GitHub API base (default: https://api.github.com).
  --fail                  Exit with code 2 when any finding is reported.
  --quiet                 Do not write progress to stderr.
  --verbose               Print authentication and quota details.
  --help                  Show this help.
  --version               Show the version.

Environment:
  GITHUB_TOKEN, GH_TOKEN  Used when --token is missing.
  GITHUB_API_URL          Used when --api-url is missing.

Examples:
  rbi scan --org my-org --branch-sla 90 --pr-sla 21
  rbi scan --repo my-org/api --repo my-org/web --format json --out debt.json
  rbi scan --org my-org --exclude "*-infra" --exclude-forks --fail
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) {
    throw new UsageError(
      `${label} must be ${allowZero ? "zero or " : ""}a positive integer, got "${value}"`,
    );
  }
  return number;
}

function parseRepoTarget(value) {
  const parts = String(value).split("/").filter(Boolean);
  if (parts.length !== 2) {
    throw new UsageError(`--repo must look like OWNER/NAME, got "${value}"`);
  }
  return { owner: parts[0], name: parts[1] };
}

export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      org: { type: "string" },
      repo: { type: "string", multiple: true },
      token: { type: "string" },
      "api-url": { type: "string" },
      "branch-sla": { type: "string" },
      "pr-sla": { type: "string" },
      "pr-idle-sla": { type: "string" },
      "max-repos": { type: "string" },
      "max-branches": { type: "string" },
      "max-pulls": { type: "string" },
      concurrency: { type: "string" },
      "branch-concurrency": { type: "string" },
      exclude: { type: "string", multiple: true },
      "include-archived": { type: "boolean" },
      "exclude-forks": { type: "boolean" },
      "owner-type": { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      fail: { type: "boolean" },
      quiet: { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean" },
      version: { type: "boolean" },
    },
  });

  return { values, positionals };
}

export async function run(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;

  let parsed;
  try {
    parsed = parseOptions(argv);
  } catch (error) {
    if (error && typeof error.code === "string" && error.code.startsWith("ERR_PARSE_ARGS")) {
      stderr.write(`rbi: ${error.message}\nRun "rbi --help" for usage.\n`);
      return 1;
    }
    throw error;
  }

  const { values, positionals } = parsed;

  if (values.version) {
    stdout.write(`rbi ${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals[0] === "help") {
    stdout.write(HELP);
    return 0;
  }
  if (positionals.length === 0) {
    stderr.write('rbi: missing command, expected "scan"\nRun "rbi --help" for usage.\n');
    return 1;
  }
  if (positionals[0] !== "scan") {
    stderr.write(`rbi: unknown command "${positionals[0]}"\nRun "rbi --help" for usage.\n`);
    return 1;
  }
  if (positionals.length > 1) {
    stderr.write(`rbi: unexpected argument "${positionals[1]}"\n`);
    return 1;
  }

  let options;
  try {
    options = buildScanOptions(values, env);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`rbi: ${error.message}\nRun "rbi --help" for usage.\n`);
      return 1;
    }
    throw error;
  }

  const client = new GitHubClient({
    token: options.token,
    apiUrl: options.apiUrl,
    userAgent: `rbi/${VERSION}`,
  });

  const thresholdText =
    `branch SLA ${options.branchSlaDays}d, pull request SLA ${options.prSlaDays}d`;
  if (!options.quiet) {
    stderr.write(
      `rbi: scanning ${options.org ? options.org : `${options.repos.length} repositories`} (${thresholdText})\n`,
    );
    if (!options.token) {
      stderr.write(
        "rbi: no token found, using unauthenticated requests (60 requests per hour)\n",
      );
    }
  }

  if (options.verbose) {
    try {
      const user = await client.getAuthenticatedUser();
      const quota = await client.getRateLimit();
      stderr.write(
        `rbi: authenticated as ${user.login}${quota ? `, ${quota.remaining} of ${quota.limit} requests left` : ""}\n`,
      );
    } catch (error) {
      stderr.write(`rbi: could not verify the token: ${error.message}\n`);
    }
  }

  const onProgress = options.quiet
    ? null
    : (done, total, name) => {
        stderr.write(`rbi: ${done}/${total} ${name}\n`);
      };

  let result;
  try {
    if (options.org) {
      result = await scanOwner(client, options.org, {
        ownerType: options.ownerType,
        includeArchived: options.includeArchived,
        excludeForks: options.excludeForks,
        excludePatterns: options.exclude,
        maxRepos: options.maxRepos,
        branchSlaDays: options.branchSlaDays,
        prSlaDays: options.prSlaDays,
        prIdleDays: options.prIdleDays,
        maxBranches: options.maxBranches,
        maxPulls: options.maxPulls,
        concurrency: options.concurrency,
        branchConcurrency: options.branchConcurrency,
        version: VERSION,
        onProgress,
      });
    } else {
      result = await scanRepos(client, options.repos, {
        branchSlaDays: options.branchSlaDays,
        prSlaDays: options.prSlaDays,
        prIdleDays: options.prIdleDays,
        maxBranches: options.maxBranches,
        maxPulls: options.maxPulls,
        concurrency: options.concurrency,
        branchConcurrency: options.branchConcurrency,
        version: VERSION,
        onProgress,
      });
    }
  } catch (error) {
    if (error instanceof RateLimitError) {
      stderr.write(`rbi: ${error.message}\nSet GITHUB_TOKEN to raise the hourly limit.\n`);
      return 1;
    }
    if (error instanceof GitHubError) {
      stderr.write(`rbi: ${error.message}\n`);
      return 1;
    }
    stderr.write(`rbi: ${error && error.message ? error.message : error}\n`);
    return 1;
  }

  const report = options.format === "json" ? renderJson(result) : renderMarkdown(result);
  if (options.out) {
    try {
      writeFileSync(options.out, report, "utf8");
    } catch (error) {
      stderr.write(`rbi: could not write ${options.out}: ${error.message}\n`);
      return 1;
    }
    if (!options.quiet) {
      stderr.write(`rbi: wrote ${options.out}\n`);
    }
  } else {
    stdout.write(report);
  }

  if (!options.quiet) {
    stderr.write(`rbi: ${summarise(result)}\n`);
  }

  if (options.fail && result.totals.findings > 0) {
    return 2;
  }
  return 0;
}

export function buildScanOptions(values, env = process.env) {
  const repos = (values.repo || []).map(parseRepoTarget);
  if (repos.length === 0 && !values.org) {
    throw new UsageError("provide --org NAME or at least one --repo OWNER/NAME");
  }
  if (repos.length > 0 && values.org) {
    throw new UsageError("use either --org or --repo, not both");
  }

  const ownerType = values["owner-type"] || "auto";
  if (!["auto", "org", "user"].includes(ownerType)) {
    throw new UsageError(`--owner-type must be auto, org, or user, got "${ownerType}"`);
  }

  const format = values.format || "markdown";
  if (!["markdown", "md", "json"].includes(format)) {
    throw new UsageError(`--format must be markdown or json, got "${format}"`);
  }

  const token = values.token || env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const apiUrl = values["api-url"] || env.GITHUB_API_URL || "https://api.github.com";

  return {
    org: values.org || "",
    repos,
    ownerType,
    format: format === "md" ? "markdown" : format,
    out: values.out || "",
    token,
    apiUrl,
    branchSlaDays: positiveInteger(
      values["branch-sla"] ?? DEFAULTS.branchSlaDays,
      "--branch-sla",
    ),
    prSlaDays: positiveInteger(values["pr-sla"] ?? DEFAULTS.prSlaDays, "--pr-sla"),
    prIdleDays: positiveInteger(
      values["pr-idle-sla"] ?? DEFAULTS.prIdleDays,
      "--pr-idle-sla",
      { allowZero: true },
    ),
    maxRepos: positiveInteger(values["max-repos"] ?? DEFAULTS.maxRepos, "--max-repos"),
    maxBranches: positiveInteger(
      values["max-branches"] ?? DEFAULTS.maxBranches,
      "--max-branches",
    ),
    maxPulls: positiveInteger(values["max-pulls"] ?? DEFAULTS.maxPulls, "--max-pulls"),
    concurrency: positiveInteger(
      values.concurrency ?? DEFAULTS.concurrency,
      "--concurrency",
    ),
    branchConcurrency: positiveInteger(
      values["branch-concurrency"] ?? 4,
      "--branch-concurrency",
    ),
    exclude: values.exclude || [],
    includeArchived: Boolean(values["include-archived"]),
    excludeForks: Boolean(values["exclude-forks"]),
    fail: Boolean(values.fail),
    quiet: Boolean(values.quiet),
    verbose: Boolean(values.verbose),
  };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    return await run(argv);
  } catch (error) {
    process.stderr.write(`rbi: ${error && error.message ? error.message : error}\n`);
    return 1;
  }
}
