# Read-only create boundary source

Version 0.68.0 implements only source stop 2a of the accepted [create boundary plan](../../results/m2-create-boundary-plan.md). A finite `create-boundary` mode in the existing global job lock owns one operation UUID, transfer and inspect phases, attempted-before-record-I/O retention, and confirmed cleanup. Its fixed root offline transfer copies only the transition password and a public-identity invocation marker into a private external volume for UID 1000. The optional Compose profile defines a network-free transfer and a read-only combined consumer on only the admin DB and internal search networks. Neither service is started by normal application profiles. There is no owner Docker caller, automatic retry, index creation, CAS write, publication or serving path in this stop.

The consumer uses the fixed `station_search_transition` snapshot reader, fixed admin TLS observer and mandatory E0b bootstrap-state reader. It requires complete/ready E0b state with the legacy UUID in retained history, disabled intent, both gates false and a matching database OID and fixed `station` database-owner name. It derives a precreate expectation from the first snapshot solely for read-only evidence, then rechecks that exact snapshot, state and copied marker. Its result is never ready and cannot authorize a write. The marker carries the lock UUID, project, database OID, fixed owner name and PostgreSQL system identifier; the restricted database snapshot has no owner OID or system identifier. Those host identities, the original credential/resource identity, full public certificate/manifest attestation and a separately approved sealed create intent require the future owner stop 2b/stop 3 boundary. Successful admin TLS here alone does not establish the full C4e certificate proof.

The local focused tests and daemon-free Compose render proof cover source structure only. Actual two-owner PG16/OpenSearch 3.9 TLS execution, negative network/identity/secret proofs and full Ubuntu workflow acceptance remain pending. See [the implementation handoff](../../results/m2-create-boundary-implementation.md).

The 0.68.0 source stop passed all nine Ubuntu workflow jobs in run `40602644027` at `9d0d08f`. Version 0.69.0 adds a fixed, reviewed-in-stages owner delivery implementation. Its owner CLI takes no role, create descriptor or retry option. One global lock UUID binds an owner-private marker, exact transition-only credential capture, a network-free transfer and the read-only consumer. A private Docker policy helper is shared with the accepted attestor; each owner command still fixes its own services, commands and topology. The owner rechecks the original credential and a freshly constructed host adapter's full PG installation, container and admin-network identity around both dispatches. Its finite, redacted diagnostic categories expose no raw subprocess output. Unknown sends and failed cleanup retain the lock. The dedicated actual both-owner runtime gate and full review remain pending; this source stage alone establishes no delivery acceptance or write authority.

The 0.69.0 source includes a dedicated disposable Ubuntu gate for the fixed owner and both UID pairs. It checks actual CLI success, transition SCRAM/admin TLS, read-only DB/engine/E0b evidence, direct-IP network isolation, role denials, bounded Docker faults, drift and secret output. Terminal mapping drift and retained-source loss are assigned to different disposable owner pairs because neither state can be safely repaired by the observation job.

The full 0.69.0 Ubuntu workflow passed all ten jobs in run `40608107386` at `76f5bdd`. Astra accepted the actual both-owner read-only delivery review. Version 0.70.0 starts the separate owner-approved create-intent foundation. Its pure source seals the complete frozen create body separately from the DB dispatch metadata hash, binds every prior history row and prior dispatch to the observed physical/security collections and E0b state, and binds validated public PEM bytes including CA and admin. Candidate N and its evolving create dispatch are excluded from that cross-run digest and checked by phase-specific never-ready predicates instead. The existing C4e ready attestor remains unchanged. No create request or CAS write is wired by this source stop.

