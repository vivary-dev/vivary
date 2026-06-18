# Self-hosted fonts

Latin variable-weight `woff2` subsets, self-hosted so the landing page makes **no
third-party (Google Fonts) request**. Each file covers its full used weight range.

| File | Family | Weights | License |
|---|---|---|---|
| `bricolage-grotesque-latin.woff2` | Bricolage Grotesque | 400–800 | [OFL 1.1](https://github.com/ateliertriay/bricolage) |
| `hanken-grotesk-latin.woff2` | Hanken Grotesk | 400–600 | [OFL 1.1](https://github.com/marcologous/hanken-grotesk) |
| `jetbrains-mono-latin.woff2` | JetBrains Mono | 400–500 | [OFL 1.1](https://github.com/JetBrains/JetBrainsMono) |

All three are licensed under the SIL Open Font License 1.1, which permits
bundling and redistribution. Subsets pulled from Google Fonts (latin
`unicode-range`). Declared via `@font-face` in `src/pages/index.astro`.
