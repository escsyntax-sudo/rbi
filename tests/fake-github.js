import { createServer } from "node:http";

export const NOW = new Date("2026-10-29T12:00:00Z");

const REPO = {
  name: "api",
  full_name: "acme/api",
  html_url: "https://github.com/acme/api",
  default_branch: "main",
  archived: false,
  private: false,
  fork: false,
};

const BRANCHES = [
  { name: "main", commit: { sha: "aaa111", url: "" } },
  { name: "feature/old", commit: { sha: "bbb222", url: "" } },
  { name: "feature/fresh", commit: { sha: "ccc333", url: "" } },
];

const BRANCH_DETAILS = {
  main: {
    name: "main",
    commit: {
      sha: "aaa111",
      commit: {
        author: { name: "Ada Lovelace", date: "2026-10-28T00:00:00Z" },
        committer: { date: "2026-10-28T00:00:00Z" },
      },
    },
  },
  "feature/old": {
    name: "feature/old",
    commit: {
      sha: "bbb222",
      commit: {
        author: { name: "Grace Hopper", date: "2026-01-02T00:00:00Z" },
        committer: { date: "2026-01-03T00:00:00Z" },
      },
    },
  },
  "feature/fresh": {
    name: "feature/fresh",
    commit: {
      sha: "ccc333",
      commit: {
        author: { name: "Alan Turing", date: "2026-10-20T00:00:00Z" },
        committer: { date: "2026-10-20T00:00:00Z" },
      },
    },
  },
};

const PULLS = [
  {
    number: 7,
    title: "Rewrite the ingest path",
    html_url: "https://github.com/acme/api/pull/7",
    user: { login: "grace" },
    draft: false,
    created_at: "2026-01-04T00:00:00Z",
    updated_at: "2026-02-01T00:00:00Z",
    head: { ref: "feature/old" },
    base: { ref: "main" },
    labels: [{ name: "refactor" }],
  },
  {
    number: 8,
    title: "Add a health endpoint",
    html_url: "https://github.com/acme/api/pull/8",
    user: { login: "ada" },
    draft: true,
    created_at: "2026-10-27T00:00:00Z",
    updated_at: "2026-10-28T00:00:00Z",
    head: { ref: "feature/fresh" },
    base: { ref: "main" },
    labels: [],
  },
];

const ORG_REPOS = [
  REPO,
  {
    name: "web",
    full_name: "acme/web",
    html_url: "https://github.com/acme/web",
    default_branch: "main",
    archived: true,
    private: false,
    fork: false,
  },
  {
    name: "infra",
    full_name: "acme/infra",
    html_url: "https://github.com/acme/infra",
    default_branch: "main",
    archived: false,
    private: false,
    fork: true,
  },
];

function send(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

export async function startFakeGitHub() {
  const state = { requests: [], flakyCalls: 0 };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    state.requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization || "",
    });

    if (segments.length === 0) return send(response, 200, { ok: true });

    if (segments[0] === "user") {
      return send(response, 200, { login: "tester" });
    }

    if (segments[0] === "rate_limit") {
      return send(response, 200, {
        resources: { core: { limit: 5000, remaining: 4999, reset: 1790000000 } },
      });
    }

    if (segments[0] === "items") {
      const perPage = Number(url.searchParams.get("per_page") || 2);
      const page = Number(url.searchParams.get("page") || 1);
      const all = [1, 2, 3, 4, 5].map((id) => ({ id }));
      const start = (page - 1) * perPage;
      return send(response, 200, all.slice(start, start + perPage));
    }

    if (segments[0] === "flaky") {
      state.flakyCalls += 1;
      if (state.flakyCalls === 1) return send(response, 500, { message: "boom" });
      return send(response, 200, { ok: true });
    }

    if (segments[0] === "limited") {
      return send(response, 403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      });
    }

    if (segments[0] === "orgs" && segments[2] === "repos") {
      return send(response, 200, ORG_REPOS);
    }

    if (segments[0] === "users" && segments[2] === "repos") {
      return send(response, 200, [REPO]);
    }

    if (segments[0] === "repos" && segments.length >= 3) {
      const [, , repoName, resource] = segments;

      if (!resource) {
        if (repoName === "api") return send(response, 200, REPO);
        const found = ORG_REPOS.find((repo) => repo.name === repoName);
        if (found) return send(response, 200, found);
        return send(response, 404, { message: "Not Found" });
      }

      if (repoName !== "api") {
        if (resource === "branches" || resource === "pulls") {
          return send(response, 200, []);
        }
        return send(response, 404, { message: "Not Found" });
      }

      if (resource === "branches" && segments.length === 4) {
        return send(response, 200, BRANCHES);
      }

      if (resource === "branches" && segments.length === 5) {
        const name = segments.slice(4).join("/");
        const detail = BRANCH_DETAILS[name];
        if (!detail) return send(response, 404, { message: "Branch not found" });
        return send(response, 200, detail);
      }

      if (resource === "pulls") {
        return send(response, 200, PULLS);
      }
    }

    return send(response, 404, { message: `no route for ${url.pathname}` });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    url: `http://127.0.0.1:${address.port}`,
    state,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
