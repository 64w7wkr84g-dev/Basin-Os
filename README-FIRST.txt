BASIN OS - INSTALL / UPLOAD NOTES

For GitHub Pages:
1. Upload index.html to your repository root.
2. In GitHub: Settings > Pages > Deploy from branch > main > /root.
3. GitHub Pages will run the static app. Buttons, scoring, pipeline, notes, exports, call coach, and templates work.

For API connections:
GitHub Pages cannot run server.js. To use Tavily/AI API connections, run locally:
1. Install Node.js.
2. Put index.html, server.js, and package.json in the same folder.
3. Open Terminal in that folder.
4. Run: npm install
5. Run: npm start
6. Open http://localhost:3000

On iPhone:
If the HTML opens as Preview, download Basin-OS-complete.zip instead, unzip it, then upload the index.html file inside to GitHub.
