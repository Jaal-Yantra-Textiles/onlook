# withlook website

Single-page marketing site — no build step, no dependencies.

## Preview

```bash
npx serve website        # or: open website/index.html
```

## Deploy

The whole site is `website/index.html` (self-contained: inline CSS, inline SVG favicon, no external assets). Put it anywhere:

- **GitHub Pages** — push the repo, Settings → Pages → deploy from branch, set the folder to `/website` (or copy `index.html` to the repo root / `docs/`).
- **Netlify** — drag the `website/` folder onto app.netlify.com, or `netlify deploy --dir website`.
- **Vercel** — `vercel deploy website --prod`.
- **Cloudflare Pages** — create a project, upload `website/` as the output directory (framework: none).

## Screenshots

```bash
npx electron marketing/screenshot.js
```

Writes `marketing/hero.png` (1440×900 viewport, 2x) and `marketing/full.png` (full page).
