export class GitHubError extends Error {
  constructor(message, { status = 0, url = "", body = null } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class RateLimitError extends GitHubError {
  constructor(message, { resetAt = null, ...rest } = {}) {
    super(message, rest);
    this.name = "RateLimitError";
    this.resetAt = resetAt;
  }
}

const DEFAULT_API = "https://api.github.com";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encode(value) {
  return encodeURIComponent(value);
}

export class GitHubClient {
  constructor({
    token = "",
    apiUrl = DEFAULT_API,
    userAgent = "rbi/0.1.0",
    maxRetries = 2,
    maxRateLimitWaitMs = 30000,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("this Node.js version has no global fetch, use Node 18 or newer");
    }
    this.token = token;
    this.apiUrl = String(apiUrl || DEFAULT_API).replace(/\/+$/, "");
    this.userAgent = userAgent;
    this.maxRetries = maxRetries;
    this.maxRateLimitWaitMs = maxRateLimitWaitMs;
    this.fetchImpl = fetchImpl;
    this.rateLimit = { remaining: null, resetAt: null };
  }

  buildUrl(path, query = {}) {
    const url = new URL(this.apiUrl + (path.startsWith("/") ? path : `/${path}`));
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  headers(extra = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.userAgent,
      ...extra,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  async request(path, { method = "GET", query = {}, headers = {} } = {}) {
    const url = this.buildUrl(path, query);
    let attempt = 0;

    while (true) {
      let response;
      let text = "";
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: this.headers(headers),
        });
        text = await response.text();
      } catch (cause) {
        if (attempt < this.maxRetries) {
          attempt += 1;
          await sleep(250 * attempt);
          continue;
        }
        throw new GitHubError(`network error for ${url.pathname}: ${cause.message}`, {
          url: String(url),
        });
      }

      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      this.rateLimit = {
        remaining: remaining === null ? null : Number(remaining),
        resetAt: reset === null ? null : new Date(Number(reset) * 1000),
      };

      if (response.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      const blocked =
        (response.status === 403 || response.status === 429) &&
        this.rateLimit.remaining === 0;

      if (blocked) {
        const waitMs = this.rateLimit.resetAt
          ? Math.max(0, this.rateLimit.resetAt.getTime() - Date.now())
          : 0;
        if (waitMs > 0 && waitMs <= this.maxRateLimitWaitMs) {
          await sleep(waitMs + 1000);
          continue;
        }
        throw new RateLimitError(
          this.rateLimit.resetAt
            ? `GitHub rate limit reached, it resets at ${this.rateLimit.resetAt.toISOString()}`
            : "GitHub rate limit reached",
          { status: response.status, url: String(url), resetAt: this.rateLimit.resetAt },
        );
      }

      if (response.status >= 500 && attempt < this.maxRetries) {
        attempt += 1;
        await sleep(500 * attempt);
        continue;
      }

      let message = `GitHub returned ${response.status} for ${url.pathname}`;
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
          if (body && body.message) message = `${body.message} (${response.status})`;
        } catch {
          body = text;
          const trimmed = String(text).trim();
          if (trimmed && trimmed.length < 200) message = `${trimmed} (${response.status})`;
        }
      }
      throw new GitHubError(message, {
        status: response.status,
        url: String(url),
        body,
      });
    }
  }

  async paginate(path, { query = {}, perPage = 100, maxItems = Infinity } = {}) {
    const items = [];
    let page = 1;
    while (items.length < maxItems) {
      const batch = await this.request(path, {
        query: { ...query, per_page: perPage, page },
      });
      if (!Array.isArray(batch) || batch.length === 0) break;
      items.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }
    return items.slice(0, maxItems);
  }

  async getRateLimit() {
    const payload = await this.request("/rate_limit");
    return payload && payload.resources ? payload.resources.core || null : null;
  }

  async getAuthenticatedUser() {
    return this.request("/user");
  }

  async getRepo(owner, name) {
    return this.request(`/repos/${encode(owner)}/${encode(name)}`);
  }

  async listOrgRepos(org, { maxItems = Infinity } = {}) {
    const repos = [];
    let page = 1;
    const perPage = 100;
    while (repos.length < maxItems) {
      const batch = await this.request(`/orgs/${encode(org)}/repos`, {
        query: { per_page: perPage, page, type: "all", sort: "full_name", direction: "asc" },
      });
      if (!Array.isArray(batch) || batch.length === 0) break;
      repos.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }
    return repos.slice(0, maxItems);
  }

  async listUserRepos(user, { maxItems = Infinity } = {}) {
    const repos = [];
    let page = 1;
    const perPage = 100;
    while (repos.length < maxItems) {
      const batch = await this.request(`/users/${encode(user)}/repos`, {
        query: { per_page: perPage, page, type: "owner", sort: "full_name" },
      });
      if (!Array.isArray(batch) || batch.length === 0) break;
      repos.push(...batch);
      if (batch.length < perPage) break;
      page += 1;
    }
    return repos.slice(0, maxItems);
  }

  async listAllBranches(owner, name, { maxItems = 200 } = {}) {
    return this.paginate(`/repos/${encode(owner)}/${encode(name)}/branches`, {
      maxItems,
    });
  }

  async getBranch(owner, name, branch) {
    return this.request(
      `/repos/${encode(owner)}/${encode(name)}/branches/${encode(branch)}`,
    );
  }

  async listOpenPulls(owner, name, { maxItems = 200 } = {}) {
    return this.paginate(`/repos/${encode(owner)}/${encode(name)}/pulls`, {
      query: { state: "open", sort: "created", direction: "asc" },
      maxItems,
    });
  }
}
