# OneTricks Client

Desktop app for [onetricks.gg](https://www.onetricks.gg). Browse one-trick builds and send runes + items straight to your League of Legends client.

## Features

- onetricks.gg in a desktop window (with ad blocking)
- One-click import: runes, items, summoner spells
- Auto follow your champ-select pick, auto import on lock-in
- Auto accept match, auto select spells (all toggleable in settings ⚙)

## Install

Download the latest `OneTricks-Client-Setup-x.x.x.exe` from [Releases](../../releases) and run it.

> The app is not code-signed, so Windows SmartScreen may show a warning. Click "More info" → "Run anyway".

## Run from source

```bash
npm install
npm start
```

Requires the League client to be open for imports.

## Build the installer

```bash
npm run dist
```

Output goes to `dist/`.

## Notes

- Uses only the official League Client (LCU) API. No memory reading or injection.
- Not affiliated with onetricks.gg or Riot Games.
