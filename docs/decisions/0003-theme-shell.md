# 0003: Theme and shell boundaries

## Context

M0.3 needs a themed, responsive Mission Control shell and private wallpaper settings before authentication and connector data exist. The reference uses an approximate color engine and shows actions that are not yet connected.

## Decision

Use the official Material Color Utilities 0.3.0 algorithms: QuantizerCelebi and Score extract a seed from a server-normalized raster thumbnail, SchemeTonalSpot generates light and dark roles, and Blend.harmonize shifts four fixed Orbit slots toward the seed. Paired on-color roles are generated for each Orbit container and checked at WCAG AA normal-text contrast across representative seeds. Version 0.4.0 was evaluated but its published ESM imports include extensionless relative paths and failed a direct import on Node 22.23.2. Version 0.3.0 imports under Node and bundles in Vite without modification.

The raw upload is restricted to PNG, JPEG, or WebP, 4 MB and 12 million input pixels. Sharp reencodes it as metadata-stripped WebP bounded to 1200 by 800 pixels and 750 KB. The encoded image stays in the existing `settings` JSONB row for this small milestone. The appearance API does atomic JSONB patches so mode changes cannot overwrite an uploaded wallpaper. Authentication must protect these endpoints in M0.4 before any production deployment.

TanStack Query manages appearance reads and writes. Navigation has only two local view types and no URL semantics yet, so React state handles Mission Control and Orbit switching. M1 must decide TanStack Router and SSE versus WebSocket before Mail deep links and live sync events are implemented. M6 must choose Hugging Face text-embeddings-inference versus Ollama (with optional OpenAI embeddings) before semantic search is implemented. These are explicit scoped deferrals from the former M0-wide evaluation rule, reflected in ARCHITECTURE and ROADMAP. Demo action buttons only change local sample state or explain that the action is unavailable. CAPCOM is explicitly a demo preview and cannot send requests to a provider.

## Consequences

The shell follows the reference frame, panel hierarchy, and mobile bottom bar while using locally served Rubik and Material Symbols assets. The icon font is about 5.4 MB before caching; subset or replace it before a public performance release. A private file store can replace the bounded database wallpaper when attachment storage is added. Until M0.4 authentication is complete, this API and shell must stay on disposable/local development hosts.
