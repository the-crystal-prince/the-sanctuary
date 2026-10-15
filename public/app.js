import {
  Room,
  RoomEvent,
  Track,
} from "https://cdn.jsdelivr.net/npm/livekit-client@2.22.4/+esm";

const ROOM_NAME = "sanctuary-forest";
const MAX_PEOPLE = 8;
const GLOW_MS = 7000;
const FLOAT_MS = 7000;
const ACTION_COOLDOWN_MS = 2500;
const MAX_TIMELINE = 120;

let room = null;
let connecting = false;
let micEnabled = false;
let cameraEnabled = false;
let liffReady = false;
let lineProfile = null; // { displayName, pictureUrl } when signed in with LINE
let idToken = null; // sent to the server so it can verify who you are
let nameLocked = false;

// One meditation, shared by everyone in the room.
const session = { running: false, startedAt: 0, final: 0 };
let timeline = [];
let tick = null;

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
const chatToggle = $("chatToggle");
const chatDot = $("chatDot");
const leaveButton = $("leave");
const sessionButton = $("session");
const people = $("people");
const clock = $("clock");
const timerState = $("timerState");
const timelineList = $("timeline");
const lineRow = $("lineRow");
const lineStatus = $("lineStatus");
const lineLogin = $("lineLogin");
const controls = $("controls");
const railToggle = $("railToggle");
const actions = $("actions");
const actionsToggle = $("actionsToggle");
const chatSheet = $("chatSheet");
const chatList = $("chatList");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const fx = $("fx");
const toast = $("toast");
const summary = $("summary");
const sumTitle = $("sumTitle");
const sumTimeline = $("sumTimeline");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ---------- Small helpers ---------- */

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim()
    .slice(0, max);
}

function initialOf(name) {
  const first = Array.from(String(name || "").trim())[0];
  return first ? first.toUpperCase() : "·";
}

