import assert from "node:assert/strict";
import { test } from "node:test";

import { renderJson, renderMarkdown, summarise } from "../src/report.js";

const RESULT = {
  tool: "rbi",
  version: "0.1.0",
  owner: "acme",
  ownerType: "org",
  generatedAt: "2026-10-29T12:00:00.000Z",
  thresholds: { branchSlaDays: 60, prSlaDays: 14, prIdleDays: 0 },
  skipped: [{ name: "legacy", reason: "archived" }],
  totals: {
    repos: 3,
    reposWithDebt: 1,
    staleBranches: 1,
    stalePulls: 1,
    repoErrors: 0,
    findings: 2,
  },
  repos: [
    {
      name: "api",
      fullName: "acme/api",
      url: "https://github.com/acme/api",
      defaultBranch: "main",
      archived: false,
      private: false,
      fork: false,
      branchCount: 4,
      openPullCount: 2,
      errors: [],
      branches: [
        {
          name: "feature/old",
          sha: "abc",
          lastCommit: "2026-01-02T00:00:00Z",
          ageDays: 300,
          author: "Grace Hopper",
          url: "https://github.com/acme/api/tree/feature%2Fold",
          openPull: {
            number: 7,
            title: "Rewrite",
            url: "https://github.com/acme/api/pull/7",
          },
        },
      ],
      pulls: [
        {
          number: 9,
          title: "Add caching | layer",
          url: "https://github.com/acme/api/pull/9",
          author: "ada",
          draft: false,
          branch: "feature/old",
          base: "main",
          createdAt: "2026-01-04T00:00:00Z",
          updatedAt: "2026-02-01T00:00:00Z",
          ageDays: 298,
          idleDays: 270,
          idleStale: false,
          labels: [],
        },
      ],
    },
    {
      name: "web",
      fullName: "acme/web",
      url: "https://github.com/acme/web",
      defaultBranch: "main",
      archived: false,
      private: false,
      fork: false,
      branchCount: 2,
      openPullCount: 0,
      errors: [],
      branches: [],
      pulls: [],
    },
  ],
};

test("markdown report includes the summary and findings", () => {
  const markdown = renderMarkdown(RESULT);
  assert.match(markdown, /^# Repository debt report/m);
  assert.match(markdown, /Owner: acme \(org\)/);
  assert.match(markdown, /Branch SLA: 60 days/);
  assert.match(markdown, /\| Repositories scanned \| 3 \|/);
  assert.match(markdown, /### \[acme\/api\]/);
  assert.match(markdown, /feature\/old/);
  assert.match(markdown, /300d/);
  assert.match(markdown, /\[#7\]/);
  assert.match(markdown, /Add caching \\\| layer/);
  assert.match(markdown, /Skipped repositories/);
  assert.match(markdown, /legacy: archived/);
  assert.match(markdown, /Suggested actions/);
  // Repositories without findings do not get a section.
  assert.equal(markdown.includes("### [acme/web]"), false);
});

test("markdown report handles an empty result", () => {  const empty = {
    ...RESULT,
    repos: [],
    skipped: [],
    totals: {
      repos: 0,
      reposWithDebt: 0,
      staleBranches: 0,
      stalePulls: 0,
      repoErrors: 0,
      findings: 0,
    },
  };
  const markdown = renderMarkdown(empty);
  assert.match(markdown, /No repository exceeded the configured thresholds/);
  assert.equal(markdown.includes("## Findings"), false);
});

test("markdown report labels an explicit repository list", () => {
  const markdown = renderMarkdown({ ...RESULT, owner: "", ownerType: "repos" });
  assert.match(markdown, /Source: explicit repository list/);
  assert.equal(markdown.includes("Owner:"), false);
});

test("markdown report lists repository errors", () => {
  const errored = {
    ...RESULT,
    repos: [
      {
        ...RESULT.repos[1],
        errors: ["branches: Not Found (404)"],
      },
    ],
    totals: { ...RESULT.totals, findings: 0 },
  };
  const markdown = renderMarkdown(errored);
  assert.match(markdown, /## Incomplete repositories/);
  assert.match(markdown, /branches: Not Found \(404\)/);
});

test("markdown report mentions the idle SLA when set", () => {
  const markdown = renderMarkdown({
    ...RESULT,
    thresholds: { ...RESULT.thresholds, prIdleDays: 21 },
  });
  assert.match(markdown, /Pull request idle SLA: 21 days/);
});

test("json report round trips", () => {
  const parsed = JSON.parse(renderJson(RESULT));
  assert.deepEqual(parsed, RESULT);
});

test("summarise reads totals", () => {
  assert.equal(
    summarise(RESULT),
    "3 repositories, 1 stale branch, 1 stale pull request",
  );
  assert.equal(
    summarise({
      totals: { repos: 1, staleBranches: 0, stalePulls: 2 },
    }),
    "1 repository, 0 stale branches, 2 stale pull requests",
  );
});