The next 0.70.0 source review adds a **separate fixed read-only prepare job**. It uses the same root-only password transfer and only the admin DB/internal search networks, then returns a bounded canonical public projection from the transition snapshot, fixed admin TLS observer and complete E0b state. It rechecks the original database snapshot, state, invocation and the mounted admin certificate/key identity after the final observer call. The owner compares the job's public CA/admin hashes to nofollow-captured original source certificates, verifies their key/leaf match and all prior public certificates, and writes one exclusive mode-0400 pending intent under the global prepare lock. The pending file carries a planned dispatch and DB owner UUID distinct from the lock UUID. A partial pending write, unknown Docker result or ambiguous cleanup retains the lock; an existing pending file refuses a new proposal. This is source under review: the two-UID disposable Ubuntu PostgreSQL/OpenSearch certificate and fault gate has not run, and the pending proposal has no authority to send, write CAS, publish or serve.

The 0.70.0 gate source now runs this fixed prepare CLI and its certificate/pending fault cases inside each existing disposable 0.69 owner fixture, before the old terminal drift cases. It compares actual PostgreSQL registry, OpenSearch admin-TLS observer and E0b volume evidence before fault cleanup, checks the exact public pending bytes and retained locks, and leaves the existing network, credential and role-isolation gate in place. This is a local source check only until the GitHub Actions Ubuntu job executes after integration; it does not establish runtime acceptance or any create authority.

The first 0.70.0 Ubuntu run `40614556509` passed the fixed prepare CLI, public certificate identity and preexisting pending-file refusal, then failed at the new fixture's fresh-projection checkpoint before the later fault matrix. The private failure log was removed, so the exact failed assertion is unknown. Version 0.70.1 aligns the fixture's stopped network-free transfer inspection with the already accepted owner policy: Docker may report either no network entry or exactly the captured `none` network, while the host network mode must still be `none`. It also adds finite redacted fresh-projection subcheckpoints for the rerun. No production policy or create authority changes; complete Ubuntu acceptance remains pending.

The 0.70.1 rerun `40616078608` narrowed the failure to the fixture's independent terminal transfer policy check. The exact assertion was still not exposed. Version 0.70.2 corrects another concrete fixture overconstraint: Docker may omit `HostConfig.Mounts.ReadOnly` for a writable mount, which the accepted production policy already treats as equivalent to `false`; the actual invocation volume must independently have effective `RW: true`, while both bind inputs remain effectively read-only. Finite transfer subpolicy checkpoints and a test for omitted/false/true/redirected mount shapes make the next Ubuntu result actionable. No production behavior changes; actual 3a acceptance remains pending.

The 0.70.2 Ubuntu run `40617181162` passed the fresh projection and transfer policy, then stopped at `intent-pending-inode`. The fixture had placed the inode-replacement backup under `.cache/results`, a directory omitted from its isolated checkout and never created there. Version 0.70.3 creates one verified owner-private fixture scratch directory under `.cache` for that backup and the later expired-public-certificate probe. It proves the backup keeps the original inode and the new pending file has different inode, identical bytes and mode 0400 before accepting the expected owner rejection. The same-size mutation must also prove unchanged inode and length with changed bytes. Fixed redacted subcheckpoints and local real-file writer/owner-seam tests cover these fixture paths. This changes no production authority or fail-closed policy; complete Ubuntu acceptance remains pending.

The 0.70.3 Ubuntu run `40618540595` passed the inode and same-size fault cases, then stopped at `intent-missing-admin-public`. The source-mutation fixture restored the admin certificate in its fault callback and again in `finally`; its state flag stayed true after the first successful restore, so the second pass removed the original and failed. Version 0.70.4 clears that flag only after successful restoration and sets it immediately after renaming the original, so a failed replacement copy is still restored. Real filesystem tests cover missing and swapped public files, double restoration, and partial copy failure with original inode and bytes preserved. No production behavior changes; actual Ubuntu acceptance remains pending.

The 0.70.4 Ubuntu run `40619902442` passed the preceding certificate fault cases, then stopped at the expired-admin-public fixture. Local reproduction showed OpenSSL rejected the fixture's attempt to CA-sign an already CA-signed certificate as input. Version 0.70.5 generates a certificate request from the original admin key and signs it with the existing fixture CA for zero days, with the exact admin subject and client extensions. The gate checks CA signature, admin key match, certificate profile and actual expiry before injection; a local real-certificate test proves the valid baseline captures and the expired replacement is rejected. Finite redacted setup, fault and restoration checkpoints retain the privacy boundary. This is gate-only; actual Ubuntu acceptance remains pending.

