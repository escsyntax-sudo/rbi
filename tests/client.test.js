import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { GitHubClient, GitHubError, RateLimitError } from "../src/github.js";
import { startFakeGitHub } from "./fake-github.js";

let fake;
let client;

before(async () => {
  fake = await startFakeGitHub();
  client = new GitHubClient({
    token: "test-token",
    apiUrl: fake.url,
    maxRateLimitWaitMs: 0,
  });
});

after(async () => {
  await fake.close();
});

test("requests send the token and API headers", async () => {
  const repo = await client.getRepo("acme", "api");
  assert.equal(repo.full_name, "acme/api");
  const last = fake.state.requests.at(-1);
  assert.equal(last.authorization, "Bearer test-token");
  assert.equal(last.path, "/repos/acme/api");
});

test("paginate follows pages until a short page", async () => {
  const items = await client.paginate("/items", { perPage: 2 });
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3, 4, 5]);
  const pages = fake.state.requests
    .filter((request) => request.path === "/items")
    .map((request) => request.query.page);
  assert.deepEqual(pages, ["1", "2", "3"]);
});

test("paginate obeys maxItems", async () => {
  const items = await client.paginate("/items", { perPage: 2, maxItems: 3 });
  assert.deepEqual(items.map((item) => item.id), [1, 2, 3]);
});

test("listAllBranches and branch details work", async () => {
  const branches = await client.listAllBranches("acme", "api");
  assert.equal(branches.length, 3);
  const detail = await client.getBranch("acme", "api", "feature/old");
  assert.equal(detail.name, "feature/old");
  assert.equal(detail.commit.commit.author.date, "2026-01-02T00:00:00Z");
});

test("listOpenPulls maps the open state", async () => {
  const pulls = await client.listOpenPulls("acme", "api");
  assert.equal(pulls.length, 2);
  const query = fake.state.requests.find((request) => request.path === "/repos/acme/api/pulls");
  assert.equal(query.query.state, "open");
});

test("listOrgRepos returns organisation repositories", async () => {
  const repos = await client.listOrgRepos("acme");
  assert.deepEqual(repos.map((repo) => repo.name), ["api", "web", "infra"]);
});

test("a missing repository raises a GitHubError", async () => {
  await assert.rejects(
    () => client.getRepo("acme", "missing"),
    (error) => {
      assert.equal(error instanceof GitHubError, true);
      assert.equal(error.status, 404);
      assert.match(error.message, /Not Found/);
      return true;
    },
  );
});

test("server errors are retried", async () => {
  const payload = await client.request("/flaky");
  assert.deepEqual(payload, { ok: true });
  assert.equal(fake.state.flakyCalls, 2);
});

test("a drained rate limit raises RateLimitError", async () => {
  await assert.rejects(
    () => client.request("/limited"),
    (error) => {
      assert.equal(error instanceof RateLimitError, true);
      assert.match(error.message, /rate limit/i);
      assert.ok(error.resetAt instanceof Date);
      return true;
    },
  );
});

test("getRateLimit and getAuthenticatedUser work", async () => {
  const user = await client.getAuthenticatedUser();
  assert.equal(user.login, "tester");
  const quota = await client.getRateLimit();
  assert.equal(quota.limit, 5000);
});

test("network failures surface as GitHubError", async () => {
  const broken = new GitHubClient({
    apiUrl: "http://127.0.0.1:1",
    maxRetries: 0,
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
  });
  await assert.rejects(
    () => broken.getRepo("acme", "api"),
    (error) => {
      assert.equal(error instanceof GitHubError, true);
      assert.match(error.message, /network error/);
      return true;
    },
  );
});

test("buildUrl skips empty query values", () => {
  const url = client.buildUrl("/repos", { page: 1, empty: "", missing: null });
  assert.match(url.search, /page=1/);
  assert.equal(url.search.includes("empty"), false);
});
