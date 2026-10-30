# Offline daily-journal import

Administrative process only, not an HTTP endpoint. Run using an already-authorized
server operator account and the existing API container environment. It neither
reads sessions nor impersonates a logged-in user, changes credentials, calls a
model, searches places, or writes route points. Do not put private inputs in Git,
command arguments, shell history, CI artifacts or logs.

Run each command separately; each process has a 70-second hard deadline (including
stdin and pool shutdown), 5-second DB lock timeout, and 15-second statement timeout.
A deadline/transport loss during apply is an UNKNOWN outcome: inspect and replay
the same signed plan, never create another import blindly. No background task.

## Runtime and delivery

With this source installed in the existing Node 22 API image, argv is:

```
node --import tsx server/admin/journal-import-cli.ts inspect
node --import tsx server/admin/journal-import-cli.ts preview /private/plan.json
node --import tsx server/admin/journal-import-cli.ts apply /private/plan.json PLAN_DIGEST /private/before.json
node --import tsx server/admin/journal-import-cli.ts rollback-check /private/before.json
```

Paths are examples. Create a dedicated directory mode 0700 owned by the runtime
user (the image uses `node`); use real absolute paths, not symlink paths. Plans and
backups are exclusive-created, fsynced, mode 0600 and must be retained privately.
Apply requires a distinct backup path. Never mount a public/static directory.

For delivery to the existing image without changing the live application files,
build a reviewed standalone bundle (dependencies remain from the existing image):

```
node scripts/build-journal-admin.mjs /tmp/journal-import.mjs
sha256sum /tmp/journal-import.mjs
```

Verify the expected SHA-256 after transport. Place the bundle beneath `/app` so
existing package resolution works, e.g. `/app/.private-import/journal-import.mjs`;
use argv `node /app/.private-import/journal-import.mjs COMMAND ...`. The bundle
includes the updated repository transaction entry point; do not hot-patch the
running API's source files. The admin module alone is NOT a standalone upload.

## JSON protocol

Each command emits exactly one JSON line on stdout on success. Errors emit a
sanitized code on stderr and exit 1; deadline exits 2. No source prose is logged.

`inspect` reads stdin `{"email":"confirmed@example.test"}`. It returns candidates
with account ID/email, membership role, Atlas ID/title, Journey ID/title and date
range. It never chooses a candidate. No match is an empty list. Resolve any
ambiguity using owner-confirmed identity/context; preview requires all four exact
fields below. The database enforces unique email and organization membership.

`preview` reads stdin:

```
{"target":{"userId":"...","email":"confirmed@example.test","atlasId":"...","journeyId":"..."},"source":"private original text","fallbackDate":"2026-02-11"}
```

It locks the active Atlas/Journey and membership, checks update permission, merges
with existing chapters, validates structure, and writes a signed private plan.
The plan binds target, original-source digest, complete before/after journal,
revision and 24-hour expiry. Stdout returns `planDigest`, before/after revisions,
dates, total chapters and events. Review the private plan, not just these counts.
Clock values remain local; do not infer UTC. Explicit actual/planned/cancelled
markers are preserved; unmarked prose remains uncertain, not invented fact.
Exact same source/date reimport retains existing IDs and manual text. Modified
source is not fuzzy deduplicated: review new chapters before application.

`apply` requires the exact preview digest as argv. It verifies HMAC/shape/digest,
rechecks permission under transaction locks, refuses any before-version/content
change, durably writes the signed before/after backup, then calls the existing
journal repository in that same transaction. No-op/replay returns `already-applied`;
a new write returns `applied`, both with `revision`. Existing private backup is
reused only when identical. Failure to create backup prevents the database write.
Read back through inspect/preview or the existing repository to verify dates,
source hashes and unchanged manual content. Do not disclose private plan files.

## Recovery

`rollback-check` reads the signed backup and rechecks target permission. It returns
`eligible` only when the current journal exactly matches the recorded post-import
revision and content, plus expected/current revisions and backup digest. It is
read-only and does not require an unexpired preview.

There is deliberately no automatic destructive rollback command. If rollback is
needed, recheck this condition *inside the same locked transaction* immediately
before restoring `before.chapters` through `writeDailyJournal` using the current
revision. This creates a new revision; never reset revisions/digests with SQL.
If any subsequent edit occurred, stop and reconcile rather than restore a stale
snapshot. Keep an operator-managed database backup as a second recovery layer;
do not restore an entire production database over unrelated newer changes.
