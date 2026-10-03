# Temporary braces depth-mitigation audit exception

Local preparation approved by Alex on October 3, 2026. This is a proposed CI
policy change. It does not approve a commit, push, deployment or workflow run.

`scripts/verify-dependency-audit.mjs` records the exact policy. It permits only
GHSA-vfj7-8cjw-p6xm, npm advisory source 1240992, for published braces 3.0.3.
The exception expires at 2026-11-02 00:00 UTC. Root chose this thirty-day review
boundary. It cannot renew itself. Expiry affects the audit gate, with no change
to the daily sender, recipients or schedule.

The runner first reruns the installed dependency contract and the braces depth
guard in the same process invocation. A missing, changed or additional copy
blocks the exception. There is no environment override, saved-report input or
flag to skip mitigation. The existing tokenizer patch remains required.

It then requests one fresh public npm audit report with the existing high
threshold and explicitly includes development, optional and peer dependencies.
There are no audit fixes or automatic retries. The child process has no app
configuration, credentials or environment hooks. Only sanitized aggregate
results and a visible exception warning are printed. Raw npm stderr and audit
reports are withheld. A project `.npmrc` also blocks this credential-free path.

Every high finding must traverse entirely to the one exact reviewed advisory.
The locked development-tool paths, versions and dependency edges must match
the reviewed graph. Package-name allowlisting alone is insufficient. A second
advisory on the same package still blocks. Critical findings always block.
Unknown report shapes, inconsistent counts, dangling/cyclic graphs, process
errors, understated advisory severity and an unexplained exit status block. Low/moderate findings retain the
existing threshold behavior.

The audit still reports the high advisory. A local patch does not change the
published package identity. The wrapper's successful exit means only that the
specific reported issue has the checked local mitigation and all other
high/critical findings are absent. It is not a zero-vulnerability assertion.

After a published fixed version becomes available, review an exact dependency
update, remove the local patch/guard and this exception together, and rerun the
affected checks. A clean report needs no exception, but version changes still
require the existing install contract to be updated through that review.

Focused offline checks: `node scripts/verify-dependency-audit-policy.mjs` and
the existing `verify-wrangler-guard-schedule-scope.mts` using installed local tsx.
The network-bearing runner is separate from the offline policy tests.

Official context: [GitHub advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
and [npm audit documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/).