Full Ubuntu run `40621241977` passed all ten jobs at `00f14f33b4e7f2e8ea78732a3191f7520777f50b`; Astra accepted the actual 3a prepare/certificate runtime review. Version 0.71.0 began only the first 3b source slice: a fixed positional owner approval parser, exact nofollow/canonical pending reader, fresh apply-lock B and an exclusive private binding file. Binding attempt is latched before its lock record and file I/O, and a bound or uncertain lock cannot be released by this source stage. The binding file and pending proposal stay consumed after an offline proof; that first slice connected no live apply CLI, Docker dispatch, DB CAS, SDK create, publication or serving. The later actual create-send acceptance is recorded below.
# Fixed create apply source slice

The one-shot create consumer uses a finite `presend` evidence phase after its
original dispatch changes from `armed` to `sent_unknown` and before the SDK
call. This phase requires the candidate index to remain absent, the same
dispatch owner and target, exact prior history and security evidence, and both
SQL gates false. It cannot certify a response, UUID binding, or readiness.
The consumer checks the sealed original source UUID and retains the original
mounted admin certificate/key inode identity across observer and SDK awaits.
The consumer only returns `uuid_bound` after the same invocation's definitive
create response and exact readback UUID. A failed or lost response remains
`sent_unknown`; no recovery is licensed by this source slice.

The following 0.71.0 owner source slice adds a fixed positional CLI that binds
the sealed approval to a fresh apply lock B, stages exactly the original prior
public PEM files, and runs one network-free transfer followed by one UID 1000
create consumer. It rechecks the original pending file, binding, public files,
host PostgreSQL owner and Docker infrastructure around each dispatch. Only the
original consumer's definitive `uuid_bound` result and exact cleanup of its
containers, volume and staged public files release B. Uncertain dispatch,
response, identity or cleanup retains B and the consumed binding; neither
external lock loss nor a new owner permits replay. Both SQL search gates remain
false. This source has daemon-free render and scripted fault checks only; the
two-UID PostgreSQL 16/OpenSearch runtime send gate and milestone acceptance
remain pending.

The complete 0.71.0 binding, consumer, owner and runtime-gate source has passed
Astra review. Full local checks and the real-filesystem and mutual-TLS fixture
tests pass. The disposable Ubuntu gate now exercises actual SDK response loss,
partial acknowledgements, process termination, timeout, database failure,
concurrency, approval replay and host/security drift for both owner UID pairs.
Its terminal missing-source probe preserves the original sealed approval and
never recreates the deleted source index. These are implemented test cases,
not runtime results: the combined GitHub Actions run and independent runtime
review remain required before accepting this slice. Search remains disabled.

The first integrated 0.71.0 Ubuntu run `41740040945` failed in the default
owner pair's new create-apply gate after the prior intent-prepare gate passed.
The public filtered log exposed only `prepare` after about 160 seconds; the
fixture reused that label for every scenario and for assertions after the
prepare call, so the original cause cannot be established from the retained
evidence. Version 0.71.1 adds an explicit finite scenario to every prepare
invocation, redacted substeps around its DB/engine/source/owner/seal checks,
and distinct typed-approval negative labels. The filter accepts only these
fixed names and never forwards dynamic details or private command output.
No product path or acceptance assertion changed in 0.71.1. Its fresh Ubuntu
rerun is recorded below; 0.71.0 did not pass its actual create gate.

The 0.71.1 Ubuntu rerun `41742511683` passed preparation and reported the
`preexisting-candidate` checkpoint. The fixture's readiness probe classified
the complete raw admin snapshot, whose additional identity and exact timestamp
fields violate the registry oracle's exact root shape. Version 0.71.2 classifies
only the explicit `control`, `history`, and `dispatch` projection for both
database roles; the full verifier snapshot still enters attestor validation.
Finite substeps now distinguish the preexisting candidate's real SDK creation,
engine readback, readiness/grant probe, owner denial, and retained evidence.
This correction first had local regression proof; its later Ubuntu runtime
acceptance is recorded below.

