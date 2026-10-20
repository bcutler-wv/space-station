# Ingestion HTML sanitation

M1.3b adds DOMPurify 3.4.17 with jsdom 30.1.3 inside the isolated MIME child. Shared versioned policy preserves basic text, tables and validated links. It removes active content and CSS, replaces images with inert placeholders, and keeps image references in bounded untrusted metadata. The child no longer returns raw HTML bodies. Nothing is persisted or displayed yet.

HTML input is limited to 512 KiB, sanitized output to 1 MiB, images to 64, and URLs to 2,048 characters. Later sync must show visible unsupported records for rejected mail. The later reader must re-sanitize and reconstruct only metadata-validated image references; image loading still requires explicit user action and separate proxy/SSRF validation.

Astra review found a mismatch between jsdom engines and the advertised Node minimum, plus missing regression coverage. Both are fixed: supported local runtime is Node 22.23.2 or newer within Node 22, matching the tested Docker/CI line. Package metadata, startup guard and documentation agree. This narrows the previous advertised runtime range. Fixtures now cover malformed namespace/mutation markup, serialization, active content, tracking, image-reference forgery, no automatic network requests, and size/count/output bounds.

Local full checks and parser/sanitizer fixtures pass. Astra independently ran revised sanitation and Node-version fixtures and accepted integration. The new Ubuntu gate must still validate two concurrent large attachments with HTML sanitation under cgroups, including recovery and no OOM/restart. Earlier parser-only CI run `39466415976` passed on `fcb06c4`; it does not prove the new DOM workload. Mail sync and safe reading remain subsequent work.
