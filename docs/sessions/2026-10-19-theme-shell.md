# Theme and shell

Sol implemented the Mission Control and Orbit reference layouts with sample data, a CAPCOM preview, and persisted Appearance settings. Astra reviewed the change and required fixes for slow-request theme flashes, storage-denial handling, and keyboard interactions between Settings and CAPCOM. Those fixes passed re-review.

Material Color Utilities generates schemes and harmonized Orbit roles. Rubik and Material Symbols are served locally. Sharp validates and normalizes raster wallpapers into bounded WebP stored in the settings row; atomic field patches prevent concurrent appearance changes from overwriting uploads. The sample-data indicator remains visible in the shell.

Local checks passed: 19 unit tests and eight Playwright tests, including light/dark desktop, mobile/reduced motion, wallpaper lifecycle, delayed settings responses, denied local storage, and modal keyboard behavior. Screenshots were visually inspected in both themes and on mobile. The CI runtime job now runs the same browser suite against PostgreSQL; remote acceptance is required before the next task.

Material Color Utilities is pinned to 0.3.0 because 0.4.0 failed direct Node 22 ESM import. The icon font is large and remains a release-performance follow-up. Dependency source/license evidence is in THIRD_PARTY.md. Router/live transport choices are explicitly deferred to M1 and the embedding service to M6, when their integration requirements can be tested.

The appearance endpoints remain development-only until M0.4 adds authentication. There are no connected providers or production deployments.
