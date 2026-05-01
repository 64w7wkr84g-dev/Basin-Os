# Basin OS

Static GitHub Pages operating system for Basin Ventures lead generation, playbook scripts, pipeline tracking, call notes, handoffs, and scheduled radar discovery.

## Files to upload

Place these in the root of the repo unless noted:

- `index.html`
- `basin-radar-runner.js`
- `package.json`
- `server.js`
- `.gitignore`
- `.env.example`
- `radar-leads.json`
- `data/radar-leads.json`
- `.github/workflows/radar.yml`

## GitHub secrets

Set these in GitHub repo Settings → Secrets and variables → Actions:

- `TAVILY_API_KEY` required for scheduled radar search
- `GROQ_API_KEY` optional for AI analysis of the top radar leads

Do not commit a real `.env` file.

## GitHub Actions automation

The workflow in `.github/workflows/radar.yml` runs every weekday morning and also supports manual runs through the Actions tab. It runs `node basin-radar-runner.js`, writes fresh leads to:

- `radar-leads.json`
- `data/radar-leads.json`

The app reads `data/radar-leads.json` when it loads.

## Local testing

Create a local `.env` file or export env variables:

```bash
export TAVILY_API_KEY=tvly-your-key
export GROQ_API_KEY=gsk-your-key
npm run radar
npm start
```

Then open `http://localhost:8787`.
