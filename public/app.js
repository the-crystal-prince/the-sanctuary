import {
  Room,
  RoomEvent,
  Track,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2.22.4/+esm";

const ROOM_NAME = "sanctuary-forest";
const MAX_PEOPLE = 8;
const SESSION_SECONDS = 20 * 60;

let room = null;
let connecting = false;
let micEnabled = false;
let cameraEnabled = false;
let seconds = SESSION_SECONDS;
let running = false;
let interval = null;
let liffReady = false;
let lineProfile = null; // { displayName, pictureUrl } when signed in with LINE
let idToken = null; // sent to the server so it can verify who you are
let nameLocked = false;

const $ = (id) => document.getElementById(id);
const video = $("localVideo");
const placeholder = $("cameraPlaceholder");
const localPerson = $("localPerson");
const localStatus = $("localStatus");
const localName = $("localName");
const count = $("count");
const message = $("message");
const joinButton = $("join");
const nameInput = $("participantName");
const micButton = $("mic");
const cameraButton = $("camera");
const startButton = $("start");
const leaveButton = $("leave");
const people = $("people");
const clock = $("clock");
const timerState = $("timerState");
const lineRow = $("lineRow");
const lineStatus = $("lineStatus");
const lineLogin = $("lineLogin");

/* ---------- UI helpers ---------- */

function setControls(connected) {
  micButton.disabled = !connected;
  cameraButton.disabled = !connected;
  leaveButton.disabled = !connected;
  joinButton.disabled = connected || connecting;
  joinButton.textContent = connecting ? "Joining…" : "Join";
  nameInput.disabled = connected || connecting || nameLocked;
  document.body.classList.toggle("in-room", connected);
}

// First letter of a name, for the circle shown when the camera is off.
function initialOf(name) {
  const first = Array.from(String(name || "").trim())[0];
  return first ? first.toUpperCase() : "·";
}

function setButtonLabel(button, text) {
  button.querySelector(".lbl").textContent = text;
}

// Only LINE profile pictures are shown.
function setAvatarPhoto(avatar, url) {
  if (
    !url ||
    typeof url !== "string" ||
    !url.startsWith("https://profile.line-scdn.net/")
  ) {
    return;
  }
  if (avatar.querySelector(".avatar-photo")) return;

  const photo = document.createElement("img");
  photo.className = "avatar-photo";
  photo.alt = "";
  photo.referrerPolicy = "no-referrer";
  avatar.prepend(photo);
  photo.addEventListener("load", () => avatar.classList.add("has-photo"));
  photo.addEventListener("error", () => photo.remove());
  photo.src = url;
}

function pictureFromMetadata(participant) {
  try {
    return JSON.parse(participant.metadata || "{}").picture || null;
  } catch {
    return null;
  }
}

function setMicLabel(on) {
  micButton.classList.toggle("active", on);
  micButton.dataset.on = String(on);
  setButtonLabel(micButton, on ? "Mic on" : "Mic off");
}

function setCameraLabel(on) {
  cameraButton.classList.toggle("active", on);
  cameraButton.dataset.on = String(on);
  setButtonLabel(cameraButton, on ? "Camera on" : "Camera off");
}

// The start button shows one of: ready, running, paused, done.
function setTimerButton(state) {
  startButton.dataset.state = state;
  setButtonLabel(
    startButton,
    {
      ready: "Start",
      running: "Pause",
      paused: "Resume",
      done: "Restart",
    }[state],
  );
}

function updateCount() {
  if (!room) {
    count.textContent = `Up to ${MAX_PEOPLE} people`;
    return;
  }
  count.textContent = `${room.remoteParticipants.size + 1} of ${MAX_PEOPLE} here`;
}

function showLocalVideo(show) {
  video.hidden = !show;
  placeholder.hidden = show;
}

function attachLocalVideo() {
  const publication = Array.from(
    room.localParticipant.videoTrackPublications.values(),
  ).find((item) => item.track);
  if (publication && publication.track) {
    showLocalVideo(true);
    publication.track.attach(video);
    video.muted = true;
  }
}

/* ---------- Remote participants ---------- */

function participantCard(participant) {
  const id = "remote-" + participant.identity;
  let card = document.getElementById(id);
  if (card) return card;

  card = document.createElement("div");
  card.className = "person";
  card.id = id;

  const avatar = document.createElement("div");
  avatar.className = "avatar";

  const face = document.createElement("span");
  face.className = "camera-placeholder";
  face.textContent = initialOf(participant.name);
  avatar.append(face);
  setAvatarPhoto(avatar, pictureFromMetadata(participant));

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = participant.name || "Guest";

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "Connected";

  card.append(avatar, name, status);
  people.append(card);
  return card;
}

function attachRemoteTrack(track, publication, participant) {
  const card = participantCard(participant);

  if (track.kind === Track.Kind.Video) {
    const avatar = card.querySelector(".avatar");
    const old = avatar.querySelector("video");
    if (old) old.remove();

    const face = avatar.querySelector(".camera-placeholder");
    if (face) face.hidden = true;

    const element = track.attach();
    element.autoplay = true;
    element.playsInline = true;
    avatar.append(element);
  } else if (track.kind === Track.Kind.Audio) {
    const element = track.attach();
    element.className = "remote-audio";
    element.autoplay = true;
    document.body.append(element);
  }
}

function clearRemote() {
  people
    .querySelectorAll(".person:not(#localPerson)")
    .forEach((element) => element.remove());
  document
    .querySelectorAll(".remote-audio")
    .forEach((element) => element.remove());
}

/* ---------- Room lifecycle ---------- */

function resetLocalUi() {
  video.srcObject = null;
  showLocalVideo(false);
  clearRemote();
  updateCount();
  localPerson.classList.remove("speaking");
  localStatus.textContent = "Not connected";
  micEnabled = false;
  cameraEnabled = false;
  setMicLabel(true);
  setCameraLabel(true);
  micButton.classList.remove("active");
  cameraButton.classList.remove("active");
}

function wireRoomEvents(activeRoom) {
  activeRoom.on(RoomEvent.TrackSubscribed, attachRemoteTrack);

  activeRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((element) => element.remove());
  });

  // When someone turns their camera off, show their photo again.
  const setRemoteVideoHidden = (publication, participant, hidden) => {
    if (publication.kind !== Track.Kind.Video) return;
    const card = document.getElementById("remote-" + participant.identity);
    const remoteVideo = card && card.querySelector("video");
    if (remoteVideo) remoteVideo.hidden = hidden;
    const face = card && card.querySelector(".camera-placeholder");
    if (face && !(card.querySelector(".avatar-photo"))) face.hidden = !hidden;
  };
  activeRoom.on(RoomEvent.TrackMuted, (publication, participant) =>
    setRemoteVideoHidden(publication, participant, true),
  );
  activeRoom.on(RoomEvent.TrackUnmuted, (publication, participant) =>
    setRemoteVideoHidden(publication, participant, false),
  );

  activeRoom.on(RoomEvent.ParticipantConnected, (participant) => {
    participantCard(participant);
    updateCount();
  });

  activeRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
    const card = document.getElementById("remote-" + participant.identity);
    if (card) card.remove();
    updateCount();
  });

  activeRoom.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
    document
      .querySelectorAll(".person.speaking")
      .forEach((element) => element.classList.remove("speaking"));
    for (const speaker of speakers) {
      if (speaker.isLocal) {
        localPerson.classList.add("speaking");
      } else {
        const card = document.getElementById("remote-" + speaker.identity);
        if (card) card.classList.add("speaking");
      }
    }
  });
}