function formatTime(total) {
  const t = Math.max(0, Math.floor(total));
  const h = Math.floor(t / 3600);
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

/* ---------- Camera and mic icons: green when on, red when off ---------- */

const MIC_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/><path class="slash" d="M4 4l16 16"/></svg>';
const CAM_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6.5" width="13" height="11" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/><path class="slash" d="M4 4l16 16"/></svg>';

function buildStatus(container) {
  container.innerHTML =
    `<span class="mi mic off">${MIC_SVG}</span>` +
    `<span class="mi cam off">${CAM_SVG}</span>`;
  container.setAttribute("role", "img");
  container.setAttribute("aria-label", "Mic off, camera off");
}

function setStatus(container, mic, cam) {
  const micIcon = container.querySelector(".mic");
  const camIcon = container.querySelector(".cam");
  if (!micIcon || !camIcon) return;
  micIcon.classList.toggle("off", !mic);
  camIcon.classList.toggle("off", !cam);
  container.setAttribute(
    "aria-label",
    `Mic ${mic ? "on" : "off"}, camera ${cam ? "on" : "off"}`,
  );
}

function refreshMedia() {
  setStatus(localStatus, micEnabled, cameraEnabled);
  if (!room) return;
  for (const participant of room.remoteParticipants.values()) {
    const card = document.getElementById("remote-" + participant.identity);
    const status = card && card.querySelector(".status");
    if (status) {
      setStatus(
        status,
        participant.isMicrophoneEnabled,
        participant.isCameraEnabled,
      );
    }
  }
}

buildStatus(localStatus);

/* ---------- UI helpers ---------- */

function setControls(connected) {
  micButton.disabled = !connected;
  cameraButton.disabled = !connected;
  chatToggle.disabled = !connected;
  leaveButton.disabled = !connected;
  joinButton.disabled = connected || connecting;
  joinButton.textContent = connecting ? "Joining…" : "Join";
  nameInput.disabled = connected || connecting || nameLocked;
  document.body.classList.toggle("in-room", connected);
  if (!connected) {
    // Leaving the room always brings the interface back.
    document.body.classList.remove("ui-hidden");
    closeChat();
    setActionsOpen(false);
  }
  updateSessionUi();
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
  micButton.dataset.on = String(on);
  micButton.setAttribute("aria-label", on ? "Mic on" : "Mic off");
  refreshMedia();
}

function setCameraLabel(on) {
  cameraButton.dataset.on = String(on);
  cameraButton.setAttribute("aria-label", on ? "Camera on" : "Camera off");
  refreshMedia();
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
  buildStatus(status);

  card.append(avatar, name, status);
  people.append(card);
  refreshMedia();
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
  refreshMedia();
}

function clearRemote() {
  people
    .querySelectorAll(".person:not(#localPerson)")
    .forEach((element) => element.remove());
  document
    .querySelectorAll(".remote-audio")
    .forEach((element) => element.remove());
}

/* ---------- Shared messages (LiveKit data channel) ---------- */

function send(msg, destinationIdentities) {
  if (!room) return;
  const options = { reliable: true };
  if (destinationIdentities) options.destinationIdentities = destinationIdentities;
  room.localParticipant
    .publishData(encoder.encode(JSON.stringify(msg)), options)
    .catch((error) => console.error("Could not send:", error));
}

// Sends to everyone else and applies it here too (the room does not echo it back).
function broadcast(msg) {
  send(msg);
  if (room) handleMessage(msg, room.localParticipant, true);
}

function onDataReceived(payload, participant) {
  if (!participant) return;
  let msg;
  try {
    msg = JSON.parse(decoder.decode(payload));
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  handleMessage(msg, participant, false);
}

function handleMessage(msg, from, isLocal) {
  const name = from.name || "Guest";

  switch (msg.t) {
    case "chat": {
      const text = clean(msg.text, 500);
      if (text) addChat({ name, text, mine: isLocal });
      break;
    }
    case "start":
      if (!session.running) startSession(0);
      break;
    case "end": {
      const elapsed = Number(msg.elapsed);
      if (session.running) {
        endSession(
          Number.isFinite(elapsed) ? Math.min(Math.max(elapsed, 0), 86400) : elapsedNow(),
        );
      }
      break;
    }
    case "action":
      if (ACTIONS[msg.kind]) doAction(msg.kind, from, isLocal);
      break;
    case "hello":
      // A newcomer asks for the session so far. One person answers.
      if (!isLocal && session.running && isResponderFor(from)) {
        send(
          {
            t: "state",
            elapsed: elapsedNow(),
            timeline: timeline.slice(-MAX_TIMELINE),
          },
          [from.identity],
        );
      }
      break;
    case "state":
      if (!isLocal && !session.running) adoptState(msg);
      break;
    default:
  }
}

// The person whose identity sorts first answers a newcomer, so they get one reply.
function isResponderFor(newcomer) {
  if (!room) return false;
  const ids = [room.localParticipant.identity];
  for (const participant of room.remoteParticipants.values()) {
    if (participant.identity !== newcomer.identity) ids.push(participant.identity);
  }
  ids.sort();
  return ids[0] === room.localParticipant.identity;
}

function adoptState(msg) {
  const elapsed = Number(msg.elapsed);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 86400) return;

  const entries = [];
  if (Array.isArray(msg.timeline)) {
    for (const item of msg.timeline.slice(-MAX_TIMELINE)) {
      if (!item || typeof item !== "object") continue;
      const text = clean(item.text, 120);
      const at = Number(item.at);
      if (!text || !Number.isFinite(at)) continue;
      entries.push({
        id: clean(String(item.id || randomId()), 24),
        at,
        text,
        kind: KINDS.has(item.kind) ? item.kind : "quiet",
      });
    }
  }

  startSession(elapsed, entries);
}

/* ---------- Chat ---------- */

let toastTimer = null;

function showToast(name, text) {
  const who = document.createElement("b");
  who.textContent = name;
  toast.replaceChildren(who, document.createTextNode(text));
  toast.hidden = true;
  void toast.offsetWidth; // restart the animation
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

function resetChat() {
  const empty = document.createElement("li");
  empty.className = "chat-empty";
  empty.textContent = "No messages yet. Say something kind.";
  chatList.replaceChildren(empty);
  chatDot.hidden = true;
}

function addChat({ name, text, mine }) {
  const empty = chatList.querySelector(".chat-empty");
  if (empty) empty.remove();

  const nearBottom =
    chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;

  const item = document.createElement("li");
  item.className = "msg" + (mine ? " mine" : "");
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = mine ? "You" : name;
  const body = document.createElement("div");
  body.className = "text";
  body.textContent = text;
  item.append(who, body);
  chatList.append(item);

  if (mine || nearBottom) chatList.scrollTop = chatList.scrollHeight;

  if (!mine && chatSheet.hidden) {
    chatDot.hidden = false;
    showToast(name, text);
  }
}

function openChat() {
  chatSheet.hidden = false;
  chatDot.hidden = true;
  toast.hidden = true;
  chatList.scrollTop = chatList.scrollHeight;
  chatInput.focus({ preventScroll: true });
}

function closeChat() {
  chatSheet.hidden = true;
}

/* ---------- Action keys: Metta, Boon, Rejoice ---------- */

const KINDS = new Set(["start", "end", "metta", "boon", "rejoice", "quiet"]);

const ACTIONS = {
  metta: { did: "shared Metta", text: "May all living beings be happy" },
  boon: { did: "shared Boon", text: "Sharing Boon" },
  rejoice: { did: "rejoiced in Boon", text: "🙏✨ Sadhuuu" },
};

const glowTimers = new Map();
const lastSent = {};

function setActionsOpen(open) {
  actions.classList.toggle("open", open);
  actionsToggle.setAttribute("aria-expanded", String(open));
  actionsToggle.setAttribute(
    "aria-label",
    open ? "Close action keys" : "Open action keys",
  );
}

function sendAction(kind) {
  if (!room) return;
  const now = Date.now();
  if (now - (lastSent[kind] || 0) < ACTION_COOLDOWN_MS) return;
  lastSent[kind] = now;
  broadcast({ t: "action", kind });
}

function floatText(kind, text, x, y) {
  const element = document.createElement("div");
  element.className = "float-text " + kind;
  element.textContent = text;
  if (kind !== "rejoice") {
    const margin = 120;
    element.style.left =
      Math.min(Math.max(x, margin), window.innerWidth - margin) + "px";
    element.style.top = Math.max(y, 24) + "px";
  }
  fx.append(element);
  setTimeout(() => element.remove(), FLOAT_MS);
}

function doAction(kind, from, isLocal) {
  const action = ACTIONS[kind];
  const name = from.name || "Guest";
  const card = isLocal
    ? localPerson
    : document.getElementById("remote-" + from.identity);

  if (kind === "rejoice") {
    floatText("rejoice", action.text);
  } else {
    let x = window.innerWidth / 2;
    let y = window.innerHeight * 0.4;
    if (card) {
      const rect = card.querySelector(".avatar").getBoundingClientRect();
      x = rect.left + rect.width / 2;
      y = rect.top - 34;

      const cls = "glow-" + kind;
      card.classList.remove("glow-metta", "glow-boon");
      void card.offsetWidth; // restart the glow if it was already going
      card.classList.add(cls);
      clearTimeout(glowTimers.get(card));
      glowTimers.set(
        card,
        setTimeout(() => card.classList.remove(cls), GLOW_MS),
      );
    }
    floatText(kind, action.text, x, y);
  }

  if (session.running) addTimeline(`${name} ${action.did}`, kind);
}

/* ---------- The session: one meditation for everyone ---------- */

function elapsedNow() {
  return session.running
    ? Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000))
    : session.final;
}

