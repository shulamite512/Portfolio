# Portfolio (Astro 5 + Tailwind v4)

Simple one-page portfolio built with Astro and Tailwind. The site is static, fast, and content-driven from one JSON file.

## Stack

- Astro 5
- Tailwind CSS v4
- TypeScript
- GitHub Pages (GitHub Actions)
- OpenRouter (automated trend refresh)

## Architecture

- Page template: `src/pages/index.astro`
- Content source: `src/data/content.json`
- Styles: `src/styles/global.css`
- Trend updater: `scripts/update-trends.mjs`

All visible content is read from `content.json`.

## 11-File Policy

This repository is intentionally capped at 11 tracked project files.

Excluded from this cap:

- `node_modules/`
- `package-lock.json`
- `.astro/`
- `dist/`

Tracked project files:

1. `.github/workflows/deploy.yml`
2. `.env.example`
3. `.gitignore`
4. `README.md`
5. `astro.config.mjs`
6. `package.json`
7. `scripts/update-trends.mjs`
8. `src/data/content.json`
9. `src/pages/index.astro`
10. `src/styles/global.css`
11. `tsconfig.json`

## Local Development

Prerequisites:

- Node.js 20+
- npm

Run locally:

```bash
npm install
npm run dev
```

Build and preview:

```bash
npm run build
npm run preview
```

Run trend refresh locally:

```bash
npm run trends:update
node scripts/update-trends.mjs --mode=full_refresh
```

## Daily + Bi-Monthly Automation

The workflow supports three event types:

- `push` to `main`: build and deploy only
- `schedule` daily: `trends_only`
- `schedule` every 2 months (Jan/Mar/May/Jul/Sep/Nov): `full_refresh`
- `workflow_dispatch`: choose `trends_only` or `full_refresh`

Refresh behavior:

- `trends_only`: refresh trend cards using the currently locked model in `content.json`
- `full_refresh`: re-select model, update lock metadata, then refresh trend cards

Model constraints:

- open-source model families only
- paid endpoints only (`:free` excluded)
- input price <= `$1/M`
- output price <= `$5/M`

Trend + model updates are committed with structured commit body fields and then deployed by the same workflow run.

## Required Secrets / Variables

Set these in GitHub repository settings:

- Secret: `OPENROUTER_API_KEY`
- Optional variable: `OPENROUTER_HTTP_REFERER`

Local `.env` may include the same values for manual refresh.

## Content Contract (`src/data/content.json`)

Top-level keys:

- `site`
- `nav`
- `hero`
- `highlights`
- `trends`
- `skills`
- `projects`
- `contact`
- `footer`

`trends` shape:

- `id`
- `title`
- `description`
- `items[]` with `title`, `source`, `date`, `summary`, `image`, `url`
- `meta` with `model`, `modelLockedAt`, `pricing`, `lastModelRefreshMode`, `lastTrendRefreshAt`, `sourceFeeds[]`

## Formspree Setup

1. Create a form in Formspree.
2. Copy endpoint URL.
3. Set `PUBLIC_FORMSPREE_ENDPOINT` in local `.env`.

If the endpoint is missing, the UI shows fallback contact details.

## GitHub Pages Setup

1. Push to `main`.
2. In repository settings, set Pages source to **GitHub Actions**.
3. The workflow builds Astro and deploys `dist/`.

The project is configured as a project page with:

- `base: "/Portfolio/"`

If repo name changes, update `base` in `astro.config.mjs`.
