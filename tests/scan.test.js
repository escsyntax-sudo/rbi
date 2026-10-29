import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ageDays,
  classifyBranch,
  classifyPull,
  globToRegExp,
  mapLimit,
  repoMatchesFilters,
} from "../src/scan.js";

const NOW = new Date("2026-10-29T12:00:00Z");

test("ageDays counts whole days", () => {
  assert.equal(ageDays("2026-10-29T12:00:00Z", NOW), 0);
  assert.equal(ageDays("2026-10-28T12:00:00Z", NOW), 1);
  assert.equal(ageDays("2026-10-28T13:00:00Z", NOW), 0);
  assert.equal(ageDays("2026-01-02T00:00:00Z", NOW), 300);
  assert.equal(ageDays(null, NOW), null);
  assert.equal(ageDays("not a date", NOW), null);
});

test("classifyBranch ignores the default branch", () => {
  const branch = {
    name: "main",
    commit: { commit: { committer: { date: "2020-01-01T00:00:00Z" } } },
  };
  assert.equal(
    classifyBranch(branch, { defaultBranch: "main", slaDays: 30, now: NOW }),
    null,
  );
});

test("classifyBranch reports old branches", () => {
  const branch = {
    name: "feature/old",
    commit: {
      sha: "abc",
      commit: {
        author: { name: "Grace Hopper" },
        committer: { date: "2026-01-02T00:00:00Z" },
      },
    },
  };
  const finding = classifyBranch(branch, {
    defaultBranch: "main",
    slaDays: 30,
    now: NOW,
    repoUrl: "https://github.com/acme/api",
    openPull: { number: 7, title: "Rewrite", htmlUrl: "https://github.com/acme/api/pull/7" },
  });
  assert.equal(finding.name, "feature/old");
  assert.equal(finding.ageDays, 300);
  assert.equal(finding.author, "Grace Hopper");
  assert.equal(
    finding.url,
    "https://github.com/acme/api/tree/feature%2Fold",
  );
  assert.equal(finding.openPull.number, 7);
});

test("classifyBranch skips young branches and missing dates", () => {
  const young = {
    name: "feature/new",
    commit: { commit: { committer: { date: "2026-10-20T00:00:00Z" } } },
  };
  assert.equal(
    classifyBranch(young, { defaultBranch: "main", slaDays: 30, now: NOW }),
    null,
  );
  assert.equal(
    classifyBranch(
      { name: "ghost", commit: {} },
      { defaultBranch: "main", slaDays: 30, now: NOW },
    ),
    null,
  );
});

test("classifyBranch respects the SLA boundary", () => {
  const branch = {
    name: "edge",
    commit: { commit: { committer: { date: "2026-09-29T12:00:00Z" } } },
  };
  assert.equal(
    classifyBranch(branch, { defaultBranch: "main", slaDays: 30, now: NOW }).ageDays,
    30,
  );
  assert.equal(
    classifyBranch(branch, { defaultBranch: "main", slaDays: 31, now: NOW }),
    null,
  );
});

test("classifyPull reports open pull requests past the SLA", () => {
  const pull = {
    number: 12,
    title: "Big refactor",
    htmlUrl: "https://github.com/acme/api/pull/12",
    author: "grace",
    draft: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-02-01T00:00:00Z",
    head: "feature/old",
    base: "main",
    labels: ["refactor"],
  };
  const finding = classifyPull(pull, { slaDays: 14, now: NOW });
  assert.equal(finding.number, 12);
  assert.equal(finding.ageDays, 301);
  assert.equal(finding.idleDays, 270);
  assert.equal(finding.idleStale, false);
});

test("classifyPull marks idle pull requests separately", () => {
  const pull = {
    number: 13,
    title: "Waiting",
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
    labels: [],
  };
  const finding = classifyPull(pull, {
    slaDays: 14,
    idleSlaDays: 21,
    now: NOW,
  });
  assert.equal(finding.idleStale, true);
});

test("classifyPull ignores young, closed and merged pull requests", () => {
  const base = { createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
  assert.equal(classifyPull(base, { slaDays: 14, now: NOW }), null);
  assert.equal(
    classifyPull({ ...base, state: "closed" }, { slaDays: 1, now: NOW }),
    null,
  );
  assert.equal(
    classifyPull({ ...base, mergedAt: "2026-10-29T00:00:00Z" }, { slaDays: 1, now: NOW }),
    null,
  );
});

test("globToRegExp matches repository names", () => {
  assert.equal(globToRegExp("*-infra").test("core-infra"), true);
  assert.equal(globToRegExp("*-infra").test("infra-core"), false);
  assert.equal(globToRegExp("docs").test("docs"), true);
  assert.equal(globToRegExp("api.?").test("api.x"), true);
});

test("repoMatchesFilters explains skips", () => {
  assert.equal(
    repoMatchesFilters({ name: "web", archived: true }, {}),
    "archived",
  );
  assert.equal(
    repoMatchesFilters({ name: "web", archived: true }, { includeArchived: true }),
    null,
  );
  assert.equal(
    repoMatchesFilters({ name: "fork", fork: true }, { excludeForks: true }),
    "fork",
  );
  assert.equal(
    repoMatchesFilters({ name: "core-infra" }, { excludePatterns: ["*-infra"] }),
    "excluded by *-infra",
  );
});

test("mapLimit keeps order and limits concurrency", async () => {
  let active = 0;
  let peak = 0;
  const values = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(values, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak <= 2, true);
  assert.deepEqual(await mapLimit([], 4, async () => 1), []);
});
