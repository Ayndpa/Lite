// git command layer: runs `git` through the host (ctx.git.run, workspace folder) and parses output.
// Mirrors git-insight's git_info.rs, plus what source control needs (status v2, branches, staging…).

export class GitError extends Error {}

export function createGit(ctx) {
  // Once the repository is known, commands run at its top level (-C), so repo-relative paths from
  // `status` work even when the workspace is a subfolder of the repository.
  let top = [];
  /** Raw run; never throws for a non-zero exit. */
  // --literal-pathspecs: file names with * ? [ are paths, not patterns.
  const run = (args, opts) => ctx.git.run([...top, "--literal-pathspecs", "-c", "core.quotepath=false", "-c", "color.ui=false", ...args], opts);
  /** Run and return stdout; throws GitError with git's message on failure. */
  const ok = async (args, opts) => {
    const r = await run(args, opts);
    if (r.code !== 0) throw new GitError((r.stderr || r.stdout).trim() || `git ${args[0]} exited with ${r.code}`);
    return r.stdout;
  };
  /** stdout, or null on failure (for optional facts). */
  const maybe = async (args) => {
    const r = await run(args);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  return { run, ok, maybe, setRoot: (root) => (top = root ? ["-C", root] : []) };
}

/** `git --version` works? */
export async function gitAvailable(git) {
  try {
    return (await git.run(["--version"])).code === 0;
  } catch {
    return false; // git not on PATH: spawn failed
  }
}

/** Repository top level (native separators), or null when the workspace isn't in a repo. */
export async function repoRoot(git, sep) {
  const top = await git.maybe(["rev-parse", "--show-toplevel"]);
  return top ? top.replace(/\//g, sep) : null;
}

/**
 * `git status --porcelain=v2 -z --branch --untracked-files=all`
 * -> { branch, detached, oid, upstream, ahead, behind, staged[], unstaged[], conflicts[] }
 * entries: { path (repo-relative, "/"), status: "M"|"A"|"D"|"R"|"C"|"T"|"U"(untracked/unmerged), orig? }
 */
export async function status(git) {
  const out = await git.ok(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]);
  const s = { branch: null, detached: false, oid: null, upstream: null, ahead: 0, behind: 0, staged: [], unstaged: [], conflicts: [] };
  const recs = out.split("\0");
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r) continue;
    if (r.startsWith("# ")) {
      const [, key, ...rest] = r.split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") s.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") value === "(detached)" ? (s.detached = true) : (s.branch = value);
      else if (key === "branch.upstream") s.upstream = value;
      else if (key === "branch.ab") {
        const [a, b] = rest;
        s.ahead = Math.abs(parseInt(a, 10)) || 0;
        s.behind = Math.abs(parseInt(b, 10)) || 0;
      }
      continue;
    }
    const parts = r.split(" ");
    if (r[0] === "1" || r[0] === "2") {
      const xy = parts[1];
      const path = parts.slice(r[0] === "1" ? 8 : 9).join(" ");
      const orig = r[0] === "2" ? recs[++i] : undefined;
      if (xy[0] !== ".") s.staged.push({ path, status: xy[0], orig });
      if (xy[1] !== ".") s.unstaged.push({ path, status: xy[1], orig });
    } else if (r[0] === "u") {
      s.conflicts.push({ path: parts.slice(10).join(" "), status: "U" });
    } else if (r[0] === "?") {
      s.unstaged.push({ path: r.slice(2), status: "U", untracked: true });
    }
  }
  if (s.detached && s.oid) s.branch = s.oid.slice(0, 7);
  return s;
}

/** Local and remote branches: [{ name, current, remote }] */
export async function branches(git) {
  const local = (await git.maybe(["branch", "--format=%(HEAD)%00%(refname:short)"])) ?? "";
  const remote = (await git.maybe(["branch", "-r", "--format=%(refname:short)"])) ?? "";
  const list = local.split("\n").filter(Boolean).map((l) => {
    const [head, name] = l.split("\0");
    return { name, current: head === "*", remote: false };
  });
  const localNames = new Set(list.map((b) => b.name));
  for (const name of remote.split("\n").map((s) => s.trim()).filter((s) => s && !s.endsWith("/HEAD") && s.includes("/"))) {
    if (!localNames.has(name.slice(name.indexOf("/") + 1))) list.push({ name, current: false, remote: true });
  }
  return list;
}

