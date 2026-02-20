const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const bot = require('../bot');

const BASE_PATH = app.isPackaged
  ? app.getPath('userData')
  : process.cwd();

const CONFIG_FILE = path.join(BASE_PATH, 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    autoHideMenuBar: true,
    backgroundColor: '#0f0f13',
    webPreferences: {
      contextIsolation: true
    }
  });

  const config = loadConfig();

  const port = config?.port || 3000;

  if (!config || !config.setupCompleted) {
    // Setup UI tulee Expressin kautta
    win.loadURL(`http://127.0.0.1:${port}/setup.html`);
  } else {
    // Admin UI
    win.loadURL(`http://127.0.0.1:${port}/admin`);
    bot.startBot();

  }

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  // 🔑 Express + WebSocket AINA
  bot.startServer().then(() => {
    createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
