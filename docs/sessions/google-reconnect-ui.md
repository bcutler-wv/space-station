# Explicit Google reconnect UI

Account cards offer reconnect for connected and reconnect-needed accounts. The guided form names the target mailbox, keeps only its nonsecret ID in the URL, clears client secrets after attempts and browser-history restoration, and submits the reviewed reconnect endpoint. The session-bound continuation metadata identifies the pending target without exposing OAuth state or codes.

Astra review found that query invalidation cleared the pending target before success copy rendered. Confirmation now captures the chosen operation on the explicit button click. Regression fixtures clear pending status after success and verify both ordinary connection and reconnect messages. Full local checks pass with 32 units and five focused browser tests; Astra independently reran both new success regressions. Root inspected light desktop/dark mobile screenshots.

The HTTPS fixture checks wrong-mailbox rejection, preserved account ID/Orbit/backfill, successful reconnect, and replay. It remains pending Ubuntu CI. Backend run `39474165355` passed scaffold/startup but stopped at the unchanged mixed parser capacity gate before the new credential database fixture. A separate reviewed capacity fix will precede the next full CI run. No mail sync is claimed.