/** `git@host:owner/repo.git`, `ssh://…`, `https://user:token@…` -> browsable https URL (credentials removed). */
export function toWebUrl(remote) {
  const raw = (remote ?? "").trim();
  let url;
  const scp = raw.match(/^[^@/\s]+@([^:/\s]+):(?!\/\/)(.+)$/);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  else if (raw.startsWith("ssh://")) {
    const rest = raw.slice(6).replace(/^[^@/]*@/, "");
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    url = `https://${rest.slice(0, slash).split(":")[0]}${rest.slice(slash)}`;
  } else url = raw;
  const m = url.match(/^(https?:\/\/)(.*)$/i);
  if (!m) return null;
  let rest = m[2];
  const at = rest.indexOf("@");
  if (at >= 0 && !rest.slice(0, at).includes("/")) rest = rest.slice(at + 1);
  return (m[1] + rest).replace(/\.git$/, "");
}

/** Facts for the repository overview (git-insight's "Git info" card + KPIs + activity). */
export async function overview(git, days) {
  const [s, total, last, remotes] = await Promise.all([
    status(git),
    git.maybe(["rev-list", "--count", "HEAD"]),
    git.maybe(["log", "-1", "--format=%h%x00%s%x00%an%x00%cI", "--no-decorate"]),
    git.maybe(["remote"]),
  ]);
  const info = {
    ...s,
    totalCommits: Number(total) || 0,
    dirty: s.staged.length + s.unstaged.filter((e) => !e.untracked).length + s.conflicts.length,
    untracked: s.unstaged.filter((e) => e.untracked).length,
  };
  if (last) {
    const [sha, subject, author, date] = last.split("\0");
    Object.assign(info, { shortSha: sha, lastCommit: subject, lastAuthor: author, lastDate: date });
  }
  const remoteName = remotes?.split("\n").map((r) => r.trim()).find(Boolean);
  if (remoteName) {
    info.remoteName = remoteName;
    info.remote = await git.maybe(["remote", "get-url", remoteName]);
    info.remoteUrl = toWebUrl(info.remote);
  }
  // Activity: commits per day over `days`, and the previous period of the same length (for the trend).
  const day = (d) => d.toISOString().slice(0, 10);
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  const prevStart = new Date(start);
  prevStart.setDate(prevStart.getDate() - days);
  const log = info.totalCommits ? await git.maybe(["log", `--since=${day(prevStart)} 00:00`, "--format=%ad", "--date=short"]) : "";
  const perDay = new Map();
  let prev = 0;
  for (const d of (log ?? "").split("\n").map((x) => x.trim()).filter(Boolean)) {
    if (d < day(start)) prev++;
    else perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  info.activity = Array.from({ length: days }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return { date: day(d), count: perDay.get(day(d)) ?? 0 };
  });
  info.prevPeriodCommits = prev;
  return info;
}

/**
 * Lines per file, counted by git itself: `git grep -c ""` over tracked + untracked files, skipping
 * binaries (-I). respectIgnore=false also includes .gitignore'd files (git-insight's "all files").
 * -> [{ path, lines }]   (empty files have no line to match and are left out)
 */
export async function lineCounts(git, respectIgnore) {
  const args = ["grep", "-I", "-c", "-z", "--untracked", ...(respectIgnore ? [] : ["--no-exclude-standard"]), "-e", "", "--", "."];
  const r = await git.run(args);
  if (r.code > 1) throw new GitError(r.stderr.trim()); // 1 = no matches
  const out = [];
  for (const line of r.stdout.split("\n")) {
    const nul = line.indexOf("\0");
    if (nul > 0) out.push({ path: line.slice(0, nul), lines: Number(line.slice(nul + 1)) || 0 });
  }
  return out;
}
