Basin OS v3.8.19 — Named Contact Gate + Contactable Lead Workflow

Upload/replace:
- index.html -> repo root
- basin-radar-runner.js -> repo root
- .github/workflows/radar.yml -> exact workflow path

Then run:
GitHub -> Actions -> Basin Radar Daily -> Run workflow

Required GitHub secrets:
- TAVILY_API_KEY
- GROQ_API_KEY

This build only loads a signal as a lead if it has a named point person and at least one usable contact route.
Article titles, team pages, company-only announcements, and generic pages are rejected into radar-rejected.json for weekly recheck.
