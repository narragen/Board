Vendored libraries served by the daemon at `GET /libs/<file>` (host port
:7800). Board scripts run in the app origin (D18) and load them
root-relative.

Filenames are version-stamped and immutable: a lib upgrade adds a new file and
never rewrites an existing one, so boards that cached an old build keep working
(the daemon serves them with `cache-control: public, max-age=31536000,
immutable`). Fetched from the npm registry tarball and pinned — never loaded
from a CDN at runtime (the app CSP's `connect-src 'self'` forbids it; see
docs/security.md).

- Chart.js v4.4.9 — UMD minified build (`dist/chart.umd.js` from
  https://registry.npmjs.org/chart.js/-/chart.js-4.4.9.tgz), served as
  `chart-4.4.9.umd.min.js`. MIT — see LICENSE.txt.

- Tailwind CSS v4.3.3 — the official in-browser build
  (`@tailwindcss/browser`, `dist/index.global.js` from
  https://registry.npmjs.org/@tailwindcss/browser/-/browser-4.3.3.tgz), served
  as `tailwind-4.3.3.browser.js`. 282 KB, self-contained: it compiles utility
  classes in the page and injects a `<style>`, which the host CSP's
  `style-src 'unsafe-inline'` permits, and it fetches nothing at runtime. MIT —
  see LICENSE.txt.

  Vendored for agent boards (D26): agents are trained on Tailwind and are not
  trained on Board's own class names, so utility classes are the shorter path
  to a good-looking board for most agents. Colors are the catch — Tailwind's
  palette assumes a white page and Board runs `color-scheme: light dark`, so
  boards take colors from Board's own tokens through Tailwind's
  arbitrary-value syntax (`bg-[var(--bg-subtle)]`). `skills/board/SKILL.md`
  carries that instruction.

