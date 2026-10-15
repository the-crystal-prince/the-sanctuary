# The Sanctuary

A small shared meditation room: people join the "Forest Room" with audio and video, see who is speaking, and run a quiet timer on their own device. Built with Express and [LiveKit](https://livekit.io).

## Layout

- `server.js`: Express server. Serves `public/` and issues LiveKit access tokens at `POST /get-token`.
- `public/index.html`, `style.css`, `app.js`: the page. `app.js` loads `livekit-client` from a CDN.

## Environment variables

Set these in Render (or in a local `.env`, which is git-ignored):

| Name | What it is |
| --- | --- |
| `LIVEKIT_URL` | Your LiveKit project URL, e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |

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

## Adding rooms

Add the room name to `ALLOWED_ROOMS` in `server.js`, and pass that name from the page.
