const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { AccessToken, TokenVerifier } = require("livekit-server-sdk");

dotenv.config();

// Rooms people are allowed to join. Add more names here later.
const ALLOWED_ROOMS = new Set(["sanctuary-forest"]);

// LINE login (optional). LIFF_ID looks like "1234567890-AbCdEfGh".
// The part before the dash is the LINE Login channel ID.
const LIFF_ID = process.env.LIFF_ID || "";
const LINE_CHANNEL_ID =
  process.env.LINE_CHANNEL_ID || LIFF_ID.split("-")[0] || "";

const app = express();
app.use(express.json());

// Only the public/ folder is served, not the server code or config.
app.use(express.static(path.join(__dirname, "public")));

// Render uses this to check the service is alive.
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// The server's clock, so every phone can line its timer up with everyone else's
// even when their own clocks are a little off.
app.get("/time", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ now: Date.now() });
});


// ---- Audio the host adds for a session ----
// Kept only for the length of a meditation: files live in the server's temporary
// folder, so they are cleared when the server restarts and after a few hours.
// Only people who are in the room (they hold a valid room token) can add one.
const AUDIO_DIR = path.join(os.tmpdir(), "sanctuary-audio");
const AUDIO_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_AUDIO_FILES = 30;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const audioFiles = new Map(); // id -> { file, type, at }

fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

function dropAudio(id) {
  const item = audioFiles.get(id);
  if (!item) return;
  audioFiles.delete(id);
  fs.rm(item.file, { force: true }, () => {});
}

setInterval(() => {
  const old = Date.now() - AUDIO_TTL_MS;
  for (const [id, item] of audioFiles) if (item.at < old) dropAudio(id);
}, 30 * 60 * 1000).unref();

// What kind of audio is this? Looked at from the first bytes, not the file name.
function sniffAudio(buf) {
  if (buf.length < 12) return null;
  if (buf.toString("latin1", 0, 3) === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    return { ext: "mp3", type: "audio/mpeg" };
  }
  if (buf.toString("latin1", 4, 8) === "ftyp") return { ext: "m4a", type: "audio/mp4" };
  if (buf.toString("latin1", 0, 4) === "OggS") return { ext: "ogg", type: "audio/ogg" };
  if (buf.toString("latin1", 0, 4) === "RIFF") return { ext: "wav", type: "audio/wav" };
  if (buf.toString("latin1", 0, 4) === "fLaC") return { ext: "flac", type: "audio/flac" };
  return null;
}

app.post(
  "/upload-audio",
  express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }),
  async (req, res) => {
    try {
      const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
      const bearer = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
      if (!bearer || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
        return res.status(401).json({ error: "Join the room first." });
      }
      try {
        await new TokenVerifier(LIVEKIT_API_KEY, LIVEKIT_API_SECRET).verify(bearer);
      } catch {
        return res.status(401).json({ error: "Your room login has expired." });
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const kind = sniffAudio(body);
      if (!kind) return res.status(415).json({ error: "That doesn't look like an audio file." });

      while (audioFiles.size >= MAX_AUDIO_FILES) {
        dropAudio(audioFiles.keys().next().value); // the oldest
      }
      const id = crypto.randomBytes(12).toString("hex");
      const file = path.join(AUDIO_DIR, `${id}.${kind.ext}`);
      await fs.promises.writeFile(file, body);
      audioFiles.set(id, { file, type: kind.type, at: Date.now() });
      res.json({ id });
    } catch (error) {
      console.error("Audio upload failed:", error.message);
      res.status(500).json({ error: "Could not store the audio." });
    }
  },
);

// Supports ranges, so phones can start part-way in and seek.
app.get("/audio/:id", (req, res) => {
  const item = /^[a-f0-9]{24}$/.test(req.params.id) && audioFiles.get(req.params.id);
  if (!item) return res.status(404).end();
  res.type(item.type).set("Cache-Control", "private, max-age=3600").sendFile(item.file);
});

// Tells the page whether LINE login is set up.
app.get("/config", (req, res) => {
  res.json({ liffId: LIFF_ID || null });
});

// Asks LINE whether an ID token is real, and who it belongs to.
async function verifyLineIdToken(idToken) {
  if (!LINE_CHANNEL_ID) return null;

  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      id_token: idToken,
      client_id: LINE_CHANNEL_ID,
    }),
  });

  if (!response.ok) return null;

  const data = await response.json();
  return data && data.sub ? data : null;
}

// Only accept profile pictures that really come from LINE.
function safePictureUrl(url) {
  return typeof url === "string" &&
    url.startsWith("https://profile.line-scdn.net/")
    ? url
    : null;
}

app.post("/get-token", async (req, res) => {
  try {
    const { roomName, participantName, idToken } = req.body || {};

    if (typeof roomName !== "string" || !roomName.trim()) {
      return res.status(400).json({ error: "Please provide a room name." });
    }

    if (!ALLOWED_ROOMS.has(roomName.trim())) {
      return res.status(400).json({ error: "That room does not exist." });
    }

    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      console.error("Missing LIVEKIT_* environment variables.");
      return res.status(500).json({ error: "The server is not configured." });
    }

    let identity;
    let name;
    let metadata;

    if (typeof idToken === "string" && idToken) {
      // Signed in with LINE: use the name and photo LINE vouches for.
      const profile = await verifyLineIdToken(idToken);
      if (!profile) {
        return res.status(401).json({
          error: "Your LINE login has expired. Please log in again.",
        });
      }
      identity = `line-${profile.sub}`;
      name = String(profile.name || "Friend").slice(0, 50);
      metadata = JSON.stringify({ picture: safePictureUrl(profile.picture) });
    } else {
      // Guest: anyone can type a name.
      if (
        typeof participantName !== "string" ||
        !participantName.trim() ||
        participantName.length > 50
      ) {
        return res.status(400).json({
          error: "Please provide a valid room name and participant name.",
        });
      }
      identity = `guest-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      name = participantName.trim();
      metadata = JSON.stringify({ picture: null });
    }

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
      name,
      metadata,
      ttl: "1h",
    });

    token.addGrant({
      roomJoin: true,
      room: roomName.trim(),
      canPublish: true,
      canPublishData: true, // chat and blessings
      canUpdateOwnMetadata: true, // lets each person share which session they are in
      canSubscribe: true,
    });

    res.json({ token: await token.toJwt(), url: LIVEKIT_URL });
  } catch (error) {
    console.error("Token creation failed:", error.message);
    res.status(500).json({ error: "Could not create a room access token." });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Sanctuary server running on port ${port}`);
});
