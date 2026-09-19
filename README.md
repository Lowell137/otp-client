# OTP Client

Desktop companion for browsing one-trick builds, with one-click rune, item and summoner-spell import into the League of Legends client.

## Features

- Build browser in a desktop window (with ad blocking)
- One-click import: runes, items, summoner spells
- Auto follow your champ-select pick, auto import on lock-in
- Auto accept match, auto select spells (all toggleable in settings ⚙)

## Install

Download the latest `OTP-Client-Setup-x.x.x.exe` from [Releases](../../releases) and run it.

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

## Data sources & attribution

- Build data: onetricks.gg (shown in-app, belongs to them)
- Tier list data: Lolalytics
- Summoner data & AI scores: deeplol.gg
- Game data & images: Riot Games Data Dragon (community use)

This tool only reads these sites at runtime for personal use — no content is redistributed. If you own any of this data and want it removed, open an issue and it will be taken out immediately.

## Disclaimer

Community project, for personal use. Not affiliated with or endorsed by Riot Games or any build-data provider. Uses only the official League Client (LCU) API — no memory reading or injection. All build data, champion names and game assets belong to their respective owners. "League of Legends" is a trademark of Riot Games, Inc.