function makeTimelineItem(entry) {
  const item = document.createElement("li");
  item.className = "tl-item " + entry.kind;
  const time = document.createElement("span");
  time.className = "tl-time";
  time.textContent = formatTime(entry.at);
  const text = document.createElement("span");
  text.className = "tl-text";
  text.textContent = entry.text;
  item.append(time, text);
  return item;
}

function renderTimeline() {
  timelineList.hidden = timeline.length === 0;
  timelineList.replaceChildren(
    ...timeline.slice(-4).map((entry) => makeTimelineItem(entry)),
  );
}

function addTimeline(text, kind, at = elapsedNow()) {
  const entry = { id: randomId(), at, text, kind };
  timeline.push(entry);
  if (timeline.length > MAX_TIMELINE) timeline.shift();

  timelineList.hidden = false;
  timelineList.append(makeTimelineItem(entry));
  while (timelineList.children.length > 4) timelineList.firstChild.remove();
}

function renderClock() {
  const t = elapsedNow();
  clock.textContent = formatTime(t);
  // The liquid in the moon rises slowly as the meditation goes on.
  if (session.running && window.sanctuaryOrb) {
    window.sanctuaryOrb.setProgress(1 - Math.exp(-t / 1500));
  }
}

function updateSessionUi() {
  const connected = !!room;
  sessionButton.disabled = !connected;
  sessionButton.dataset.state = session.running ? "running" : "ready";
  sessionButton.textContent = session.running ? "End meditation" : "Begin together";

  if (!connected) {
    timerState.textContent = "Join the room to begin together";
  } else if (session.running) {
    timerState.textContent = "A quiet moment together";
  } else if (session.final > 0) {
    timerState.textContent = "Session complete";
  } else {
    timerState.textContent = "Ready when you are";
  }

  clock.textContent = formatTime(elapsedNow());
  if (window.sanctuaryOrb) window.sanctuaryOrb.setActive(session.running);
}

