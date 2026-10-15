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

/* ---------- UI helpers ---------- */

function setControls(connected) {
  micButton.disabled = !connected;
  cameraButton.disabled = !connected;
  leaveButton.disabled = !connected;
  joinButton.disabled = connected || connecting;
  nameInput.disabled = connected || connecting;
}

function setMicLabel(on) {
  micButton.classList.toggle("active", on);
  micButton.innerHTML = on
    ? '<span class="symbol">🎙</span>Mic on'
    : '<span class="symbol">🔇</span>Mic off';
}

function setCameraLabel(on) {
  cameraButton.classList.toggle("active", on);
  cameraButton.innerHTML = on
    ? '<span class="symbol">◉</span>Camera on'
    : '<span class="symbol">◯</span>Camera off';
}

function updateCount() {
  const total = room ? room.remoteParticipants.size + 1 : 0;
  count.textContent = `${total} / ${MAX_PEOPLE} people`;
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
  face.textContent = "🧘🏻";
  avatar.append(face);

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
    body: JSON.stringify({ roomName: ROOM_NAME, participantName }),
  });

  const data = await response.json();
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
    localStatus.textContent = "Connected";

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
    localStatus.textContent = cameraEnabled
      ? "Connected · camera on"
      : "Connected";

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
    joinButton.disabled = !!room;
    nameInput.disabled = !!room;
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
  nameInput.disabled = false;
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
      localStatus.textContent = "Connected · camera on";
    } else {
      showLocalVideo(false);
      localStatus.textContent = "Connected · camera off";
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
}

function toggleTimer() {
  if (running) {
    clearInterval(interval);
    running = false;
    startButton.innerHTML = '<span class="symbol">▶</span>Resume';
    timerState.textContent = "Paused";
    return;
  }

  if (seconds === 0) seconds = SESSION_SECONDS;
  running = true;
  startButton.innerHTML = '<span class="symbol">Ⅱ</span>Pause';
  timerState.textContent = "A quiet moment together";

  interval = setInterval(() => {
    if (seconds > 0) seconds--;
    renderClock();

    if (seconds === 0) {
      clearInterval(interval);
      running = false;
      startButton.innerHTML = '<span class="symbol">↻</span>Restart';
      timerState.textContent = "Session complete";
    }
  }, 1000);
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
