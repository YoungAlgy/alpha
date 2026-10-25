# Braces depth-mitigation audit exception

The current CI policy was committed and pushed as `7426ce5` on October 8, 2026
under Alex's separate maintenance-release approval. Exact-source CI passed,
including the fresh dependency audit and normal production build. This one
advisory's allowance depends on verified mitigation and the exact reviewed
development graph, with no calendar expiry. No website deployment or letter
was needed or performed. The completed approval grants no further release or
workflow action. Evidence is `braces-mitigation-policy-release-20261008.md`
in the external receipt folder.

`scripts/verify-dependency-audit.mjs` records the exact policy. It permits only
GHSA-vfj7-8cjw-p6xm, npm advisory source 1240992, for published braces 3.0.3.
Its former November 2 calendar expiry is removed. Invalid clocks and
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

The same maintenance release adds fixed failure stage/reason labels. Unknown
errors use a fixed fallback. Error messages, assertion diffs and child output
are never printed. The safe labels do not alter advisory classification.

Every high finding must traverse entirely to the one exact reviewed advisory.
The locked development-tool paths, versions and dependency edges must match
the reviewed graph. Package-name allowlisting alone is insufficient. A second
advisory on the same package still blocks. Critical findings always block.
An npm report may label a parent package moderate while a referenced child has
a high advisory. The policy checks each package's direct advisories against
that package's own severity, then uses the highest reachable advisory severity
for blocking. A moderate parent with a high descendant does not gain a new
exception. Unknown report shapes, inconsistent counts, dangling or cyclic
graphs, direct advisory severity above its own package label, process errors
and an unexplained exit status block. Low and moderate findings with no high
or critical descendant retain the existing threshold behavior.

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

## October 25 local security candidate

The local candidate raises reviewed floors to Next and eslint-config-next
16.4.3, DOMPurify 3.4.17, Zod 4.6.6, Undici 7.30.1 and body-parser 2.4.0.
The new lock retains Wrangler 4.131.0, Miniflare 5.20260910.0-alpha,
sharp 0.35.5, and the existing tokenizer and braces patch guards. The
reviewed lint path now begins with eslint-config-next 16.4.3 and
@next/eslint-plugin-next 16.4.3. Its edge to fast-glob remains exactly 3.3.1.

The saved public npm v2 report listed three high, two critical and three
moderate package findings. It included a moderate OpenNext to Wrangler to
Miniflare chain ending in a high Undici advisory. The earlier policy rejected
that valid parent/child severity shape before classifying risk. The revised
policy accepts the shape and blocks the high leaf. It adds no advisory waiver.
This section describes local source and lock evidence. A fresh audit and
installed mitigation check still determine release readiness.

Official context: [GitHub advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
and [npm audit documentation](https://docs.npmjs.com/cli/v11/commands/npm-audit/).
