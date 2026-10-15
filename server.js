const express = require("express");
const path = require("path");
const dotenv = require("dotenv");
const { AccessToken } = require("livekit-server-sdk");

dotenv.config();

// Rooms people are allowed to join. Add more names here later.
const ALLOWED_ROOMS = new Set(["sanctuary-forest"]);

const app = express();
app.use(express.json());

// Only the public/ folder is served, not the server code or config.
app.use(express.static(path.join(__dirname, "public")));

// Render uses this to check the service is alive.
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/get-token", async (req, res) => {
  try {
    const { roomName, participantName } = req.body || {};

    if (
      typeof roomName !== "string" ||
      typeof participantName !== "string" ||
      !roomName.trim() ||
      !participantName.trim() ||
      participantName.length > 50
    ) {
      return res.status(400).json({
        error: "Please provide a valid room name and participant name.",
      });
    }

    if (!ALLOWED_ROOMS.has(roomName.trim())) {
      return res.status(400).json({ error: "That room does not exist." });
    }

    const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL } = process.env;
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
      console.error("Missing LIVEKIT_* environment variables.");
      return res.status(500).json({ error: "The server is not configured." });
    }

    const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      name: participantName.trim(),
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
