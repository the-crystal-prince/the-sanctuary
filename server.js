const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const { AccessToken } = require("livekit-server-sdk");

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
