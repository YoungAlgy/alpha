# Braces depth-mitigation audit exception

The released CI policy in `551acfc` still has the November 2 calendar expiry.
Alex approved a local replacement on October 8, 2026: this one advisory's
allowance depends on verified mitigation and the exact reviewed development
graph, with no calendar expiry. This candidate is uncommitted and unreleased.
Approval includes one fresh public dependency audit and focused local checks.
It does not authorize a commit, push, deployment or workflow run.

`scripts/verify-dependency-audit.mjs` records the exact policy. It permits only
GHSA-vfj7-8cjw-p6xm, npm advisory source 1240992, for published braces 3.0.3.
Its calendar expiry is removed in the local candidate. Invalid clocks and
dates before the original October 3 activation still fail. Alpha owns the local
patch until a supported fixed replacement is verified. This is an ongoing,
advisory-specific risk allowance. It is not a claim that the published package
is fixed or that all denial-of-service inputs are safe. The daily sender,
recipients, schedule and live release are unchanged.

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

The October 8 local follow-up adds fixed failure stage/reason labels. Unknown
errors use a fixed fallback. Error messages, assertion diffs and child output
are never printed. This diagnostic change is uncommitted and unreleased until
separately approved. The safe labels do not alter advisory classification.

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

Focused offline checks include acceptance at and after the removed November 2
boundary and rejection of other findings and graph drift after that date.
The runner still warns whenever this allowance is used. Weekly fresh audits
remain enabled and never fix or upgrade dependencies automatically.

Focused offline checks: `node scripts/verify-dependency-audit-policy.mjs` and
the existing `verify-wrangler-guard-schedule-scope.mts` using installed local tsx.
The network-bearing runner is separate from the offline policy tests.

Official context: [GitHub advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
and [npm audit documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/).
