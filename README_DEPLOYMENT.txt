Basin Ventures Lead Generation System v2.0
=========================================

FILES IN THIS PACKAGE
- index.html       Main working app. All buttons, sections, pipelines, notes, scoring, exports, templates, and API connection panels are functional.
- server.js        Local Node proxy for Tavily and AI APIs. Required for live API connections because browsers block most direct API calls by CORS.
- package.json     Node dependency file.

FAST LOCAL START
1. Install Node.js 18+ from nodejs.org.
2. Put index.html, server.js, and package.json in the same folder.
3. Open Terminal / Command Prompt in that folder.
4. Run:
   npm install
5. Run:
   node server.js
6. Open this URL in Chrome/Safari/Edge:
   http://localhost:3000

PHONE TESTING ON SAME WI-FI
1. Run node server.js on your computer.
2. Find your computer's local IP address.
3. On your phone's browser, open:
   http://YOUR-COMPUTER-IP:3000

IMPORTANT
- Do not judge the app by tapping index.html inside iPhone Files, Google Drive preview, Dropbox preview, iCloud preview, or ZIP preview. Those can show a static preview where JavaScript buttons do not run.
- The app UI works without API keys using built-in lead templates and scoring.
- Tavily live search and AI-generated personalization require the local server and valid API keys pasted into the sidebar.
- Data is stored in the browser's localStorage. Use Export All Data before clearing browser data or switching devices.

WHAT WAS FIXED
- Restored functional navigation and page switching.
- Added all missing functions used by buttons.
- Fixed broken CSS variable characters from copy/paste corruption.
- Added full investor scoring, CPA scoring, lead finder, CPA finder, sequence builder, call coach, notes, export, dedupe, and pipeline status logic.
- Added a working local API proxy server for Tavily and multiple AI providers.