async function fetchToken(participantName) {
  const response = await fetch("/get-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      roomName: ROOM_NAME,
      participantName,
      idToken: lineProfile ? idToken : undefined,
    }),
  });

  const data = await response.json();
  if (response.status === 401 && liffReady) {
    // LINE login expired: sign in again (this reloads the page).
    liff.logout();
    liff.login({ redirectUri: window.location.href });
    throw Error(data.error || "Please log in with LINE again.");
  }
  if (!response.ok) throw Error(data.error || "Could not get room access.");
  if (!data.url || !data.token) {
    throw Error("The server did not return a room URL and token.");
  }
  return data;
}

async function joinRoom() {
  if (connecting || room) return;

  const participantName = nameInput.value.trim();
  if (!participantName) {
    message.textContent = "Please enter your name first.";
    nameInput.focus();
    return;
  }

  connecting = true;
  setControls(false);
  message.textContent = "Connecting to the Forest Room…";

  try {
    const data = await fetchToken(participantName);

    room = new Room({ adaptiveStream: true, dynacast: true });
    wireRoomEvents(room);

    await room.connect(data.url, data.token);

    localName.textContent = participantName;
    placeholder.textContent = initialOf(participantName);
    localStatus.textContent = "Connected";
    if (lineProfile) {
      setAvatarPhoto(localPerson.querySelector(".avatar"), lineProfile.pictureUrl);
    }

    for (const participant of room.remoteParticipants.values()) {
      participantCard(participant);
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) {
          attachRemoteTrack(publication.track, publication, participant);
        }
      }
    }

    updateCount();
    setControls(true);

    // Mic and camera are enabled separately, so a denied camera
    // permission does not stop you from joining with audio only.
    const problems = [];

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      micEnabled = true;
    } catch (error) {
      console.error(error);
      problems.push("microphone");
    }
    setMicLabel(micEnabled);

    try {
      await room.localParticipant.setCameraEnabled(true);
      cameraEnabled = true;
      attachLocalVideo();
    } catch (error) {
      console.error(error);
      problems.push("camera");
    }
    setCameraLabel(cameraEnabled);
    localStatus.textContent = cameraEnabled ? "Camera on" : "Camera off";

    message.textContent = problems.length
      ? `You're connected, but the ${problems.join(" and ")} couldn't start. Check your browser permissions, then use the buttons below.`
      : "You're connected. People in this room can now hear and see one another.";
  } catch (error) {
    console.error(error);
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // already disconnected
      }
      room = null;
    }
    resetLocalUi();
    setControls(false);
    message.textContent =
      "Could not connect: " +
      error.message +
      ". Check the server and camera/microphone permissions.";
  } finally {
    connecting = false;
    joinButton.textContent = "Join";
    joinButton.disabled = !!room;
    nameInput.disabled = !!room || nameLocked;
  }
}

