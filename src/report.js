function escapeCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function truncate(value, limit = 80) {
  const text = String(value ?? "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}...`;
}

function formatDate(iso) {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 10);
}

function formatTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function branchRow(branch) {
  const name = branch.url
    ? `[${escapeCell(branch.name)}](${branch.url})`
    : escapeCell(branch.name);
  const pull = branch.openPull
    ? `[#${branch.openPull.number}](${branch.openPull.url})`
    : "none";
  return `| ${name} | ${branch.ageDays}d | ${formatDate(branch.lastCommit)} | ${escapeCell(
    truncate(branch.author, 30),
  )} | ${pull} |`;
}

function pullRow(pull) {
  const title = pull.url
    ? `[#${pull.number} ${escapeCell(truncate(pull.title))}](${pull.url})`
    : `#${pull.number} ${escapeCell(truncate(pull.title))}`;
  return `| ${title} | ${pull.ageDays}d | ${pull.idleDays === null ? "?" : `${pull.idleDays}d`} | ${escapeCell(
    truncate(pull.author, 30),
  )} | ${pull.draft ? "yes" : "no"} |`;
}

export function summarise(result) {
  const totals = result.totals;
  return [
    plural(totals.repos, "repository", "repositories"),
    plural(totals.staleBranches, "stale branch", "stale branches"),
    plural(totals.stalePulls, "stale pull request", "stale pull requests"),
  ].join(", ");
}

export function renderMarkdown(result) {
  const lines = [];
  const thresholds = result.thresholds;

  lines.push("# Repository debt report", "");
  if (result.owner) {
    lines.push(`Owner: ${result.owner} (${result.ownerType})`);
  } else {
    lines.push("Source: explicit repository list");
  }
  lines.push(`Generated: ${formatTimestamp(result.generatedAt)}`);
  lines.push(`Branch SLA: ${thresholds.branchSlaDays} days`);
  lines.push(`Pull request SLA: ${thresholds.prSlaDays} days`);
  if (thresholds.prIdleDays > 0) {
    lines.push(`Pull request idle SLA: ${thresholds.prIdleDays} days`);
  }
  lines.push("");

  lines.push("## Summary", "");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Repositories scanned | ${result.totals.repos} |`);
  lines.push(`| Repositories with debt | ${result.totals.reposWithDebt} |`);
  lines.push(`| Stale branches | ${result.totals.staleBranches} |`);
  lines.push(`| Stale pull requests | ${result.totals.stalePulls} |`);
  lines.push(`| Repositories with errors | ${result.totals.repoErrors} |`);
  lines.push("");

  if (result.totals.findings === 0) {
    lines.push("No repository exceeded the configured thresholds.", "");
  } else {
    lines.push("## Findings", "");
    for (const repo of result.repos) {
      if (repo.branches.length === 0 && repo.pulls.length === 0) continue;
      lines.push(`### [${repo.fullName}](${repo.url})`, "");
      lines.push(
        `${plural(repo.branches.length, "stale branch", "stale branches")}, ` +
          `${plural(repo.pulls.length, "stale pull request", "stale pull requests")}.`,
        "",
      );

      if (repo.branches.length > 0) {
        lines.push("#### Branches", "");
        lines.push("| Branch | Age | Last commit | Author | Open PR |");
        lines.push("| --- | --- | --- | --- | --- |");
        for (const branch of repo.branches) {
          lines.push(branchRow(branch));
        }
        lines.push("");
      }

      if (repo.pulls.length > 0) {
        lines.push("#### Pull requests", "");
        lines.push("| Pull request | Age | Idle | Author | Draft |");
        lines.push("| --- | --- | --- | --- | --- |");
        for (const pull of repo.pulls) {
          lines.push(pullRow(pull));
        }
        lines.push("");
      }
    }
  }

  const errored = result.repos.filter((repo) => repo.errors.length > 0);
  if (errored.length > 0) {
    lines.push("## Incomplete repositories", "");
    for (const repo of errored) {
      lines.push(`### ${repo.fullName}`, "");
      for (const error of repo.errors) {
        lines.push(`- ${escapeCell(error)}`);
      }
      lines.push("");
    }
  }

  if (result.skipped.length > 0) {
    lines.push("## Skipped repositories", "");
    for (const entry of result.skipped) {
      lines.push(`- ${escapeCell(entry.name)}: ${escapeCell(entry.reason)}`);
    }
    lines.push("");
  }

  lines.push("## Suggested actions", "");
  lines.push("- Compare stale branches with the default branch and delete the ones already merged.");
  lines.push("- Assign an owner and a due date to stale pull requests, or close them with a note.");
  lines.push("- Enable automatic branch deletion after merge to keep this list short.");
  lines.push("- Run this report on a schedule and keep the output next to the repository.");
  lines.push("");

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}
