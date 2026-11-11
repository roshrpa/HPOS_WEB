const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');
function createWindow() {
  const win = new BrowserWindow({
    width: 1366, height: 820, backgroundColor: '#ffffff', title: 'Hollywood POS',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'));
}
const lock = app.requestSingleInstanceLock();
if (!lock) { app.quit(); } else {
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
