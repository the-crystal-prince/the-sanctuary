
const express = require("express");
const dotenv = require("dotenv");
const { AccessToken } = require("livekit-server-sdk");

dotenv.config();

const app = express();
app.use(express.json());

// Serve your existing Sanctuary webpage
app.use(express.static("."));

app.post("/get-token", async (req, res) => {
  try {
      const { roomName, participantName } = req.body;

          if (
                typeof roomName !== "string" ||
                      typeof participantName !== "string" ||
                            !roomName.trim() ||
                                  !participantName.trim() ||
                                        roomName.length > 100 ||
                                              participantName.length > 50
                                                  ) {
                                                        return res.status(400).json({
                                                                error: "Please provide a valid room name and participant name."
                                                                      });
                                                                          }

                                                                              const token = new AccessToken(
                                                                                    process.env.LIVEKIT_API_KEY,
                                                                                          process.env.LIVEKIT_API_SECRET,
                                                                                                {
                                                                                                        identity: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                                                                                                                name: participantName.trim(),
                                                                                                                        ttl: "1h"
                                                                                                                              }
                                                                                                                                  );

                                                                                                                                      token.addGrant({
                                                                                                                                            roomJoin: true,
                                                                                                                                                  room: roomName.trim(),
                                                                                                                                                        canPublish: true,
                                                                                                                                                              canSubscribe: true
                                                                                                                                                                  });

                                                                                                                                                                      const jwt = await token.toJwt();

                                                                                                                                                                          res.json({
                                                                                                                                                                                token: jwt,
                                                                                                                                                                                      url: process.env.LIVEKIT_URL
                                                                                                                                                                                          });
                                                                                                                                                                                            } catch (error) {
                                                                                                                                                                                                console.error("Token creation failed:", error.message);
                                                                                                                                                                                                    res.status(500).json({
                                                                                                                                                                                                          error: "Could not create a room access token."
                                                                                                                                                                                                              });
                                                                                                                                                                                                                }
                                                                                                                                                                                                                });

                                                                                                                                                                                                                const port = process.env.PORT || 3000;

                                                                                                                                                                                                                app.listen(port, "0.0.0.0", () => {
                                                                                                                                                                                                                  console.log(`Sanctuary server running on port ${port}`);
                                                                                                                                                                                                                  });
                                                                                                                                                                                                                  