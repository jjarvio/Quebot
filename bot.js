const fs = require('fs');
const path = require('path');
const express = require('express');
const WebSocket = require('ws');
const tmi = require('tmi.js');
const { app } = require('electron');
const { FaceitService } = require('./faceit');

/* ========= POLUT (DEV + PACKAGED) ========= */

const BASE_PATH = app.isPackaged
  ? app.getPath('userData')
  : process.cwd();

const CONFIG_FILE = path.join(BASE_PATH, 'config.json');
const DATA_FILE = path.join(BASE_PATH, 'queue-data.json');
const STATS_FILE = path.join(BASE_PATH, 'stats-data.json');
const LOOP_MESSAGES_FILE = path.join(BASE_PATH, 'loop-messages.json');
const CUSTOM_COMMANDS_FILE = path.join(BASE_PATH, 'custom-commands.json');
const FACEIT_SESSION_FILE = path.join(BASE_PATH, 'faceit-session.json');

/* ========= CONFIG ========= */

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      channel: '',
      port: 3000,
      setupCompleted: false
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ========= BOT TOKEN ========= */

function loadBotToken() {
  const devPath = path.join(process.cwd(), 'bot-token.txt');
  if (!app.isPackaged && fs.existsSync(devPath)) {
    return fs.readFileSync(devPath, 'utf8').trim();
  }

  const prodPath = path.join(process.resourcesPath, 'bot-token.txt');
  if (app.isPackaged && fs.existsSync(prodPath)) {
    return fs.readFileSync(prodPath, 'utf8').trim();
  }

  console.error('❌ bot-token.txt puuttuu');
  process.exit(1);
}

/* ========= RUNTIME STATE ========= */

let queue = [];
let current = null;
let stats = {};
let loopMessages = [];
let customCommands = [];
let twitchClient = null;
let wss = null;
let botChannel = null;
let loopScheduler = null;
let faceitService = null;

/* ========= DATA LOAD ========= */

function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    queue = d.queue || [];
    current = d.current || null;
  }

  if (fs.existsSync(STATS_FILE)) {
    stats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  }

  if (fs.existsSync(LOOP_MESSAGES_FILE)) {
    const data = JSON.parse(fs.readFileSync(LOOP_MESSAGES_FILE, 'utf8'));
    if (Array.isArray(data)) {
      loopMessages = data;
    }
  }

  if (fs.existsSync(CUSTOM_COMMANDS_FILE)) {
    const data = JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE, 'utf8'));
    if (Array.isArray(data)) {
      customCommands = data;
    }
  }
}

function saveQueue() {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ queue, current }, null, 2));
}

function saveStats() {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function saveLoopMessages() {
  fs.writeFileSync(LOOP_MESSAGES_FILE, JSON.stringify(loopMessages, null, 2));
}

function saveCustomCommands() {
  fs.writeFileSync(CUSTOM_COMMANDS_FILE, JSON.stringify(customCommands, null, 2));
}

function getLoopMessagesForAdmin() {
  const now = Date.now();

  return loopMessages.map(item => {
    const intervalMs = item.intervalMinutes * 60 * 1000;
    const sentAt = item.lastSentAt || now;
    const nextSendInMs = Math.max(0, intervalMs - (now - sentAt));

    return {
      id: item.id,
      message: item.message,
      intervalMinutes: item.intervalMinutes,
      enabled: item.enabled,
      nextSendInSeconds: Math.ceil(nextSendInMs / 1000)
    };
  });
}

function getCustomCommandsForAdmin() {
  return customCommands.map(item => ({
    id: item.id,
    name: item.name,
    response: item.response
  }));
}

function getAdminSettings() {
  const cfg = loadConfig();
  return {
    channel: cfg.channel || '',
    setupCompleted: Boolean(cfg.setupCompleted),
    botConnected: Boolean(twitchClient)
  };
}

function getFaceitOverlayData() {
  if (!faceitService) {
    return {
      currentElo: 0,
      eloChange: 0,
      wins: 0,
      losses: 0,
      streak: 0
    };
  }

  return faceitService.getOverlayData();
}


function runLoopMessages() {
  if (!twitchClient || !botChannel) return;

  const now = Date.now();
  let changed = false;

  loopMessages.forEach(item => {
    if (!item.enabled) return;

    const intervalMs = item.intervalMinutes * 60 * 1000;
    const lastSentAt = item.lastSentAt || 0;

    if (now - lastSentAt >= intervalMs) {
      twitchClient.say(botChannel, item.message);
      item.lastSentAt = now;
      changed = true;
    }
  });

  if (changed) {
    saveLoopMessages();
    broadcast();
  }
}

function startLoopScheduler() {
  if (loopScheduler) return;
  loopScheduler = setInterval(runLoopMessages, 5000);
}

/* ========= BROADCAST ========= */

function broadcast() {
  saveQueue();

  if (!wss) return;

  const payload = JSON.stringify({
    current,
    next: queue[0] || null,
    queue,
    loopMessages: getLoopMessagesForAdmin(),
    customCommands: getCustomCommandsForAdmin(),
    settings: getAdminSettings(),
    faceit: getFaceitOverlayData()
  });

  const faceitPayload = JSON.stringify({
    type: 'faceitUpdate',
    data: getFaceitOverlayData()
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
      client.send(faceitPayload);
    }
  });
}

