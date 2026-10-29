# RBI

Repository Debt Inspector. A command line tool for GitHub that finds branches and open pull requests which have been sitting longer than your team allows, then writes a Markdown report you can keep next to the repository or post in a weekly issue.

No configuration files, no database, no service to run. One Node.js package that talks to the GitHub REST API.

```
$ rbi scan --org acme --branch-sla 60 --pr-sla 14
rbi: scanning acme (branch SLA 60d, pull request SLA 14d)
rbi: 1/4 api
rbi: 4/4 web
# Repository debt report

Owner: acme (org)
Generated: 2026-10-29 12:00 UTC
Branch SLA: 60 days
Pull request SLA: 14 days

## Summary

| Metric | Value |
| --- | --- |
| Repositories scanned | 4 |
| Repositories with debt | 1 |
| Stale branches | 1 |
| Stale pull requests | 1 |
```

## Requirements

Node.js 18 or newer. A GitHub token is strongly recommended. Without one, the REST API allows 60 requests per hour, which one repository can use up on branches alone.

## Install

```sh
npm install -g .
```

Or run it from the checkout:

```sh
node bin/rbi.js --help
```

## Quick start

```sh
export GITHUB_TOKEN=ghp_your_token
rbi scan --org your-org
```

Scan a single repository and print JSON:

```sh
rbi scan --repo your-org/api --format json
```

Scan several repositories and write a file:

```sh
rbi scan --repo your-org/api --repo your-org/web --out debt.md
```

Fail a scheduled job when anything is stale:

```sh
rbi scan --org your-org --fail
```

## How debt is measured

A branch is stale when:

1. It is not the default branch.
2. Its latest commit is at least `--branch-sla` days old.

An open pull request is stale when it was created at least `--pr-sla` days ago. Add `--pr-idle-sla` to also flag pull requests that have not been updated in that many days, even if they are newer than the main SLA.

Merged and closed pull requests are ignored. Archived repositories are skipped unless `--include-archived` is set. Forks are included unless `--exclude-forks` is set. The branch and pull request counts are capped by `--max-branches` and `--max-pulls` so a very large repository cannot stall the run.

Branch ages come from commit dates, so RBI asks for each candidate branch separately. A repository with 150 branches costs one request for the list, one for each non-default branch, and one for open pull requests. Keep `--max-branches` in mind on metered tokens.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--org NAME` | none | Organization or user to scan. |
| `--repo OWNER/NAME` | none | Scan one repository. Repeatable. |
| `--branch-sla DAYS` | `60` | Branch age limit. |
| `--pr-sla DAYS` | `14` | Pull request age limit. |
| `--pr-idle-sla DAYS` | `0` | Also report PRs idle for this long. Zero disables it. |
| `--max-repos N` | `100` | Repository limit for an organization scan. |
| `--max-branches N` | `200` | Branch limit per repository. |
| `--max-pulls N` | `200` | Open pull request limit per repository. |
| `--concurrency N` | `4` | Repositories scanned in parallel. |
| `--branch-concurrency N` | `4` | Branch detail requests in parallel per repository. |
| `--exclude GLOB` | none | Skip repositories by name. Repeatable. |
| `--include-archived` | off | Include archived repositories. |
| `--exclude-forks` | off | Skip forks. |
| `--owner-type TYPE` | `auto` | `auto`, `org`, or `user`. |
| `--format FORMAT` | `markdown` | `markdown` or `json`. |
| `--out FILE` | stdout | Write the report to a file. |
| `--token TOKEN` | env | GitHub token. |
| `--api-url URL` | github.com | API base, useful for GitHub Enterprise. |
| `--fail` | off | Exit with code 2 when findings exist. |
| `--quiet` | off | Suppress progress and the closing summary. |
| `--verbose` | off | Print the authenticated user and quota. |

`--org` and `--repo` are mutually exclusive. With `--owner-type auto`, an organization is tried first, then a user with the same name.

Environment variables: `GITHUB_TOKEN` or `GH_TOKEN`, and `GITHUB_API_URL`.

## Output

The Markdown report has a summary table, one section per repository with findings, a list of repositories that could not be read, skipped repositories, and suggested actions. Each branch links to the tree view and shows its age, last commit date, author, and any open pull request on the same branch. Pull request rows link to the PR and show age, idle days, author, and draft state.

Repositories with no findings are counted in the summary but do not get a section.

JSON output contains the same data with `owner`, `ownerType`, `generatedAt`, `thresholds`, `repos`, `skipped`, and `totals`. Each repository has `branchCount`, `openPullCount`, `branches`, `pulls`, and `errors`.

```
owner/repo
  branches[]   name, sha, lastCommit, ageDays, author, url, openPull
  pulls[]      number, title, url, author, draft, branch, base,
               createdAt, updatedAt, ageDays, idleDays, idleStale, labels
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Scan finished. Debt may or may not exist. |
| `1` | Bad arguments, authentication failure, or a failed API lookup. |
| `2` | `--fail` was set and at least one finding was reported. |

A repository that cannot be read is recorded in the report and does not stop the scan.

## Scheduled runs

```yaml
name: debt
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:

jobs:
  report:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install -g .
      - run: rbi scan --org ${{ github.repository_owner }} --out debt.md --fail
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: debt-report
          path: debt.md
```

The built in `GITHUB_TOKEN` can read public repositories. For private repositories, use a token with `repo` scope, or grant the workflow `contents: read` and `pull-requests: read` permissions.

## JavaScript API

```js
import { GitHubClient, scanOwner, renderMarkdown } from "rbi";

const client = new GitHubClient({ token: process.env.GITHUB_TOKEN });
const result = await scanOwner(client, "acme", {
  branchSlaDays: 60,
  prSlaDays: 14,
  excludeForks: true,
  onProgress: (done, total, name) => process.stderr.write(`${done}/${total} ${name}\n`),
});

process.stdout.write(renderMarkdown(result));
console.log(result.totals);
```

Useful exports:

| Export | Purpose |
| --- | --- |
| `GitHubClient` | REST client with pagination, retries, and rate limit handling. |
| `scanOwner` | Scan an organization or user. |
| `scanRepo` | Scan one repository. |
| `scanRepos` | Scan explicit `{ owner, name }` targets. |
| `classifyBranch` | Apply the branch SLA to one branch object. |
| `classifyPull` | Apply the pull request SLAs to one PR object. |
| `renderMarkdown` | Build the report. |
| `renderJson` | Serialize the result. |

## Rate limits

Response headers are tracked on every call. If a request is rejected because the hourly quota is gone, RBI waits for the reset when it is less than 30 seconds away, then retries. Otherwise it stops with the reset time so a scheduled job fails with a clear message instead of a stack trace.

Server errors and network errors are retried twice with a short backoff.

## Limits

- Only GitHub is supported. GitLab and Bitbucket have different APIs and are out of scope.
- Branch ages need one request per branch. A repository with thousands of branches should use a smaller `--max-branches`.
- Merged branches are not detected. The branch list only says a branch exists, not whether its work landed.
- Pull request review state, checks, and merge conflicts are not part of the report.
- The tool reads. It never deletes a branch or closes a pull request.

## Tests

```sh
npm test
```

The suite uses the Node.js test runner and a local fake GitHub API. It covers age calculations, SLA boundaries, branch and PR classification, glob filters, pagination, retries, rate limit errors, request headers, organization and user lookups, skip rules, totals, Markdown rendering, JSON output, CLI validation, exit codes, file output, and progress messages.

## License

MIT. See `LICENSE`.
