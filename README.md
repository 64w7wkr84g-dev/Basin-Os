# Basin OS GitHub Package

This folder contains the files you need in your GitHub repository.

## Files

- `index.html` — the full Basin OS app for GitHub Pages.
- `server.js` — optional local Brave Search proxy. Needed because Brave Search is usually blocked by browser CORS from GitHub Pages.
- `package.json` — Node setup for the local proxy.
- `.gitignore` — keeps `.env` and `node_modules` out of GitHub.
- `.env.example` — safe example file. Do not put real keys in GitHub.

## GitHub Pages

For the public GitHub Pages site, GitHub mainly needs:

```text
index.html
```

Upload the rest too if you want the repo to stay complete, but GitHub Pages will not run `server.js`.

## Running Brave Search locally

1. Install Node.js 18 or newer.
2. Open Terminal in this folder.
3. Run:

```bash
npm install
```

4. Copy `.env.example` to `.env` and paste your Brave API key:

```bash
cp .env.example .env
```

5. Start the local proxy:

```bash
npm start
```

6. Open:

```text
http://localhost:8787/index.html
```

The app is also patched to try the local proxy at:

```text
http://localhost:8787/api/brave/web/search
http://localhost:8787/api/brave/news/search
```

Groq can run from GitHub Pages. Brave needs the local proxy for reliable browser use.

## Do not commit secrets

Never upload `.env` or API keys to GitHub, especially if the repo is public.