function startSession(elapsed, entries) {
  clearInterval(tick);
  hideSummary();
  session.running = true;
  session.startedAt = Date.now() - elapsed * 1000;
  session.final = 0;

  if (entries) {
    timeline = entries;
    renderTimeline();
  } else {
    timeline = [];
    timelineList.replaceChildren();
    addTimeline("Meditation began", "start", 0);
  }

  if (window.sanctuaryOrb) window.sanctuaryOrb.setProgress(0);
  renderClock();
  updateSessionUi();
  tick = setInterval(renderClock, 250);
}

function endSession(elapsed) {
  clearInterval(tick);
  session.running = false;
  session.final = Math.max(1, Math.round(elapsed));
  addTimeline("Meditation ended", "end", session.final);
  renderClock();
  updateSessionUi();
  showSummary(session.final);
}

// Leaving the room drops the session on this device without a summary.
function resetSession() {
  clearInterval(tick);
  session.running = false;
  session.final = 0;
  timeline = [];
  timelineList.replaceChildren();
  timelineList.hidden = true;
  hideSummary();
  if (window.sanctuaryOrb) window.sanctuaryOrb.setProgress(0);
  updateSessionUi();
}

function showSummary(seconds) {
  const minutes = Math.round(seconds / 60);
  sumTitle.textContent =
    minutes < 1
      ? "We sat together for a moment!"
      : `We meditated ${minutes} minute${minutes === 1 ? "" : "s"}!`;
  sumTimeline.replaceChildren(...timeline.map((entry) => makeTimelineItem(entry)));
  summary.hidden = false;
  $("sumClose").focus({ preventScroll: true });
}

function hideSummary() {
  summary.hidden = true;
}

function toggleSession() {
  if (!room) return;
  if (session.running) {
    broadcast({ t: "end", elapsed: elapsedNow() });
  } else {
    broadcast({ t: "start" });
  }
}

/* ---------- Room lifecycle ---------- */

function resetLocalUi() {
  video.srcObject = null;
  showLocalVideo(false);
  clearRemote();
  updateCount();
  localPerson.classList.remove("speaking", "glow-metta", "glow-boon");
  fx.replaceChildren();
  micEnabled = false;
  cameraEnabled = false;
  setMicLabel(true); // the bubbles look "on" until you join
  setCameraLabel(true);
  resetChat();
  resetSession();
}

