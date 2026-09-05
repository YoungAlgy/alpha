# Free invite release, deployment held

This branch contains the prepared free invite-only, access-only release.
Publishing its source does not deploy it or apply its database migrations.

Paid checkout, paid quantity changes, and the billing portal remain closed.
Existing cancellation and historical settlement handling stay available.
Subscriber generation and delivery are source-paused. Saved-letter access and
invite approval are part of the prepared release.

Before deployment, complete the separately approved live release checks and
exact subscription-binding review. Apply only the reviewed atomic fourteen-
migration package, then the separately reviewed delivery clock-fence package
in the approved sequence. Do not rebuild or replace a frozen release artifact
from this branch merely because a portable helper is present here.

Production database, billing, reader access, provider callbacks, and retention
holds require current evidence. Local tests do not establish their live state.
Keep deployment held until those gates pass. Resuming subscriber letters needs
separate approval after callback and delivery-readiness verification.

Private backup archives, credentials, recovery keys, machine-specific recovery
tools, and operational receipts are intentionally outside this public branch.
Portable helper defaults write under the ignored `backup/` directory. Run them
only within their explicitly approved scope.

## Build-dependent checks still pending

The isolated release checkout has no generated `.next` or `.open-next` bundle.
The historical Round 30 built-output assertions and the worker-specific
TypeScript check therefore cannot pass here until a separately authorized
build creates those artifacts. Their checks remain intact. Do not copy an old
build into this checkout or treat a prior build as proof of this commit.
