const fs = require('fs');

const DEFAULT_SESSION = {
  active: false,
  playerId: '',
  nickname: '',
  startElo: 0,
  currentElo: 0,
  eloChange: 0,
  wins: 0,
  losses: 0,
  streak: 0,
  lastMatchId: '',
  matches: []
};

class FaceitService {
  constructor({ sessionFile, onUpdate, onError, getApiKey }) {
    this.sessionFile = sessionFile;
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
    this.onError = typeof onError === 'function' ? onError : () => {};
    this.getApiKey = typeof getApiKey === 'function' ? getApiKey : () => process.env.FACEIT_API_KEY || '';
    this.session = this.loadSession();
    this.pollTimer = null;
    this.pollInProgress = false;
  }

  loadSession() {
    try {
      if (!fs.existsSync(this.sessionFile)) {
        fs.writeFileSync(this.sessionFile, JSON.stringify(DEFAULT_SESSION, null, 2));
        return { ...DEFAULT_SESSION };
      }

      const parsed = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      return {
        ...DEFAULT_SESSION,
        ...parsed,
        matches: Array.isArray(parsed.matches) ? parsed.matches : []
      };
    } catch (error) {
      this.onError('FACEIT session read failed', error);
      return { ...DEFAULT_SESSION };
    }
  }

  persistSession() {
    fs.writeFileSync(this.sessionFile, JSON.stringify(this.session, null, 2));
  }

  emitUpdate() {
    this.onUpdate(this.getOverlayData());
  }

  getOverlayData() {
    return {
      currentElo: this.session.currentElo,
      eloChange: this.session.eloChange,
      wins: this.session.wins,
      losses: this.session.losses,
      streak: this.session.streak,
      active: this.session.active,
      nickname: this.session.nickname
    };
  }

  getSession() {
    return { ...this.session, matches: [...this.session.matches] };
  }

  getApiHeaders() {
    const apiKey = String(this.getApiKey() || '').trim();

    if (!apiKey) {
      throw new Error('FACEIT API key missing in FACEIT_API_KEY environment variable');
    }

    return {
      Authorization: `Bearer ${apiKey}`
    };
  }

  async faceitGet(url) {
    const headers = this.getApiHeaders();
    const response = await fetch(url, { headers });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FACEIT API ${response.status}: ${text || response.statusText}`);
    }

    return response.json();
  }

  async fetchPlayerByNickname(nickname) {
    const encoded = encodeURIComponent(nickname);
    return this.faceitGet(`https://open.faceit.com/data/v4/players?nickname=${encoded}`);
  }

  async fetchPlayerById(playerId) {
    return this.faceitGet(`https://open.faceit.com/data/v4/players/${encodeURIComponent(playerId)}`);
  }

  async fetchPlayerHistory(playerId, limit = 20) {
    return this.faceitGet(
      `https://open.faceit.com/data/v4/players/${encodeURIComponent(playerId)}/history?game=cs2&limit=${limit}`
    );
  }

  getCs2Elo(playerData) {
    return Number(playerData?.games?.cs2?.faceit_elo || 0);
  }

  detectMatchWin(historyItem) {
    const playerFaction = historyItem?.results?.player;
    const winnerFaction = historyItem?.results?.winner;

    if (playerFaction && winnerFaction) {
      return playerFaction === winnerFaction;
    }

    const winnerTeamId = historyItem?.results?.winner;
    const playerTeamId = historyItem?.teams?.faction1?.players?.find(
      p => p.player_id === this.session.playerId
    )
      ? historyItem?.teams?.faction1?.team_id
      : historyItem?.teams?.faction2?.players?.find(p => p.player_id === this.session.playerId)
        ? historyItem?.teams?.faction2?.team_id
        : null;

    if (winnerTeamId && playerTeamId) {
      return winnerTeamId === playerTeamId;
    }

    return null;
  }

  applyMatchResult(isWin) {
    if (isWin === true) {
      this.session.wins += 1;
      this.session.streak = this.session.streak >= 0 ? this.session.streak + 1 : 1;
      return;
    }

    if (isWin === false) {
      this.session.losses += 1;
      this.session.streak = this.session.streak <= 0 ? this.session.streak - 1 : -1;
    }
  }

  setCurrentElo(elo) {
    this.session.currentElo = Number(elo) || 0;
    this.session.eloChange = this.session.currentElo - this.session.startElo;
  }

  async startSession(nickname) {
    const cleanNickname = String(nickname || '').trim();
    if (!cleanNickname) {
      throw new Error('FACEIT nickname missing');
    }

    const player = await this.fetchPlayerByNickname(cleanNickname);
    const playerId = player?.player_id;
    if (!playerId) {
      throw new Error(`FACEIT player not found: ${cleanNickname}`);
    }

    const [playerDetails, history] = await Promise.all([
      this.fetchPlayerById(playerId),
      this.fetchPlayerHistory(playerId, 20)
    ]);

    const currentElo = this.getCs2Elo(playerDetails);
    const latestMatchId = history?.items?.[0]?.match_id || '';

    this.session = {
      ...DEFAULT_SESSION,
      active: true,
      playerId,
      nickname: playerDetails?.nickname || cleanNickname,
      startElo: currentElo,
      currentElo,
      eloChange: 0,
      lastMatchId: latestMatchId,
      matches: latestMatchId ? [latestMatchId] : []
    };

    this.persistSession();
    this.emitUpdate();
  }

  stopSession() {
    this.session.active = false;
    this.persistSession();
    this.emitUpdate();
  }

  resetSession() {
    this.session = { ...DEFAULT_SESSION };
    this.persistSession();
    this.emitUpdate();
  }

  async pollOnce() {
    if (!this.session.active || !this.session.playerId || this.pollInProgress) {
      return;
    }

    this.pollInProgress = true;

    try {
      const [playerDetails, history] = await Promise.all([
        this.fetchPlayerById(this.session.playerId),
        this.fetchPlayerHistory(this.session.playerId, 20)
      ]);

      this.setCurrentElo(this.getCs2Elo(playerDetails));

      const historyItems = Array.isArray(history?.items) ? history.items : [];
      const knownMatchIds = new Set(this.session.matches);
      const newItems = historyItems.filter(item => {
        const matchId = item?.match_id;
        return matchId && !knownMatchIds.has(matchId);
      });

      if (newItems.length) {
        const sortedNewItems = [...newItems].reverse();

        sortedNewItems.forEach(item => {
          const matchId = item.match_id;
          this.session.matches.push(matchId);

          const isWin = this.detectMatchWin(item);
          this.applyMatchResult(isWin);
          this.session.lastMatchId = matchId;
        });

        this.session.matches = this.session.matches.slice(-100);
      }

      this.persistSession();
      this.emitUpdate();
    } catch (error) {
      this.onError('FACEIT poll failed', error);
    } finally {
      this.pollInProgress = false;
    }
  }

  startPolling(intervalMs = 60000) {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.pollOnce();
    }, intervalMs);

    this.pollOnce();
  }

  stopPolling() {
    if (!this.pollTimer) return;

    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}

module.exports = {
  FaceitService,
  DEFAULT_SESSION
};
