# The Sanctuary

A small shared meditation room: people join the "Forest Room" with audio and video, see who is speaking, and run a quiet timer on their own device. Built with Express and [LiveKit](https://livekit.io).

## Layout

- `server.js`: Express server. Serves `public/` and issues LiveKit access tokens at `POST /get-token`.
- `public/index.html`, `style.css`, `app.js`: the page. `app.js` loads `livekit-client` from a CDN.

## Intro video

`public/intro.js` loops a transparent video over the night sky until someone taps to enter the room. It looks for `public/intro/intro.webm` (VP9 with alpha: Chrome, Android) and `public/intro/intro.mov` (tried first on iPhone, iPad and Safari). Add `?intro=webm`, `?intro=mov` or `?intro=off` to the address to try one or skip it.

## Environment variables

Set these in Render (or in a local `.env`, which is git-ignored):

| Name | What it is |
| --- | --- |
| `LIVEKIT_URL` | Your LiveKit project URL, e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `LIFF_ID` | Optional. Your LIFF ID, e.g. `1234567890-AbCdEfGh`. Turns on LINE login. |

## Run locally

```
npm install
npm start
```

Then open http://localhost:3000.

## Deploy on Render

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Add the three environment variables above.

## LINE login (optional)

With `LIFF_ID` set, people opening the room inside LINE are signed in automatically, and their LINE name and photo appear in the room. Anyone else can still join as a guest or tap "Log in with LINE". Without `LIFF_ID`, everyone joins as a guest.

Setup in the [LINE Developers Console](https://developers.line.biz/console/):
1. Open your **LINE Login** channel and go to the **LIFF** tab, then add a LIFF app.
2. Endpoint URL: your Render site address (must be `https`).
3. Scopes: turn on **profile** and **openid**.
4. Copy the LIFF ID into the `LIFF_ID` variable on Render.
5. Share the LIFF URL (`https://liff.line.me/<LIFF_ID>`) as your link and bot button.

The server checks each LINE login with LINE before trusting the name and photo.

## Music

The note bubble in the room controls opens a card where you paste a YouTube link (video, playlist or Shorts).

- **In a session** the music is shared. Whoever presses play starts it for everyone in that session, late joiners start part-way in, and "Stop for everyone" ends it. Sessions with music show "♪ title" in the join list and the session card. The state is kept in participant attributes (`music`), like the session itself, so the server stores nothing.
- **Outside a session** it plays for you only.
- **Minimizing** the card or the controls never interrupts it. YouTube doesn't allow hiding the picture to play only the sound, so with the card minimized the video stays visible as a soft-edged circle over the sphere. The circle button in the card shows it there on purpose.

## Adding rooms

Add the room name to `ALLOWED_ROOMS` in `server.js`, and pass that name from the page.
