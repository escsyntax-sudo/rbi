import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { GitHubClient, GitHubError } from "../src/github.js";
import { scanOwner, scanRepo, scanRepos } from "../src/scan.js";
import { NOW, startFakeGitHub } from "./fake-github.js";

let fake;
let client;

before(async () => {
  fake = await startFakeGitHub();
  client = new GitHubClient({ apiUrl: fake.url, token: "", maxRateLimitWaitMs: 0 });
});

after(async () => {
  await fake.close();
});

test("scanRepo finds stale branches and pull requests", async () => {
  const repo = await scanRepo(client, "acme", "api", {
    now: NOW,
    branchSlaDays: 60,
    prSlaDays: 14,
  });
  assert.equal(repo.errors.length, 0);
  assert.equal(repo.defaultBranch, "main");
  assert.equal(repo.branchCount, 3);
  assert.equal(repo.openPullCount, 2);
  assert.deepEqual(repo.branches.map((branch) => branch.name), ["feature/old"]);
  assert.equal(repo.branches[0].ageDays, 299);
  assert.equal(repo.branches[0].openPull.number, 7);
  assert.deepEqual(repo.pulls.map((pull) => pull.number), [7]);
  assert.equal(repo.pulls[0].draft, false);
  assert.deepEqual(repo.pulls[0].labels, ["refactor"]);
});

test("scanRepo respects the thresholds", async () => {
  const repo = await scanRepo(client, "acme", "api", {
    now: NOW,
    branchSlaDays: 365,
    prSlaDays: 365,
  });
  assert.deepEqual(repo.branches, []);
  assert.deepEqual(repo.pulls, []);
});

test("scanRepo marks idle pull requests", async () => {
  const repo = await scanRepo(client, "acme", "api", {
    now: NOW,
    branchSlaDays: 60,
    prSlaDays: 14,
    prIdleDays: 30,
  });
  assert.equal(repo.pulls[0].idleStale, true);
});

test("scanOwner skips archived repositories", async () => {
  const result = await scanOwner(client, "acme", {
    now: NOW,
    includeArchived: false,
    excludeForks: true,
  });
  assert.deepEqual(result.repos.map((repo) => repo.name), ["api"]);
  assert.equal(result.skipped.length, 2);
  assert.deepEqual(
    result.skipped.map((entry) => entry.name),
    ["web", "infra"],
  );
  assert.equal(result.ownerType, "org");
});

test("scanOwner can include archived and fork repositories", async () => {
  const result = await scanOwner(client, "acme", {
    now: NOW,
    includeArchived: true,
    excludeForks: false,
  });
  assert.deepEqual(result.repos.map((repo) => repo.name), ["api", "infra", "web"]);
  assert.equal(result.skipped.length, 0);
});

test("scanOwner applies exclude patterns", async () => {
  const result = await scanOwner(client, "acme", {
    now: NOW,
    excludeForks: true,
    excludePatterns: ["a*"],
  });
  assert.deepEqual(result.repos, []);
  assert.equal(result.skipped.some((entry) => entry.reason === "excluded by a*"), true);
});

test("scanOwner reports totals and progress", async () => {
  const progress = [];
  const result = await scanOwner(client, "acme", {
    now: NOW,
    includeArchived: false,
    excludeForks: true,
    onProgress: (done, total, name) => progress.push([done, total, name]),
  });
  assert.deepEqual(progress, [[1, 1, "api"]]);
  assert.equal(result.totals.repos, 1);
  assert.equal(result.totals.reposWithDebt, 1);
  assert.equal(result.totals.staleBranches, 1);
  assert.equal(result.totals.stalePulls, 1);
  assert.equal(result.totals.findings, 2);
  assert.equal(result.thresholds.branchSlaDays, 60);
});

test("scanOwner falls back to user repositories when the org is missing", async () => {
  const fallback = Object.assign(Object.create(client), {
    listOrgRepos: async () => {
      throw new GitHubError("Not Found", { status: 404 });
    },
    listUserRepos: async () => [
      {
        name: "api",
        html_url: "https://github.com/acme/api",
        default_branch: "main",
        archived: false,
        fork: false,
      },
    ],
  });
  const result = await scanOwner(fallback, "acme", { now: NOW });
  assert.equal(result.ownerType, "user");
  assert.equal(result.repos.length, 1);
});

test("scanOwner fails when the organisation lookup fails with another status", async () => {
  const broken = Object.assign(Object.create(client), {
    listOrgRepos: async () => {
      throw new GitHubError("Forbidden", { status: 403 });
    },
  });
  await assert.rejects(() => scanOwner(broken, "acme", { now: NOW }), /Forbidden/);
});

test("scanRepos scans explicit repositories", async () => {
  const result = await scanRepos(client, [{ owner: "acme", name: "api" }], { now: NOW });
  assert.equal(result.ownerType, "repos");
  assert.equal(result.repos.length, 1);
  assert.equal(result.totals.findings, 2);
});

test("scanRepo records errors for a repository it cannot read", async () => {
  const repo = await scanRepo(client, "acme", "missing", { now: NOW });
  assert.equal(repo.errors.length, 1);
  assert.match(repo.errors[0], /repository:/);
  assert.deepEqual(repo.branches, []);
});

test("scanRepo keeps going when a branch detail fails", async () => {
  const partial = Object.assign(Object.create(client), {
    getBranch: async () => {
      throw new GitHubError("Branch not found", { status: 404 });
    },
  });
  const messages = [];
  const repo = await scanRepo(partial, "acme", "api", {
    now: NOW,
    onBranchError: (message) => messages.push(message),
  });
  assert.equal(repo.branches.length, 0);
  assert.equal(repo.errors.length, 2);
  assert.equal(messages.length, 2);
});
