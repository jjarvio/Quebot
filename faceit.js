const fs = require('fs');

const FACEIT_API_BASE = 'https://open.faceit.com/data/v4';

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
  constructor({ sessionFile, onUpdate }) {
    this.sessionFile = sessionFile;
    this.onUpdate = typeof onUpdate === 'function' ? onUpdate : () => {};
    this.session = { ...DEFAULT_SESSION };
    this.pollTimer = null;
    this.isPolling = false;
  }

  loadSession() {
    if (!fs.existsSync(this.sessionFile)) {
      this.saveSession();
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      this.session = {
        ...DEFAULT_SESSION,
        ...data,
        matches: Array.isArray(data.matches) ? data.matches : []
      };
    } catch (err) {
      console.error('⚠️ FACEIT session luku epäonnistui:', err);
      this.session = { ...DEFAULT_SESSION };
      this.saveSession();
    }
  }

  saveSession() {
    fs.writeFileSync(this.sessionFile, JSON.stringify(this.session, null, 2));
  }

  getApiKey() {
    return process.env.FACEIT_API_KEY || '';
  }

  async request(path) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('FACEIT_API_KEY puuttuu ympäristömuuttujista');
    }

    const response = await fetch(`${FACEIT_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`FACEIT API virhe ${response.status}: ${body}`);
    }

    return response.json();
  }

  async getPlayerByNickname(nickname) {
    return this.request(`/players?nickname=${encodeURIComponent(nickname)}`);
  }

  async getPlayerDetails(playerId) {
    return this.request(`/players/${encodeURIComponent(playerId)}`);
  }

  async getPlayerHistory(playerId, limit = 20) {
    return this.request(`/players/${encodeURIComponent(playerId)}/history?game=cs2&limit=${limit}`);
  }

  getCurrentEloFromPlayerData(playerData) {
    const segment = playerData?.games?.cs2;
    if (!segment || typeof segment.faceit_elo !== 'number') {
      throw new Error('FACEIT ELOa ei löytynyt pelaajan CS2-segmentistä');
    }

    return segment.faceit_elo;
  }

  determinePlayerFaction(match, playerId) {
    const factions = ['faction1', 'faction2'];

    for (const faction of factions) {
      const players = match?.teams?.[faction]?.players;
      if (!Array.isArray(players)) continue;
      if (players.some(player => player.player_id === playerId)) {
        return faction;
      }
    }

    return null;
  }

  determineMatchOutcome(match, playerId) {
    const winner = match?.results?.winner;
    const faction = this.determinePlayerFaction(match, playerId);

    if (!winner || !faction) {
      return null;
    }

    return winner === faction ? 'win' : 'loss';
  }

  getOverlayData() {
    const totalMatches = this.session.wins + this.session.losses;
    const winRate = totalMatches > 0
      ? Number(((this.session.wins / totalMatches) * 100).toFixed(1))
      : 0;

    return {
      active: this.session.active,
      nickname: this.session.nickname,
      currentElo: this.session.currentElo,
      startElo: this.session.startElo,
      eloChange: this.session.eloChange,
      wins: this.session.wins,
      losses: this.session.losses,
      streak: this.session.streak,
      winRate,
      totalMatches,
      recentMatches: this.session.matches.slice(-5).reverse()
    };
  }

  emitUpdate() {
    this.onUpdate(this.getOverlayData());
  }

  async startSession(nickname) {
    const player = await this.getPlayerByNickname(nickname);
    const playerId = player?.player_id;

    if (!playerId) {
      throw new Error(`Pelaajaa ei löytynyt nimellä: ${nickname}`);
    }

    const details = await this.getPlayerDetails(playerId);
    const history = await this.getPlayerHistory(playerId, 20);
    const currentElo = this.getCurrentEloFromPlayerData(details);
    const latestMatchId = Array.isArray(history?.items) && history.items[0]?.match_id
      ? history.items[0].match_id
      : '';

    this.session = {
      ...DEFAULT_SESSION,
      active: true,
      playerId,
      nickname: player.nickname || nickname,
      startElo: currentElo,
      currentElo,
      eloChange: 0,
      lastMatchId: latestMatchId,
      matches: []
    };

    this.saveSession();
    this.emitUpdate();

    return this.session;
  }

  stopSession() {
    this.session.active = false;
    this.saveSession();
    this.emitUpdate();
  }

  resetSession() {
    this.session = { ...DEFAULT_SESSION };
    this.saveSession();
    this.emitUpdate();
  }

  getSessionSummary() {
    return `Session: ${this.session.eloChange >= 0 ? '+' : ''}${this.session.eloChange} ELO (${this.session.wins}W-${this.session.losses}L) | Streak: ${this.session.streak}`;
  }

  async pollOnce() {
    if (!this.session.active || !this.session.playerId || this.isPolling) {
      return;
    }

    this.isPolling = true;

    try {
      const [details, history] = await Promise.all([
        this.getPlayerDetails(this.session.playerId),
        this.getPlayerHistory(this.session.playerId, 20)
      ]);

      this.session.currentElo = this.getCurrentEloFromPlayerData(details);
      this.session.eloChange = this.session.currentElo - this.session.startElo;

      const items = Array.isArray(history?.items) ? history.items : [];
      const newMatches = [];

      for (const match of items) {
        if (match.match_id === this.session.lastMatchId) break;
        newMatches.push(match);
      }

      if (newMatches.length) {
        newMatches.reverse().forEach(match => {
          const outcome = this.determineMatchOutcome(match, this.session.playerId);
          if (!outcome) return;

          if (outcome === 'win') {
            this.session.wins += 1;
            this.session.streak += 1;
          } else {
            this.session.losses += 1;
            this.session.streak = 0;
          }

          this.session.matches.push({
            id: match.match_id,
            outcome,
            finishedAt: match.finished_at || null,
            eloAfterMatch: this.session.currentElo
          });
        });

        this.session.matches = this.session.matches.slice(-100);
        this.session.lastMatchId = newMatches[0].match_id;
      }

      this.saveSession();
      this.emitUpdate();
    } catch (err) {
      console.error('⚠️ FACEIT polling epäonnistui:', err.message || err);
    } finally {
      this.isPolling = false;
    }
  }

  startPolling() {
    if (this.pollTimer) return;

    this.pollTimer = setInterval(() => {
      this.pollOnce();
    }, 60_000);
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
