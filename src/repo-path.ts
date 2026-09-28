import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Kept apart from auto-answer.ts so the Claude Code hook can validate
// `--repo-path` without loading the transport stack on every prompt.

export interface ValidateAnswerRepoPathOptions {
  /** Override for the user's home directory. Defaults to `os.homedir()` —
   *  tests set `process.env.HOME` and rely on that default rather than
   *  passing this explicitly. */
  home?: string;
}

export type AnswerRepoPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Whether `p` is safe to hand the read-only answerer as its cwd.
 *
 * `Read(./**\/)` etc. (`src/agent-cli.ts`) scope every allow/deny rule under
 * the cwd, so the cwd itself *is* the sandbox boundary: a relative path like
 * `.` resolves against whatever directory spawned the daemon (`$HOME` under
 * systemd, `/` under launchd), silently widening "the repo" to the whole
 * home directory or filesystem. This is the one gate every path the
 * answerer might run from — explicit `autoAnswer.repoPath` or an inferred
 * single repo — must pass through.
 *
 * A pure function of its arguments and the filesystem: no config, no
 * project lookup. Exported so other call sites (e.g. the CLI's own
 * `--repo-path` validation) can reuse the exact same checks.
 */
export function validateAnswerRepoPath(
  p: string,
  options: ValidateAnswerRepoPathOptions = {},
): AnswerRepoPathResult {
  if (!path.isAbsolute(p)) {
    return { ok: false, reason: `repoPath "${p}" is not an absolute path` };
  }
  const resolved = path.resolve(p);

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    return { ok: false, reason: `repoPath "${p}" does not exist` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: `repoPath "${p}" is not a directory` };
  }

  const home = path.resolve(options.home ?? homedir());
  if (resolved === home) {
    return {
      ok: false,
      reason: `repoPath "${p}" is the user's home directory — point it at a repo checkout, not $HOME`,
    };
  }
  if (resolved === path.parse(resolved).root) {
    return { ok: false, reason: `repoPath "${p}" is a filesystem root` };
  }

  return { ok: true, path: resolved };
}
