const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('otpOverlayAPI', {
  onPlayersUpdate: (callback) => {
    const handler = (_e, players) => callback(players);
    ipcRenderer.on('otp:overlay-players', handler);
    return () => ipcRenderer.removeListener('otp:overlay-players', handler);
  },
  onGameState: (callback) => {
    const handler = (_e, state) => callback(state);
    ipcRenderer.on('otp:overlay-gamestate', handler);
    return () => ipcRenderer.removeListener('otp:overlay-gamestate', handler);
  },
  requestClose: () => ipcRenderer.send('otp:overlay-close'),
  setClickThrough: (enabled) => ipcRenderer.send('otp:overlay-clickthrough', enabled)
});

contextBridge.exposeInMainWorld('otpOverlayUtils', {
  getSpellIcon: (spellId) => {
    const map = {
      4: 'SummonerFlash', 14: 'SummonerIgnite', 12: 'SummonerTeleport',
      6: 'SummonerHaste', 7: 'SummonerHeal', 21: 'SummonerBarrier',
      1: 'SummonerBoost', 13: 'SummonerMana', 3: 'SummonerExhaust'
    };
    return map[spellId] || 'SummonerFlash';
  }
});