/* ========= EXPRESS + WS ========= */

function startServer() {
  loadData();
  startLoopScheduler();

  if (!faceitService) {
    faceitService = new FaceitService({
      sessionFile: FACEIT_SESSION_FILE,
      onUpdate: () => broadcast()
    });
    faceitService.loadSession();
    faceitService.startPolling();
  }

  const config = loadConfig();
  const appExpress = express();

  const overlayPath = app.isPackaged
    ? path.join(process.resourcesPath, 'overlay')
    : path.join(__dirname, 'overlay');

  console.log('🖼 Overlay-polku:', overlayPath);
  console.log('💾 Data-polku:', BASE_PATH);

  appExpress.use(express.json());

  appExpress.use((req, res, next) => {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }
    next();
  });

  appExpress.use(express.static(overlayPath, {
    etag: false,
    lastModified: false
  }));

  appExpress.get('/admin', (req, res) => {
    res.sendFile(path.join(overlayPath, 'admin.html'));
  });

  appExpress.get('/setup.html', (req, res) => {
    res.sendFile(path.join(overlayPath, 'setup.html'));
  });

  appExpress.post('/setup/save', (req, res) => {
    const channel = String(req.body.channel || '').trim().toLowerCase();

    if (!channel) {
      return res.status(400).send('Channel missing');
    }

    const cfg = loadConfig();
    cfg.channel = channel;
    cfg.setupCompleted = true;
    saveConfig(cfg);

    console.log('✅ Setup tallennettu:', channel);
    res.sendStatus(200);
  });

  let serverReadyResolve;
  const serverReady = new Promise(resolve => {
    serverReadyResolve = resolve;
  });

  const server = appExpress.listen(config.port, () => {
    console.log(`🌐 http://localhost:${config.port}`);
    serverReadyResolve();
  });

  wss = new WebSocket.Server({ server });

  wss.on('connection', ws => {
    broadcast();

    ws.on('message', msg => {
      try {
        const data = JSON.parse(msg);

        if (data.action === 'next') {
          current = queue.shift() || null;
        }

        if (data.action === 'clear') {
          queue = [];
          current = null;
        }

        if (data.action === 'remove' && data.payload) {
          queue = queue.filter(n => n !== data.payload);
        }

        if (data.action === 'result' && current) {
          const { legsFor, legsAgainst, avg } = data.payload || {};

          if (
            typeof legsFor !== 'number' ||
            typeof legsAgainst !== 'number' ||
            typeof avg !== 'number'
          ) return;

          stats[current] ??= {
            games: 0,
            wins: 0,
            losses: 0,
            legsFor: 0,
            legsAgainst: 0,
            avgSum: 0
          };

          stats[current].games++;
          stats[current].legsFor += legsFor;
          stats[current].legsAgainst += legsAgainst;
          stats[current].avgSum += avg;

          if (legsFor > legsAgainst) stats[current].wins++;
          else stats[current].losses++;

          saveStats();
          current = null;
        }

        if (data.action === 'loop_add') {
          const message = String(data.payload?.message || '').trim();
          const intervalMinutes = Number(data.payload?.intervalMinutes);

          if (!message || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return;

          loopMessages.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            message,
            intervalMinutes,
            enabled: true,
            lastSentAt: Date.now()
          });
          saveLoopMessages();
        }

        if (data.action === 'loop_update') {
          const id = String(data.payload?.id || '');
          const message = String(data.payload?.message || '').trim();
          const intervalMinutes = Number(data.payload?.intervalMinutes);

          if (!id || !message || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return;

          const target = loopMessages.find(item => item.id === id);
          if (!target) return;

          target.message = message;
          target.intervalMinutes = intervalMinutes;
          saveLoopMessages();
        }

        if (data.action === 'loop_toggle') {
          const id = String(data.payload?.id || '');
          const enabled = Boolean(data.payload?.enabled);
          const target = loopMessages.find(item => item.id === id);
          if (!target) return;

          target.enabled = enabled;
          target.lastSentAt = Date.now();
          saveLoopMessages();
        }

        if (data.action === 'loop_delete') {
          const id = String(data.payload || '');
          const before = loopMessages.length;
          loopMessages = loopMessages.filter(item => item.id !== id);
          if (loopMessages.length !== before) saveLoopMessages();
        }

        if (data.action === 'command_add') {
          const name = String(data.payload?.name || '').trim().toLowerCase();
          const response = String(data.payload?.response || '').trim();

          if (!name.startsWith('!') || !response) return;
          if (customCommands.some(item => item.name === name)) return;

          customCommands.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            response
          });
          saveCustomCommands();
        }

        if (data.action === 'command_update') {
          const id = String(data.payload?.id || '');
          const name = String(data.payload?.name || '').trim().toLowerCase();
          const response = String(data.payload?.response || '').trim();

          if (!id || !name.startsWith('!') || !response) return;
          const duplicate = customCommands.find(item => item.name === name && item.id !== id);
          if (duplicate) return;

          const target = customCommands.find(item => item.id === id);
          if (!target) return;

          target.name = name;
          target.response = response;
          saveCustomCommands();
        }

        if (data.action === 'command_delete') {
          const id = String(data.payload || '');
          const before = customCommands.length;
          customCommands = customCommands.filter(item => item.id !== id);
          if (customCommands.length !== before) saveCustomCommands();
        }

        if (data.action === 'settings_save') {
          const channel = String(data.payload?.channel || '').trim().toLowerCase();
          if (!channel) return;

          const cfg = loadConfig();
          const hasChanged = cfg.channel !== channel || !cfg.setupCompleted;
          cfg.channel = channel;
          cfg.setupCompleted = true;
          saveConfig(cfg);

          if (hasChanged) {
            stopBot();
            startBot();
          }
        }

        broadcast();
      } catch (err) {
        console.error('WebSocket-virhe:', err);
      }
    });
  });

  return serverReady;
}

