# Hollywood POS - Windows counter app

Counter billing only: **Sale, Sales list, Credit, Cash & report, Settings, Users**.
Purchases, stock, expenses, dashboard, reports, menu editing and audit stay in the web portal (repo root `index.html`).

The desktop app is built from the same `index.html`; `scripts/prepare.js` copies it into `app/` with the desktop flag on, so there is no second code base to keep in step.

## Build the Windows installer
GitHub -> Actions -> **Build Windows app** -> Run workflow. The installer (`Hollywood POS Setup x.y.z.exe`) is attached to the run as an artifact.

## Run on a developer machine
```
cd desktop
npm install
npm start
```

## Notes
- Data is saved on this computer first, so billing works without internet. Connect the server later in Settings -> Sync.
- Add `icon.ico` (256x256) to this folder before building if you want a custom icon; without it, remove the `icon` line in package.json.
