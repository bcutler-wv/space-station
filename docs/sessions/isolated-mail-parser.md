# Isolated MIME parser

M1.3a adds PostalMime 4.0.11 in a separate internal service. Each request uses a killable child process. The worker uses a fixed internal endpoint; the parser receives no application secrets, data mounts, or outbound network. Parsed HTML remains explicitly untrusted and has no persistence or rendering consumer yet.

The reviewed support limits are 12 MiB raw MIME, 8 MiB decoded attachments, 4 MiB combined body, 16 MiB output, two concurrent parses, and a three-second child deadline. Compose limits the service to 512 MiB, half a CPU, and 64 processes/threads. These concrete limits clarify the product contract: larger messages will need visible unsupported metadata when sync arrives. CPU quota does not replace the elapsed-time deadline.

Astra review found and resolved missing parser startup, repeated output copying, response cancellation, and insufficient lifecycle/resource-boundary coverage. Local lint, types, 27 unit tests, build, license/color checks, and process/HTTP fixtures pass. Astra independently reran revised fixtures and accepted integration. Ubuntu CI must still validate effective cgroups, network isolation, near-limit concurrent HTTP parsing, timeout recovery, and no OOM/restart before runtime acceptance.

Google authorization and its guided browser flow are accepted after run `39360383613` on `e13effa`. Root inspected the fake-data CI continuation/light and connected/mobile/dark screenshots. Mail sync remains pending; the next reviewed work adds ingestion sanitation and credential refresh before durable sync.

M1.3b later increased the child deadline to eight seconds, the whole-request limit to 8.5 seconds, and the client timeout to ten seconds. The unchanged two-child near-cap workload timed out at three seconds under the half-core Ubuntu gate in run `39470254199` after jsdom sanitation was added. The larger elapsed-time budget still requires a fresh cgroup gate; the 512 MiB, half-core, and two-child limits remain unchanged.