function wireRoomEvents(activeRoom) {
  activeRoom.on(RoomEvent.TrackSubscribed, attachRemoteTrack);

  activeRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
    track.detach().forEach((element) => element.remove());
    refreshMedia();
  });

  // When someone turns their camera off, show their photo again.
  const setRemoteVideoHidden = (publication, participant, hidden) => {
    if (publication.kind !== Track.Kind.Video) return;
    const card = document.getElementById("remote-" + participant.identity);
    const remoteVideo = card && card.querySelector("video");
    if (remoteVideo) remoteVideo.hidden = hidden;
    const face = card && card.querySelector(".camera-placeholder");
    if (face && !card.querySelector(".avatar-photo")) face.hidden = !hidden;
  };
  activeRoom.on(RoomEvent.TrackMuted, (publication, participant) => {
    setRemoteVideoHidden(publication, participant, true);
    refreshMedia();
  });
  activeRoom.on(RoomEvent.TrackUnmuted, (publication, participant) => {
    setRemoteVideoHidden(publication, participant, false);
    refreshMedia();
  });
  for (const event of [
    RoomEvent.TrackPublished,
    RoomEvent.TrackUnpublished,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
  ]) {
    activeRoom.on(event, refreshMedia);
  }

  activeRoom.on(RoomEvent.ParticipantConnected, (participant) => {
    participantCard(participant);
    updateCount();
    if (session.running) {
      addTimeline(`${participant.name || "Someone"} joined`, "quiet");
    }
  });

  activeRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
    const card = document.getElementById("remote-" + participant.identity);
    if (card) card.remove();
    updateCount();
    if (session.running) {
      addTimeline(`${participant.name || "Someone"} left`, "quiet");
    }
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

  activeRoom.on(RoomEvent.DataReceived, onDataReceived);
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
  message.textContent = "Connecting to the room…";

  try {
    const data = await fetchToken(participantName);

    room = new Room({ adaptiveStream: true, dynacast: true });
    wireRoomEvents(room);

    await room.connect(data.url, data.token);

    localName.textContent = participantName;
    placeholder.textContent = initialOf(participantName);
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
    resetChat();
    setControls(true);

    // Ask whoever is already here for the meditation in progress, if any.
    send({ t: "hello" });

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

    message.textContent = problems.length
      ? `You're connected, but the ${problems.join(" and ")} couldn't start. Check your browser permissions, then use the bubbles.`
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
    } else {
      showLocalVideo(false);
    }
  } catch (error) {
    message.textContent = "Camera issue: " + error.message;
  }
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

/* ---------- Bubbles and the quiet view ---------- */

// The room bubbles stack into one handle so the room opens right out.
function setRailMinimized(minimized) {
  controls.classList.toggle("min", minimized);
  document.body.classList.toggle("rail-min", minimized);
  railToggle.setAttribute("aria-expanded", String(!minimized));
  railToggle.setAttribute(
    "aria-label",
    minimized ? "Show controls" : "Minimize controls",
  );
}

// Tap empty space while in the room to hide or show the whole interface.
function setUiHidden(hidden) {
  document.body.classList.toggle("ui-hidden", hidden);
}

document.addEventListener("click", (event) => {
  if (!document.body.classList.contains("in-room")) return;
  if (event.target.closest("button, input, a, nav, .person, .sheet, .summary")) {
    return;
  }
  setUiHidden(!document.body.classList.contains("ui-hidden"));
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!summary.hidden) hideSummary();
  else if (!chatSheet.hidden) closeChat();
});

/* ---------- Wiring ---------- */

railToggle.addEventListener("click", () =>
  setRailMinimized(!controls.classList.contains("min")),
);
actionsToggle.addEventListener("click", () =>
  setActionsOpen(!actions.classList.contains("open")),
);
$("actMetta").addEventListener("click", () => sendAction("metta"));
$("actBoon").addEventListener("click", () => sendAction("boon"));
$("actRejoice").addEventListener("click", () => sendAction("rejoice"));

joinButton.addEventListener("click", joinRoom);
micButton.addEventListener("click", toggleMic);
cameraButton.addEventListener("click", toggleCamera);
sessionButton.addEventListener("click", toggleSession);
leaveButton.addEventListener("click", leaveRoom);

chatToggle.addEventListener("click", () =>
  chatSheet.hidden ? openChat() : closeChat(),
);
$("chatClose").addEventListener("click", closeChat);
chatForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = clean(chatInput.value, 500);
  if (!text || !room) return;
  chatInput.value = "";
  broadcast({ t: "chat", text });
});

$("sumClose").addEventListener("click", hideSummary);

window.addEventListener("beforeunload", () => {
  if (room) room.disconnect();
});

resetChat();
setMicLabel(true);
setCameraLabel(true);
updateSessionUi();
initLine();