/* ========= TWITCH BOT ========= */

function stopBot() {
  if (!twitchClient) return;

  try {
    twitchClient.disconnect();
  } catch (err) {
    console.error('⚠️ Botin irrotus epäonnistui:', err);
  }

  twitchClient = null;
  botChannel = null;
  broadcast();
}

function startBot() {
  const config = loadConfig();

  if (!config.setupCompleted || !config.channel) {
    console.log('⚠️ Setup ei valmis');
    return;
  }

  if (twitchClient) {
    console.log('ℹ️ Botti jo käynnissä');
    return;
  }

  const BOT_USERNAME = 'moikkabot';
  const OAUTH_TOKEN = loadBotToken();
  const CHANNEL = config.channel.toLowerCase();
  botChannel = `#${CHANNEL}`;

  twitchClient = new tmi.Client({
    identity: {
      username: BOT_USERNAME,
      password: OAUTH_TOKEN
    },
    channels: [CHANNEL]
  });

  twitchClient.connect();
  console.log('🤖 Botti yhdistetty kanavalle:', CHANNEL);

  twitchClient.on('connected', () => {
    broadcast();
  });

  twitchClient.on('disconnected', () => {
    twitchClient = null;
    botChannel = null;
    broadcast();
  });

  twitchClient.on('message', (channel, tags, message, self) => {
    if (self || !message.startsWith('!')) return;

    const normalizedMessage = message.trim().toLowerCase();
    const user = tags['display-name'];
    const isMod = tags.mod || tags.badges?.broadcaster;

    if (normalizedMessage === '!jonoon') {
      const queueIndex = queue.findIndex(name => name.toLowerCase() === user.toLowerCase());
      const isCurrentPlayer = current && current.toLowerCase() === user.toLowerCase();

      if (isCurrentPlayer) {
        twitchClient.say(channel, `@${user} olet jo pelivuorossa.`);
        return;
      }

      if (queueIndex !== -1) {
        twitchClient.say(channel, `@${user} olet jo jonossa sijalla ${queueIndex + 1}.`);
        return;
      }

      queue.push(user);
      const position = queue.length;
      twitchClient.say(channel, `@${user} liittyminen onnistui ✅ Olet jonossa sijalla ${position}.`);
      broadcast();
      return;
    }

    if (normalizedMessage === '!peru') {
      const queueIndex = queue.findIndex(name => name.toLowerCase() === user.toLowerCase());
      const isCurrentPlayer = current && current.toLowerCase() === user.toLowerCase();

      if (isCurrentPlayer) {
        twitchClient.say(channel, `@${user} olet jo pelivuorossa, et voi perua enää tästä kierroksesta.`);
        return;
      }

      if (queueIndex === -1) {
        twitchClient.say(channel, `@${user} et ole tällä hetkellä jonossa.`);
        return;
      }

      queue.splice(queueIndex, 1);
      twitchClient.say(channel, `@${user} osallistuminen peruttu. ❌`);
      broadcast();
      return;
    }

    if (normalizedMessage === '!jono') {
      if (!queue.length) {
        twitchClient.say(channel, '📋 Jono on tällä hetkellä tyhjä.');
        return;
      }

      const queueList = queue.map((name, index) => `${index + 1}. ${name}`).join(' | ');
      twitchClient.say(channel, `📋 Jono: ${queueList}`);
      return;
    }

    if (normalizedMessage === '!seuraava' && isMod) {
      current = queue.shift() || null;
      broadcast();
      return;
    }

    if (normalizedMessage === '!stats') {
      const d = stats[user];
      if (!d) return;

      const avg = (d.avgSum / d.games).toFixed(2);

      twitchClient.say(channel,
        `📊 ${user} | W/L ${d.wins}-${d.losses} | Legs ${d.legsFor}-${d.legsAgainst} | Avg ${avg}`
      );
      return;
    }

    if (normalizedMessage.startsWith('!faceit')) {
      const parts = normalizedMessage.split(/\s+/);
      const action = parts[1] || '';
      const targetNickname = parts[2] || config.channel;

      if (!faceitService) {
        twitchClient.say(channel, 'FACEIT-palvelu ei ole käytettävissä juuri nyt.');
        return;
      }

      if (!action) {
        twitchClient.say(channel, faceitService.getSessionSummary());
        return;
      }

      if (!isMod && action !== 'status') {
        twitchClient.say(channel, `@${user} vain moderaattori voi käyttää !faceit ${action} komentoa.`);
        return;
      }

      if (action === 'start') {
        faceitService.startSession(targetNickname)
          .then(session => {
            twitchClient.say(channel, `FACEIT-session aloitettu pelaajalle ${session.nickname}. Lähtö-ELO: ${session.startElo}`);
            return faceitService.pollOnce();
          })
          .catch(err => {
            twitchClient.say(channel, `FACEIT start epäonnistui: ${err.message}`);
          });
        return;
      }

      if (action === 'stop') {
        faceitService.stopSession();
        twitchClient.say(channel, 'FACEIT-session seuranta pysäytetty.');
        return;
      }

      if (action === 'reset') {
        faceitService.resetSession();
        twitchClient.say(channel, 'FACEIT-session tiedot nollattu.');
        return;
      }

      if (action === 'status') {
        twitchClient.say(channel, faceitService.getSessionSummary());
        return;
      }

      twitchClient.say(channel, 'Käyttö: !faceit start [nickname] | !faceit stop | !faceit reset | !faceit');
      return;
    }

    const customCommand = customCommands.find(item => item.name === normalizedMessage);
    if (customCommand) {
      twitchClient.say(channel, customCommand.response);
    }
  });
}

module.exports = {
  startServer,
  startBot,
  stopBot
};
