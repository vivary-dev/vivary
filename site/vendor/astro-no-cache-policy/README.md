# Astro remote-image freshness policy

This private, independently written module replaces Astro 7.3.5's use of
`http-cache-semantics`. GHSA-ch52-4w7c-c8xp affects upstream releases through
4.2.0, and no patched release was available on 2026-10-03. Astro 7.3.5 still
declares that affected dependency, so upgrading Astro alone does not repair it.

The site's direct local dependency supplies the import name Astro expects.
The Astro-only npm override references that same dependency with
`$http-cache-semantics`. npm resolves it to this directory, whose package
identity is `@vivary/astro-no-cache-policy`. No upstream source is copied or
patched, and no advisory is suppressed.

Astro's `dist/assets/build/remote.js` constructs a policy and calls only
`storable()` and `timeToLive()`. This implementation always returns false and
zero. Newly fetched or revalidated remote images receive zero freshness.
It does not parse cache directives or decide whether another user's response
can be reused. It is deliberately not a general HTTP cache implementation.

Astro still stores image bytes and validators, can reuse older entries whose
expiration is in the future, and can serve stale image bytes after a failed
revalidation. This change does not remove those separate Astro behaviors.
Builds using optimized remote images may make more origin requests. The current
site uses local optimized assets.

Astro is pinned to 7.3.5 because compatibility depends on its narrow caller.
Before changing that pin, inspect every import of `http-cache-semantics` in
Astro and run `npm ci`, `npm run test:site`, the live audit, build, and link
check. The integration tests execute Astro's real remote helpers with injected
responses. Missing future methods should fail visibly.

Remove this replacement only after a reviewed upstream fix removes or repairs
the dependency and passes the same checks. Keep the ordinary npm audit gate.