Full Ubuntu run `41745057024` at `ff7e83c` passed all ten jobs, including both
UID pairs of the disposable create-apply gate. Astra accepted only the fixed
create-through-`uuid_bound` runtime prerequisite; publication and serving gates
remain false. Version 0.72.0 starts a separately reviewed pure writer-role
contract with no network request or database transition.

Later writer-role work remains separate from the accepted create gate. The
0.75.0 offline binding regression was accepted after one unchanged browser-job
rerun; the 0.76.0 read-contract regression passed all ten Ubuntu jobs. Version
0.77.0 added a source-reviewed fixed read-only preparation owner. Version
0.78.0 adds four disposable preparation runtime jobs with an unmodified owner
control, forwarded-SDK read counts, exact original O/N/U and create evidence,
reached faults, terminal resource checks, and post-teardown private-log scans.
Those new runtime jobs have not run or been accepted yet. No role send, CAS,
mapping, principal, publication, or readiness authority follows from this
source change.

The first 0.78.0 Ubuntu run failed its four new writer-preparation jobs at
`precreate-baseline` after bootstrap; the exact cause is under separate review.
Version 0.79.0 adds an uncalled one-shot writer-role SDK sender based on the
accepted 0.73.1 actual first-create response measurement. It binds one
constructor-issued role contract before admin TLS file reads, uses one bounded
original SDK PUT, and rejects replacement or uncertain results without a
confirming GET. It has no owner, consumer, CAS or live invocation, and the
failed 0.78 preparation gate remains a separate acceptance step.

Version 0.79.1 narrows only the disposable first-baseline diagnostic after
the first actual four writer-preparation jobs all failed at the broad
`precreate-baseline` label. The label now preserves finite substeps for the
registry row and microtimestamp queries, engine open/observe, E0b/admin/source
files, host resource inspection and final disabled-stage/profile assertions.
No data or error text is forwarded, no baseline assertion or runtime cap is
relaxed, and the next Ubuntu result is required to identify the cause.

That rerun localized all four failures to the PostgreSQL host-inspection
substep. The fixture requested the full container inspection, including a
password in `Config.Env`, which its unchanged secret-output check rejected.
Version 0.79.2 requests only ID, creation time and admin-network IP at each
of the four PostgreSQL probes. Source and local tests pass independently of
the pending Ubuntu preparation gate; no runtime acceptance is claimed.

Version 0.80.0 adds an uncalled offline writer-role transfer and copied-input
reader. They copy only the fixed sealed role/create files, transition password
and prior public PEM inventory into a private UID-1000 volume, then enforce
canonical bytes, distinct IDs, fixed file identity and real certificate
digests. The copied reader retains original inodes for later rechecks; it
does not establish a current approved caller, live U or send authority.
The 0.79.2 preparation runtime gate remains a separate pending acceptance.

The next actual preparation run passed both isolated terminal variants but
failed on the first registry-drift restoration in the default and runner
variants. The migration 0018 immutable guard rejects the fixture's reverse
revision update. Version 0.80.1 uses three fixed, transaction-local test-only
trigger suspensions for the revision, candidate UUID and original create
dispatch-owner drift pairs. Exact full registry rows, six-digit timestamps and
all named guard states are checked before and after each transaction; rollback
faults are tested against a local disposable PostgreSQL server. This does not
modify the production guard or establish Ubuntu runtime acceptance.

Version 0.81.0 adds an uncalled fixed writer-role orchestration core. An
independent approved tuple, invocation and host capture remain fixed across
all awaits; the existing copied-evidence validator and pure role assessor
guard the original create, complete prior inventory and seven finite stages.
Five scripted CAS successors and one original sender response are required
before a final never-ready result. The next separately reviewed database
adapter must prove short transaction provenance and exact microtimestamp
capture; this core adds no runnable consumer or actual role delivery.

