import { GitHubError } from "./github.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULTS = {
  branchSlaDays: 60,
  prSlaDays: 14,
  prIdleDays: 0,
  maxRepos: 100,
  maxBranches: 200,
  maxPulls: 200,
  concurrency: 4,
};

export function ageDays(isoDate, now = new Date()) {
  if (!isoDate) return null;
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / DAY_MS));
}

export function globToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  if (items.length === 0) return results;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let next = 0;

  async function run() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, run));
  return results;
}

export function classifyBranch(branch, {
  defaultBranch,
  slaDays,
  now = new Date(),
  openPull = null,
  repoUrl = "",
} = {}) {
  if (!branch || !branch.name) return null;
  if (branch.name === defaultBranch) return null;
  const commit = branch.commit || {};
  const lastCommit =
    (commit.commit && (commit.commit.committer?.date || commit.commit.author?.date)) ||
    commit.date ||
    null;
  const days = ageDays(lastCommit, now);
  if (days === null || days < slaDays) return null;
  const author =
    (commit.commit && commit.commit.author && commit.commit.author.name) ||
    (commit.author && commit.author.login) ||
    "";
  return {
    name: branch.name,
    sha: commit.sha || null,
    lastCommit,
    ageDays: days,
    author,
    url: repoUrl ? `${repoUrl}/tree/${encodeURIComponent(branch.name)}` : "",
    openPull: openPull
      ? { number: openPull.number, title: openPull.title, url: openPull.htmlUrl }
      : null,
  };
}

export function classifyPull(pull, {
  slaDays,
  idleSlaDays = 0,
  now = new Date(),
} = {}) {
  if (!pull || pull.state === "closed" || pull.mergedAt) return null;
  const days = ageDays(pull.createdAt, now);
  if (days === null || days < slaDays) return null;
  const idle = ageDays(pull.updatedAt || pull.createdAt, now);
  const idleStale = idleSlaDays > 0 && idle !== null && idle >= idleSlaDays;
  return {
    number: pull.number,
    title: pull.title || "",
    url: pull.htmlUrl || "",
    author: pull.author || "",
    draft: Boolean(pull.draft),
    branch: pull.head || "",
    base: pull.base || "",
    createdAt: pull.createdAt || null,
    updatedAt: pull.updatedAt || null,
    ageDays: days,
    idleDays: idle,
    idleStale,
    labels: Array.isArray(pull.labels) ? pull.labels : [],
  };
}

function normalisePull(raw) {
  return {
    number: raw.number,
    title: raw.title,
    htmlUrl: raw.html_url,
    author: raw.user ? raw.user.login : "",
    draft: raw.draft,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    head: raw.head ? raw.head.ref : "",
    base: raw.base ? raw.base.ref : "",
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((label) => (typeof label === "string" ? label : label.name))
      : [],
  };
}

function isNotFound(error) {
  return error instanceof GitHubError && error.status === 404;
}

function isConflict(error) {
  return error instanceof GitHubError && (error.status === 409 || error.status === 404);
}

export async function scanRepo(client, owner, name, options = {}) {
  const {
    branchSlaDays = DEFAULTS.branchSlaDays,
    prSlaDays = DEFAULTS.prSlaDays,
    prIdleDays = DEFAULTS.prIdleDays,
    maxBranches = DEFAULTS.maxBranches,
    maxPulls = DEFAULTS.maxPulls,
    now = new Date(),
    repoData = null,
    onBranchError = null,
  } = options;

  const result = {
    name,
    fullName: `${owner}/${name}`,
    url: "",
    defaultBranch: "",
    archived: false,
    private: false,
    fork: false,
    branchCount: 0,
    openPullCount: 0,
    branches: [],
    pulls: [],
    errors: [],
  };

  let repo = repoData;
  if (!repo) {
    try {
      repo = await client.getRepo(owner, name);
    } catch (error) {
      result.errors.push(`repository: ${error.message}`);
      return result;
    }
  }

  result.url = repo.html_url || "";
  result.defaultBranch = repo.default_branch || "";
  result.archived = Boolean(repo.archived);
  result.private = Boolean(repo.private);
  result.fork = Boolean(repo.fork);

  let rawBranches = [];
  try {
    rawBranches = await client.listAllBranches(owner, name, { maxItems: maxBranches });
  } catch (error) {
    if (!isConflict(error)) {
      result.errors.push(`branches: ${error.message}`);
    }
  }

  let rawPulls = [];
  try {
    rawPulls = await client.listOpenPulls(owner, name, { maxItems: maxPulls });
  } catch (error) {
    result.errors.push(`pull requests: ${error.message}`);
  }

  const pulls = rawPulls.map(normalisePull);
  result.openPullCount = pulls.length;
  result.branchCount = rawBranches.length;

  const pullByBranch = new Map();
  for (const pull of pulls) {
    if (pull.head) pullByBranch.set(pull.head, pull);
  }

  const candidates = rawBranches.filter(
    (branch) => branch && branch.name && branch.name !== result.defaultBranch,
  );

  const details = await mapLimit(
    candidates,
    options.branchConcurrency || 4,
    async (branch) => {
      try {
        return await client.getBranch(owner, name, branch.name);
      } catch (error) {
        const message = `branch ${branch.name}: ${error.message}`;
        result.errors.push(message);
        if (onBranchError) onBranchError(message);
        return null;
      }
    },
  );

  result.branches = details
    .map((branch) =>
      classifyBranch(branch, {
        defaultBranch: result.defaultBranch,
        slaDays: branchSlaDays,
        now,
        openPull: branch ? pullByBranch.get(branch.name) : null,
        repoUrl: result.url,
      }),
    )
    .filter(Boolean)
    .sort((left, right) => right.ageDays - left.ageDays || left.name.localeCompare(right.name));

  result.pulls = pulls
    .map((pull) =>
      classifyPull(pull, {
        slaDays: prSlaDays,
        idleSlaDays: prIdleDays,
        now,
      }),
    )
    .filter(Boolean)
    .sort((left, right) => right.ageDays - left.ageDays || left.number - right.number);

  return result;
}

