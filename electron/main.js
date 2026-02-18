const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const bot = require('../bot');

const CONFIG_FILE = path.join(process.cwd(), 'config.json');

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

  if (!config || !config.setupCompleted) {
    // Setup UI tulee Expressin kautta
    win.loadURL('http://127.0.0.1:3000/setup.html');
  } else {
    // Admin UI
    win.loadURL(`http://127.0.0.1:${config.port}/admin`);
    bot.startBot();

  }

  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  // 🔑 Express + WebSocket AINA
  bot.startServer();

  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});