Version 0.82.0 adds that fixed writer-role CAS adapter without connecting a
consumer. The public admin readers still create read-only repeatable-read
transactions; a narrow extracted query body also runs inside the adapter's
pre-established bounded write transaction and control-row lock. All five
writer transitions compare complete predecessor and successor rows and exact
microsecond sidecars before commit. A local disposable migrated PostgreSQL
fixture verifies restricted-role grants, rollback and one-winner concurrency.
Actual preparation and role-delivery gates still require Ubuntu evidence.

Version 0.82.1 changes only the terminal runner network fixture's two return
keys to match its existing evidence assertion. The prior Ubuntu run reached
that assertion and failed; the corrected gate has not yet passed. All network
mutation, original identity and teardown checks remain unchanged.

Version 0.83.0 adds the fixed private writer-role consumer wrapper, without a
Compose or host invocation. Thirteen nonsecret authority fields are captured
synchronously; the copied password and admin TLS identity remain file inputs.
The core now compares the repeated actual registry snapshot identity with the
independently expected restricted PostgreSQL role, database, owner and OID.
The project and system identifier remain trusted owner declarations checked
against the seal, not synthetic in-container host observations. Local tests
cover the fixed CAS/sender wiring and real copied public-certificate reader.
Actual preparation and role-delivery runtime acceptance remain separate.

Version 0.84.0 adds only the fixed writer-role transfer CLI, opt-in Compose
overlay and exact render/effective-container policy checks. The base consumer
has no approval arguments and fails before I/O if run as rendered. A later
owner must supply and inspect the independently approved thirteen-field
override, original input volume and host identities. Daemon-free both-UID
render checks do not establish Docker execution or role delivery.

Version 0.85.0 adds only the finite writer-role lock phases for a later owner.
Offline binding continues to retain the lock. Same-call delivery releases it
only after transfer, apply and owned cleanup are durably confirmed and the
callback returns normally. Append/fsync attempts, callback failure after
cleanup and uncertain release remain fail-closed in local filesystem tests.
No owner adapter or role-delivery runtime gate is connected.

Version 0.86.0 adds only the injected writer-role owner core. It checks the
approved pending and original-create evidence, stages prior public PEMs,
passes one fixed command to transfer and apply, and requires a callback fence
immediately before each eventual container start. Exact phase results and
owned cleanup precede normal lock release. Local real-file legacy/v2 and
fault fixtures pass; production Docker execution, CLI and Ubuntu delivery
review remain separate.

The read-only writer-role preparation gate passed full run `41783923770` at
`430437302e3f6c0fe0e65d3ddee4ffb4e902c760` with fourteen successful jobs;
Astra accepted its bounded both-UID runtime evidence and checked teardown.
This does not accept role delivery.

Version 0.87.0 adds the fixed owner CLI and Docker adapter. A private
command-only Compose override is verified by original inode and bytes. The
adapter creates each stopped container, inspects its effective policy,
calls the owner's pre-start fence, then starts only the captured full ID.
Scripted and both-UID daemon-free merged-render checks pass. Actual
created-state fields and writer-role delivery await the Ubuntu runtime gate;
both search readiness gates remain false.

Version 0.87.1 fixes only the shared attestor lock fixture's publication race.
The child now writes and syncs a temporary signal before atomic rename;
the parent fixture reaches an empty temporary and proves the final signal
is absent until publication. The 0.86.0 Ubuntu run `41788671990` at
`fd0cad933386a7a231c1b93f27150a4f3b67b591` failed at the old signal
read, blocking downstream regression jobs. Product lock and sender code are
unchanged; the actual role-delivery gate is not yet implemented.

Version 0.87.2 adds finite checkpoints to the disposable admin-DB container
fixture and forwards only one exact validated diagnostic line from its private
log when that fixture fails. The older 0.85.0 admin-DB failure in run
`41787266265` has no identified cause; 0.87.0 run `41791235160` passed its
admin-DB and scaffold jobs while the overall workflow remained in progress.
This diagnostic slice changes no product path or runtime acceptance status.