export function repoMatchesFilters(repo, {
  includeArchived = false,
  excludeForks = false,
  excludePatterns = [],
} = {}) {
  if (repo.archived && !includeArchived) return "archived";
  if (repo.fork && excludeForks) return "fork";
  for (const pattern of excludePatterns) {
    if (globToRegExp(pattern).test(repo.name)) return `excluded by ${pattern}`;
  }
  return null;
}

export async function scanOwner(client, owner, options = {}) {
  const {
    ownerType = "auto",
    includeArchived = false,
    excludeForks = false,
    excludePatterns = [],
    maxRepos = DEFAULTS.maxRepos,
    branchSlaDays = DEFAULTS.branchSlaDays,
    prSlaDays = DEFAULTS.prSlaDays,
    prIdleDays = DEFAULTS.prIdleDays,
    maxBranches = DEFAULTS.maxBranches,
    maxPulls = DEFAULTS.maxPulls,
    concurrency = DEFAULTS.concurrency,
    now = new Date(),
    onProgress = null,
    onBranchError = null,
  } = options;

  let repos = [];
  let resolvedType = ownerType;

  if (ownerType === "auto" || ownerType === "org") {
    try {
      repos = await client.listOrgRepos(owner, { maxItems: maxRepos * 2 });
      resolvedType = "org";
    } catch (error) {
      if (ownerType === "org" || !isNotFound(error)) throw error;
    }
  }

  if (repos.length === 0 && (ownerType === "auto" || ownerType === "user")) {
    repos = await client.listUserRepos(owner, { maxItems: maxRepos * 2 });
    resolvedType = "user";
  }

  const skipped = [];
  const selected = [];
  for (const repo of repos) {
    const reason = repoMatchesFilters(repo, {
      includeArchived,
      excludeForks,
      excludePatterns,
    });
    if (reason) {
      skipped.push({ name: repo.name, reason });
      continue;
    }
    selected.push(repo);
    if (selected.length >= maxRepos) break;
  }

  let done = 0;
  const results = await mapLimit(selected, concurrency, async (repo) => {
    const scanned = await scanRepo(client, owner, repo.name, {
      branchSlaDays,
      prSlaDays,
      prIdleDays,
      maxBranches,
      maxPulls,
      now,
      repoData: repo,
      onBranchError,
      branchConcurrency: options.branchConcurrency || 4,
    });
    done += 1;
    if (onProgress) onProgress(done, selected.length, repo.name);
    return scanned;
  });

  results.sort((left, right) => {
    const leftDebt = left.branches.length + left.pulls.length;
    const rightDebt = right.branches.length + right.pulls.length;
    return rightDebt - leftDebt || left.fullName.localeCompare(right.fullName);
  });

  const totals = {
    repos: results.length,
    reposWithDebt: results.filter(
      (repo) => repo.branches.length > 0 || repo.pulls.length > 0,
    ).length,
    staleBranches: results.reduce((sum, repo) => sum + repo.branches.length, 0),
    stalePulls: results.reduce((sum, repo) => sum + repo.pulls.length, 0),
    repoErrors: results.filter((repo) => repo.errors.length > 0).length,
  };
  totals.findings = totals.staleBranches + totals.stalePulls;

  return {
    tool: "rbi",
    version: options.version || "0.1.0",
    owner,
    ownerType: resolvedType,
    generatedAt: now.toISOString(),
    thresholds: {
      branchSlaDays,
      prSlaDays,
      prIdleDays,
    },
    skipped,
    repos: results,
    totals,
  };
}

export async function scanRepos(client, targets, options = {}) {
  const {
    branchSlaDays = DEFAULTS.branchSlaDays,
    prSlaDays = DEFAULTS.prSlaDays,
    prIdleDays = DEFAULTS.prIdleDays,
    maxBranches = DEFAULTS.maxBranches,
    maxPulls = DEFAULTS.maxPulls,
    concurrency = DEFAULTS.concurrency,
    now = new Date(),
    onProgress = null,
    onBranchError = null,
  } = options;

  let done = 0;
  const repos = await mapLimit(targets, concurrency, async (target) => {
    const scanned = await scanRepo(client, target.owner, target.name, {
      branchSlaDays,
      prSlaDays,
      prIdleDays,
      maxBranches,
      maxPulls,
      now,
      onBranchError,
      branchConcurrency: options.branchConcurrency || 4,
    });
    done += 1;
    if (onProgress) onProgress(done, targets.length, target.name);
    return scanned;
  });

  repos.sort(
    (left, right) =>
      right.branches.length + right.pulls.length - (left.branches.length + left.pulls.length) ||
      left.fullName.localeCompare(right.fullName),
  );

  const totals = {
    repos: repos.length,
    reposWithDebt: repos.filter((repo) => repo.branches.length > 0 || repo.pulls.length > 0).length,
    staleBranches: repos.reduce((sum, repo) => sum + repo.branches.length, 0),
    stalePulls: repos.reduce((sum, repo) => sum + repo.pulls.length, 0),
    repoErrors: repos.filter((repo) => repo.errors.length > 0).length,
  };
  totals.findings = totals.staleBranches + totals.stalePulls;

  return {
    tool: "rbi",
    version: options.version || "0.1.0",
    owner: options.owner || "",
    ownerType: "repos",
    generatedAt: now.toISOString(),
    thresholds: { branchSlaDays, prSlaDays, prIdleDays },
    skipped: [],
    repos,
    totals,
  };
}