async function leaveRoom() {
  if (room) {
    const oldRoom = room;
    room = null;
    await oldRoom.disconnect();
  }

  resetLocalUi();
  message.textContent =
    "You've left the room. Join again whenever you're ready.";
  setControls(false);
  joinButton.disabled = false;
  nameInput.disabled = nameLocked;
}

/* ---------- Mic and camera ---------- */

async function toggleMic() {
  if (!room) return;
  try {
    await room.localParticipant.setMicrophoneEnabled(!micEnabled);
    micEnabled = !micEnabled;
    setMicLabel(micEnabled);
  } catch (error) {
    message.textContent = "Microphone issue: " + error.message;
  }
}

async function toggleCamera() {
  if (!room) return;
  try {
    await room.localParticipant.setCameraEnabled(!cameraEnabled);
    cameraEnabled = !cameraEnabled;
    setCameraLabel(cameraEnabled);

    if (cameraEnabled) {
      attachLocalVideo();
      localStatus.textContent = "Camera on";
    } else {
      showLocalVideo(false);
      localStatus.textContent = "Camera off";
    }
  } catch (error) {
    message.textContent = "Camera issue: " + error.message;
  }
}

/* ---------- Timer (runs on this device only) ---------- */

function renderClock() {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");
  clock.textContent = `${minutes}:${secs}`;
  // The liquid in the orb rises as the session goes on.
  if (window.sanctuaryOrb) {
    window.sanctuaryOrb.setProgress(1 - seconds / SESSION_SECONDS);
  }
}

function setOrbActive(active) {
  if (window.sanctuaryOrb) window.sanctuaryOrb.setActive(active);
}

function toggleTimer() {
  if (running) {
    clearInterval(interval);
    running = false;
    setTimerButton("paused");
    setOrbActive(false);
    timerState.textContent = "Paused";
    return;
  }

  if (seconds === 0) seconds = SESSION_SECONDS;
  renderClock();
  running = true;
  setTimerButton("running");
  setOrbActive(true);
  timerState.textContent = "A quiet moment together";

  interval = setInterval(() => {
    if (seconds > 0) seconds--;
    renderClock();

    if (seconds === 0) {
      clearInterval(interval);
      running = false;
      setTimerButton("done");
      setOrbActive(false);
      timerState.textContent = "Session complete";
    }
  }, 1000);
}

/* ---------- LINE login (LIFF) ---------- */

async function initLine() {
  try {
    const response = await fetch("/config");
    const config = await response.json();
    if (!config.liffId || !window.liff) return; // LINE login not set up: guests only

    await liff.init({ liffId: config.liffId });
    liffReady = true;
    lineRow.hidden = false;

    if (liff.isLoggedIn()) {
      lineProfile = await liff.getProfile();
      idToken = liff.getIDToken();
      if (!idToken) {
        // Token missing: the LIFF app needs the "openid" scope.
        lineProfile = null;
        lineStatus.textContent = "LINE login isn't fully set up yet.";
        return;
      }

      nameInput.value = lineProfile.displayName;
      nameLocked = true;
      nameInput.disabled = true;
      lineStatus.textContent = "Signed in with LINE as " + lineProfile.displayName;
      setAvatarPhoto(
        localPerson.querySelector(".avatar"),
        lineProfile.pictureUrl,
      );
      message.textContent = "Tap Join to enter the room.";
    } else {
      lineStatus.textContent = "Join as a guest, or sign in with LINE.";
      lineLogin.hidden = false;
      lineLogin.addEventListener("click", () =>
        liff.login({ redirectUri: window.location.href }),
      );
    }
  } catch (error) {
    // LINE login is optional: if anything fails, guests can still join.
    console.error("LINE login unavailable:", error);
    lineRow.hidden = true;
  }
}

/* ---------- Wiring ---------- */

joinButton.addEventListener("click", joinRoom);
micButton.addEventListener("click", toggleMic);
cameraButton.addEventListener("click", toggleCamera);
startButton.addEventListener("click", toggleTimer);
leaveButton.addEventListener("click", leaveRoom);

window.addEventListener("beforeunload", () => {
  if (room) room.disconnect();
});

initLine();
