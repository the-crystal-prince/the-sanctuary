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

// Each session gets one of these. The first is a gentle red.
const PALETTE = [
  "255,107,107", // red
  "255,184,77", // amber
  "92,214,140", // green
  "77,208,225", // teal
  "176,140,255", // violet
  "108,160,255", // blue
];
const DEFAULT_ME = "170,195,255";

let room = null;
let connecting = false;
let micEnabled = false;
let cameraEnabled = false;
let liffReady = false;
let liffId = null;
let lineProfile = null; // { displayName, pictureUrl } when signed in with LINE
let idToken = null; // sent to the server so it can verify who you are
let nameLocked = false;
let ytApi = null; // resolves once YouTube's player script has loaded
let ytPlayer = null;
let musicTicket = 0; // bumped on every stop, so a slow load can't start late

// Everyone's clocks are lined up to the server's, so timers agree.
let clockOffset = 0;
const syncedNow = () => Date.now() + clockOffset;

// The meditation I am in, if any. Others see it through my participant attributes.
let mySession = null; // { id, c, t, k, by, title, joinedAt }
let timeline = [];
let together = new Map(); // identity -> { name, picture }
let lastMembers = null; // identity -> member, to notice who joins and leaves
let lastSummary = null;
let tick = null;
let cardSid = null; // session shown in the glass card

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
const dock = $("dock");
const dockJoin = $("dockJoin");
const joinBadge = $("joinBadge");
const joinList = $("joinList");
const sessCard = $("sessCard");
const musicToggle = $("musicToggle");
const musicCard = $("musicCard");
const musicForm = $("musicForm");
const musicInput = $("musicInput");
const musicStage = $("musicStage");
const musicNote = $("musicNote");
const chatSheet = $("chatSheet");
const chatList = $("chatList");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const fx = $("fx");
const toast = $("toast");
const summary = $("summary");
const sumTitle = $("sumTitle");
const sumTimeline = $("sumTimeline");
const sumShare = $("sumShare");

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

const rgbOf = (c) => PALETTE[Math.abs(Number(c) || 0) % PALETTE.length];

// Only LINE profile pictures are ever loaded.
function isLinePicture(url) {
  return typeof url === "string" && url.startsWith("https://profile.line-scdn.net/");
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
  musicToggle.disabled = !connected;
  leaveButton.disabled = !connected;
  joinButton.disabled = connected || connecting;
  joinButton.textContent = connecting ? "Joining…" : "Join";
  nameInput.disabled = connected || connecting || nameLocked;
  document.body.classList.toggle("in-room", connected);
  if (!connected) {
    // Leaving the room always brings the interface back.
    document.body.classList.remove("ui-hidden");
    closeChat();
    closeMusic();
    closeSessCard();
    closeJoinList();
    setActionsOpen(false);
  }
  refreshSessions();
}

function setAvatarPhoto(avatar, url) {
  if (!isLinePicture(url)) return;
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

/* ---------- Shared messages (LiveKit data channel): chat and blessings ---------- */

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
    case "action":
      // Blessings are for the people in the same session.
      if (ACTIONS[msg.kind] && mySession && msg.sid === mySession.id) {
        doAction(msg.kind, from, isLocal);
      }
      break;
    default:
  }
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

/* ---------- Action keys: Metta, Boon, Rejoice (for your session) ---------- */

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
  if (!room || !mySession) return;
  const now = Date.now();
  if (now - (lastSent[kind] || 0) < ACTION_COOLDOWN_MS) return;
  lastSent[kind] = now;
  broadcast({ t: "action", kind, sid: mySession.id });
  // The keys tuck back into the lotus so the dock (and End) comes back.
  setTimeout(() => setActionsOpen(false), 700);
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

  addTimeline(`${name} ${action.did}`, kind);
}

/* ---------- Sessions: each person's own meditation, visible to everyone ---------- */

// A session lives in its members' participant attributes, so anyone arriving
// later sees it straight away and nothing has to be stored on the server.
function parseSession(attrs) {
  if (!attrs || !attrs.sid || !attrs.sdata) return null;
  try {
    const data = JSON.parse(attrs.sdata);
    const t = Number(data.t);
    if (!Number.isFinite(t)) return null;
    return {
      id: clean(String(attrs.sid), 24),
      c: Number.isInteger(data.c) ? data.c : 0,
      t,
      k: clean(String(data.k || "timer"), 12),
      by: clean(String(data.by || ""), 50),
      title: clean(String(data.title || ""), 80),
    };
  } catch {
    return null;
  }
}

function elapsedOf(session) {
  return Math.max(0, Math.floor((syncedNow() - session.t) / 1000));
}

function myMember() {
  return {
    identity: room ? room.localParticipant.identity : "me",
    name: (room && room.localParticipant.name) || nameInput.value.trim() || "You",
    picture: lineProfile ? lineProfile.pictureUrl : null,
    isLocal: true,
  };
}

// Every running session, oldest first, with who is in it.
function getSessions() {
  const map = new Map();
  const add = (info, member) => {
    if (!info) return;
    let entry = map.get(info.id);
    if (!entry) {
      entry = { ...info, members: [] };
      map.set(info.id, entry);
    }
    entry.members.push(member);
  };
  if (mySession) add(mySession, myMember());
  if (room) {
    for (const participant of room.remoteParticipants.values()) {
      add(parseSession(participant.attributes), {
        identity: participant.identity,
        name: participant.name || "Guest",
        picture: pictureFromMetadata(participant),
        isLocal: false,
      });
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function pickColor() {
  const used = new Set(getSessions().map((s) => s.c % PALETTE.length));
  for (let i = 0; i < PALETTE.length; i++) if (!used.has(i)) return i;
  return getSessions().length % PALETTE.length;
}

async function publishSession(session) {
  if (!room) return;
  const attrs = session
    ? {
        sid: session.id,
        sdata: JSON.stringify({
          c: session.c,
          t: session.t,
          k: session.k,
          by: session.by,
          title: session.title || "",
        }),
      }
    : { sid: "", sdata: "" };
  await room.localParticipant.setAttributes(attrs);
}

function sessionLabel(session) {
  if (session.k === "timer") return "Timer only";
  return session.title ? `Listening to ${session.title}` : "Guided session";
}

function ownerName(session) {
  return session.by || "Someone";
}

function addTimeline(text, kind, at) {
  if (!mySession) return;
  const entry = {
    id: randomId(),
    at: at === undefined ? elapsedOf(mySession) : at,
    text,
    kind,
  };
  timeline.push(entry);
  if (timeline.length > MAX_TIMELINE) timeline.shift();

  timelineList.hidden = false;
  timelineList.append(makeTimelineItem(entry));
  while (timelineList.children.length > 4) timelineList.firstChild.remove();
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

function setOrb(active, progress) {
  if (!window.sanctuaryOrb) return;
  window.sanctuaryOrb.setActive(active);
  if (progress !== undefined) window.sanctuaryOrb.setProgress(progress);
}

function renderClock() {
  if (!mySession) return;
  const t = elapsedOf(mySession);
  clock.textContent = formatTime(t);
  // The liquid in the moon rises slowly as the meditation goes on.
  if (window.sanctuaryOrb) {
    window.sanctuaryOrb.setProgress(1 - Math.exp(-t / 1500));
  }
}

// Runs twice a second while you are in the room: the clock and any open lists.
function secondTick() {
  renderClock();
  if (!joinList.hidden) {
    joinList.querySelectorAll(".jl-sub").forEach((el) => {
      el.textContent = subLine(Number(el.dataset.t), Number(el.dataset.n), el.dataset.k);
    });
  }
  if (!sessCard.hidden) refreshSessCard();
}

function subLine(t, n, kind) {
  const label = kind === "timer" ? "Timer only" : "Guided";
  const time = formatTime(Math.max(0, (syncedNow() - t) / 1000));
  return `${time} · ${label} · ${n} ${n === 1 ? "person" : "people"}`;
}

// Start a meditation of my own, or join one that is already running.
async function enterSession(session, starting) {
  if (!room) return;
  if (mySession && mySession.id === session.id) return;
  if (mySession) teardownLocalSession(); // switching: leave the old one quietly

  closeJoinList();
  closeSessCard();

  mySession = { ...session, joinedAt: syncedNow() };
  together = new Map([[myMember().identity, myMember()]]);
  lastMembers = null;
  timeline = [];
  timelineList.replaceChildren();
  addTimeline("Meditation began", "start", 0);
  if (!starting) addTimeline("You joined", "quiet", elapsedOf(mySession));

  document.body.style.setProperty("--me", rgbOf(session.c));
  setOrb(true, 0);
  renderClock();
  message.textContent = "You'll hear the people in this session, and they'll hear you.";
  refreshSessions();

  try {
    await publishSession(session);
  } catch (error) {
    console.error(error);
    teardownLocalSession();
    message.textContent = "Couldn't start the session. Please try again.";
    refreshSessions();
  }
}

function startSession() {
  if (!room || mySession) return;
  enterSession(
    {
      id: randomId() + randomId().slice(0, 4),
      c: pickColor(),
      t: syncedNow(),
      k: "timer",
      by: myMember().name,
      title: "",
    },
    true,
  );
}

function joinSession(session) {
  enterSession(
    {
      id: session.id,
      c: session.c,
      t: session.t,
      k: session.k,
      by: session.by,
      title: session.title,
    },
    false,
  );
}

// Drops my session on this device (no card). Used when ending, switching or leaving.
function teardownLocalSession() {
  mySession = null;
  lastMembers = null;
  timeline = [];
  timelineList.replaceChildren();
  timelineList.hidden = true;
  document.body.style.setProperty("--me", DEFAULT_ME);
  document.body.classList.remove("in-session");
  setActionsOpen(false);
  setOrb(false, 0);
}

async function endMySession() {
  if (!mySession) return;
  const session = mySession;
  const seconds = Math.max(1, Math.round((syncedNow() - session.joinedAt) / 1000));
  addTimeline("Meditation ended", "end", elapsedOf(session));

  const data = {
    seconds,
    together: [...together.values()],
    timeline: timeline.slice(),
  };

  teardownLocalSession();
  message.textContent = "Begin or join a session whenever you're ready.";
  refreshSessions();
  showSummary(data);

  try {
    await publishSession(null);
  } catch (error) {
    console.error(error);
  }
  refreshSessions();
}

// One place that brings everything on screen in line with who is meditating.
function refreshSessions() {
  const sessions = getSessions();
  const byId = new Map(sessions.map((s) => [s.id, s]));

  // Each person glows in the colour of the session they are in.
  const mark = (card, info) => {
    if (!card) return;
    if (info) {
      card.classList.add("in-sess");
      card.style.setProperty("--sc", rgbOf(info.c));
      card.dataset.sid = info.id;
    } else {
      card.classList.remove("in-sess");
      card.style.removeProperty("--sc");
      delete card.dataset.sid;
    }
  };
  mark(localPerson, mySession);
  if (room) {
    for (const participant of room.remoteParticipants.values()) {
      mark(
        document.getElementById("remote-" + participant.identity),
        parseSession(participant.attributes),
      );
    }
  }

  // Who has joined or left the session I am in.
  if (mySession) {
    const mine = byId.get(mySession.id);
    const current = new Map();
    if (mine) {
      for (const member of mine.members) {
        if (!member.isLocal) current.set(member.identity, member);
      }
    }
    for (const [id, member] of current) {
      together.set(id, { name: member.name, picture: member.picture });
      if (lastMembers && !lastMembers.has(id)) {
        addTimeline(`${member.name} joined`, "quiet");
      }
    }
    if (lastMembers) {
      for (const [id, member] of lastMembers) {
        if (!current.has(id)) addTimeline(`${member.name} left`, "quiet");
      }
    }
    lastMembers = current;
  }

  updateDock(sessions);
  updateStateText(sessions, byId);
  applyRouting();
  refreshSessCard();
}

function updateStateText(sessions, byId) {
  if (!room) {
    timerState.textContent = "Join the room to meditate together";
    return;
  }
  if (mySession) {
    const mine = byId.get(mySession.id);
    const n = mine ? mine.members.length : 1;
    timerState.textContent = n > 1 ? `Meditating together · ${n}` : "A quiet moment";
    return;
  }
  const n = sessions.reduce((sum, s) => sum + s.members.length, 0);
  timerState.textContent = n ? `${n} meditating now` : "The room is quiet";
}

/* ---------- The dock: Meditate / Start / Join / End ---------- */

function updateDock(sessions) {
  document.body.classList.toggle("in-session", !!mySession);

  let mode = "hidden";
  if (room) {
    if (mySession) mode = "session";
    else if (sessions.length === 0) mode = "solo";
    else mode = "choose";
  }
  if (dock.dataset.mode !== mode) {
    dock.dataset.mode = mode;
    closeJoinList();
  }

  joinBadge.textContent = String(sessions.length);
  if (!joinList.hidden) {
    if (sessions.length === 0) closeJoinList();
    else renderJoinList(sessions);
  }
}

function renderJoinList(sessions) {
  joinList.replaceChildren(
    ...sessions.map((session, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "jl-item";
      item.setAttribute("role", "menuitem");
      item.style.setProperty("--sc", rgbOf(session.c));
      item.style.animationDelay = index * 60 + "ms";

      const dot = document.createElement("span");
      dot.className = "jl-dot";

      const text = document.createElement("span");
      const name = document.createElement("span");
      name.className = "jl-name";
      name.textContent = `${ownerName(session)}'s session`;
      const sub = document.createElement("span");
      sub.className = "jl-sub";
      sub.dataset.t = String(session.t);
      sub.dataset.n = String(session.members.length);
      sub.dataset.k = session.k;
      sub.textContent = subLine(session.t, session.members.length, session.k);
      text.append(name, sub);

      const badge = document.createElement("span");
      badge.className = "jl-count";
      badge.textContent = String(session.members.length);

      item.append(dot, text, badge);
      item.addEventListener("click", () => joinSession(session));
      return item;
    }),
  );
}

function openJoinList() {
  const sessions = getSessions();
  if (!sessions.length) return;
  renderJoinList(sessions);
  joinList.hidden = false;
  dockJoin.setAttribute("aria-expanded", "true");
}

function closeJoinList() {
  joinList.hidden = true;
  dockJoin.setAttribute("aria-expanded", "false");
}

/* ---------- Tap a glowing person: a small glass card about their session ---------- */

function sessionForCard(card) {
  const sid = card && card.dataset.sid;
  return sid ? getSessions().find((s) => s.id === sid) || null : null;
}

function openSessCard(session, anchor) {
  cardSid = session.id;
  sessCard.hidden = false;
  fillSessCard(session);

  const rect = anchor.getBoundingClientRect();
  const width = 236;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - width / 2, 12),
    window.innerWidth - width - 12,
  );
  let top = rect.bottom + 10;
  if (top + 190 > window.innerHeight) top = Math.max(12, rect.top - 200);
  sessCard.style.left = left + "px";
  sessCard.style.top = top + "px";
}

function fillSessCard(session) {
  sessCard.style.setProperty("--sc", rgbOf(session.c));
  $("scTitle").textContent = `${ownerName(session)}'s session`;
  $("scWhat").textContent = sessionLabel(session);
  const n = session.members.length;
  $("scMeta").textContent =
    `${formatTime(elapsedOf(session))} · ${n} meditating` +
    (n > 1 ? ": " + session.members.map((m) => m.name).join(", ") : "");

  const joinBtn = $("scJoin");
  const mine = mySession && mySession.id === session.id;
  joinBtn.hidden = !!mine;
  joinBtn.textContent = mySession ? "Switch to this session" : "Join session";
  if (mine) $("scMeta").textContent += "\nYou're here";
}

function refreshSessCard() {
  if (sessCard.hidden) return;
  const session = getSessions().find((s) => s.id === cardSid);
  if (!session) closeSessCard();
  else fillSessCard(session);
}

function closeSessCard() {
  sessCard.hidden = true;
  cardSid = null;
}

/* ---------- Voices: you only hear the people in your session ---------- */

// Nobody's voice reaches you unless they are in the session you are in.
// Video circles stay on for everyone so you can see who is here.
function applyRouting() {
  if (!room) return;
  const mine = mySession && mySession.id;
  for (const participant of room.remoteParticipants.values()) {
    const theirs = parseSession(participant.attributes);
    const sameSession = !!mine && !!theirs && theirs.id === mine;
    for (const publication of participant.trackPublications.values()) {
      const want = publication.kind === Track.Kind.Audio ? sameSession : true;
      if (
        typeof publication.setSubscribed === "function" &&
        publication.isSubscribed !== want
      ) {
        publication.setSubscribed(want);
      }
    }
  }
}

/* ---------- The end card ---------- */

function faceNode(person) {
  const item = document.createElement("li");
  const face = document.createElement("div");
  face.className = "sum-face";
  face.textContent = initialOf(person.name);
  if (isLinePicture(person.picture)) {
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("load", () => (face.firstChild.textContent = ""));
    img.addEventListener("error", () => img.remove());
    img.src = person.picture;
    face.append(img);
  }
  const name = document.createElement("div");
  name.className = "sum-name";
  name.textContent = person.name;
  item.append(face, name);
  return item;
}

function summaryTitle(data) {
  const minutes = Math.round(data.seconds / 60);
  const group = data.together.length > 1;
  if (minutes < 1) return group ? "We sat together for a moment!" : "You sat for a moment!";
  const span = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return group ? `We meditated ${span}!` : `You meditated ${span}!`;
}

function showSummary(data) {
  lastSummary = data;
  sumTitle.textContent = summaryTitle(data);

  const group = data.together.length > 1;
  $("sumTogether").hidden = !group;
  $("sumFaces").replaceChildren(...data.together.map(faceNode));

  sumTimeline.replaceChildren(...data.timeline.map((entry) => makeTimelineItem(entry)));
  hideCardImage();
  summary.hidden = false;
  $("sumClose").focus({ preventScroll: true });
}

function hideSummary() {
  summary.hidden = true;
  hideCardImage();
}

function hideCardImage() {
  const img = $("sumImg");
  if (img.src.startsWith("blob:")) URL.revokeObjectURL(img.src);
  img.removeAttribute("src");
  img.hidden = true;
  $("sumHint").hidden = true;
}

function shareText(data) {
  const names = data.together.map((p) => p.name);
  const withLine =
    names.length > 1
      ? "With " + names.slice(0, -1).join(", ") + " & " + names[names.length - 1] + ". "
      : "";
  const link = liffId ? `\nhttps://liff.line.me/${liffId}` : "";
  return `${summaryTitle(data)} ${withLine}Sadhuuu 🙏✨ The Boon is Yours!${link}`;
}

function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const test = line ? line + " " + word : word;
    if (line && ctx.measureText(test).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Draws the card as a picture so it can be saved or sent anywhere.
async function renderCardImage(data) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  try {
    await Promise.all([
      document.fonts.load('800 64px "Hanken Grotesk"'),
      document.fonts.load('400 40px "Hanken Grotesk"'),
      document.fonts.load('italic 300 150px "Hanken Grotesk"'),
    ]);
  } catch {
    // the system font is used instead
  }
  const font = '"Hanken Grotesk", "Noto Sans Thai", system-ui, sans-serif';

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0a0f1d");
  bg.addColorStop(1, "#03050b");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const haze = ctx.createRadialGradient(W / 2, 270, 0, W / 2, 270, 560);
  haze.addColorStop(0, "rgba(150,175,230,0.34)");
  haze.addColorStop(1, "rgba(150,175,230,0)");
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, W, H);

  // Stars, always the same pattern.
  let seed = 7;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 110; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + rand() * 0.65})`;
    ctx.beginPath();
    ctx.arc(rand() * W, rand() * H, 0.8 + rand() * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // The moon.
  ctx.save();
  ctx.shadowColor = "rgba(190,210,255,0.85)";
  ctx.shadowBlur = 90;
  const moon = ctx.createRadialGradient(W / 2 - 40, 230, 10, W / 2, 270, 130);
  moon.addColorStop(0, "#ffffff");
  moon.addColorStop(0.6, "#e3e8f3");
  moon.addColorStop(1, "#a9b4cc");
  ctx.fillStyle = moon;
  ctx.beginPath();
  ctx.arc(W / 2, 270, 120, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  let y = 520;
  ctx.fillStyle = "#eef1f8";
  ctx.font = `800 72px ${font}`;
  for (const line of wrapLines(ctx, summaryTitle(data), 880)) {
    ctx.fillText(line, W / 2, y);
    y += 86;
  }

  const names = data.together.map((p) => p.name);
  if (names.length > 1) {
    y += 14;
    ctx.fillStyle = "#9aa3b8";
    ctx.font = `600 30px ${font}`;
    ctx.fillText("MEDITATED TOGETHER", W / 2, y);
    y += 24;
    ctx.fillStyle = "#dbe4f7";
    ctx.font = `400 44px ${font}`;
    const list =
      names.length > 2
        ? names.slice(0, -1).join(", ") + " & " + names[names.length - 1]
        : names.join(" & ");
    for (const line of wrapLines(ctx, list, 880)) {
      y += 56;
      ctx.fillText(line, W / 2, y);
    }
  }

  ctx.save();
  ctx.shadowColor = "rgba(255,214,140,0.6)";
  ctx.shadowBlur = 50;
  ctx.fillStyle = "#fff6dd";
  ctx.font = `italic 300 170px ${font}`;
  ctx.fillText("Sadhuuu", W / 2, Math.max(y + 200, 1000));
  ctx.restore();

  ctx.fillStyle = "#cfe0ff";
  ctx.font = `600 54px ${font}`;
  ctx.fillText("The Boon is Yours!", W / 2, Math.max(y + 200, 1000) + 90);

  ctx.fillStyle = "#6f7a94";
  ctx.font = `700 34px ${font}`;
  ctx.fillText("THE SANCTUARY", W / 2, H - 70);

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("No image"))),
      "image/png",
    ),
  );
}

function showCardImage(blob) {
  const img = $("sumImg");
  hideCardImage();
  img.src = URL.createObjectURL(blob);
  img.hidden = false;
  $("sumHint").hidden = false;
}

async function shareCard() {
  if (!lastSummary) return;
  sumShare.disabled = true;
  try {
    const blob = await renderCardImage(lastSummary);
    const text = shareText(lastSummary);
    const file = new File([blob], "sanctuary-meditation.png", { type: "image/png" });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text });
    } else if (
      liffReady &&
      liff.isApiAvailable &&
      liff.isApiAvailable("shareTargetPicker")
    ) {
      // Inside LINE: send the words to a chat or group.
      await liff.shareTargetPicker([{ type: "text", text }]);
    } else {
      showCardImage(blob);
    }
  } catch (error) {
    if (!(error && error.name === "AbortError")) {
      console.error(error);
      try {
        showCardImage(await renderCardImage(lastSummary));
      } catch {
        // nothing more to try
      }
    }
  } finally {
    sumShare.disabled = false;
  }
}

/* ---------- Shared clock ---------- */

async function syncClock() {
  let best = null;
  for (let i = 0; i < 4; i++) {
    const started = performance.now();
    try {
      const response = await fetch("/time", { cache: "no-store" });
      const data = await response.json();
      const rtt = performance.now() - started;
      const offset = data.now + rtt / 2 - Date.now();
      if (!best || rtt < best.rtt) best = { rtt, offset };
    } catch {
      // try again
    }
  }
  if (best) clockOffset = Math.round(best.offset);
}

/* ---------- Room lifecycle ---------- */

function resetLocalUi() {
  video.srcObject = null;
  showLocalVideo(false);
  clearRemote();
  updateCount();
  localPerson.classList.remove("speaking", "glow-metta", "glow-boon", "in-sess");
  localPerson.style.removeProperty("--sc");
  delete localPerson.dataset.sid;
  fx.replaceChildren();
  micEnabled = false;
  cameraEnabled = false;
  setMicLabel(true); // the bubbles look "on" until you join
  setCameraLabel(true);
  resetChat();
  clearInterval(tick);
  teardownLocalSession();
  hideSummary();
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
    RoomEvent.TrackUnpublished,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
  ]) {
    activeRoom.on(event, refreshMedia);
  }
  // New tracks are only listened to if they belong to my session.
  activeRoom.on(RoomEvent.TrackPublished, () => {
    refreshMedia();
    applyRouting();
  });

  activeRoom.on(RoomEvent.ParticipantConnected, (participant) => {
    participantCard(participant);
    updateCount();
    refreshSessions();
  });

  activeRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
    const card = document.getElementById("remote-" + participant.identity);
    if (card) card.remove();
    updateCount();
    refreshSessions();
  });

  activeRoom.on(RoomEvent.ParticipantAttributesChanged, refreshSessions);

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
    const [data] = await Promise.all([fetchToken(participantName), syncClock()]);

    // Nothing is listened to until we know which session (if any) is mine.
    room = new Room({ adaptiveStream: true, dynacast: true, autoSubscribe: false });
    wireRoomEvents(room);

    await room.connect(data.url, data.token);

    localName.textContent = participantName;
    placeholder.textContent = initialOf(participantName);
    if (lineProfile) {
      setAvatarPhoto(localPerson.querySelector(".avatar"), lineProfile.pictureUrl);
    }

    for (const participant of room.remoteParticipants.values()) {
      participantCard(participant);
    }

    updateCount();
    resetChat();
    clearInterval(tick);
    tick = setInterval(secondTick, 500);
    setControls(true); // also shows who is already meditating

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
      : "You're in the room. Begin or join a session when you're ready.";
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

// Tells the LINE chat that someone entered, so the bot can answer with its
// "has joined The Sanctuary!" card. The bot looks for these words in the text.
// Needs the "chat_message.write" scope, and only works when the page is opened
// from inside a LINE chat. Sent once per visit; failures are ignored.
const ENTRY_TEXT = "🕊️ Entering The Sanctuary";

async function announceEntry() {
  try {
    if (!liffReady || !liff.isInClient()) return;
    if (sessionStorage.getItem("sanctuaryAnnounced")) return;
    await liff.sendMessages([{ type: "text", text: ENTRY_TEXT }]);
    sessionStorage.setItem("sanctuaryAnnounced", "1");
  } catch (error) {
    console.error("Could not announce entry:", error);
  }
}

async function initLine() {
  try {
    const response = await fetch("/config");
    const config = await response.json();
    if (!config.liffId || !window.liff) return; // LINE login not set up: guests only
    liffId = config.liffId;

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
      announceEntry();
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

/* ---------- Music (YouTube) ---------- */

// Plays a YouTube video or playlist through YouTube's own embedded player.
// The player stays on screen while it plays (YouTube doesn't allow hiding the
// picture to play only the sound), and closing the card stops the music.

const MUSIC_NOTE = "Plays through YouTube's own player. Closing this stops it.";

function loadYouTubeApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) {
      resolve(window.YT);
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (previous) previous();
      resolve(window.YT);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      ytApi = null; // let the next try start fresh
      reject(new Error("YouTube couldn't be reached. Try again in a moment."));
    };
    document.head.appendChild(script);
  });
  return ytApi;
}

// Pulls a video and/or playlist out of whatever was pasted. Returns null if
// it isn't a YouTube link.
function parseYouTube(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (/^[\w-]{11}$/.test(value)) return { video: value, list: null };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
  } catch (error) {
    return null;
  }

  const host = url.hostname.replace(/^(www|m|music)\./, "");
  if (!["youtube.com", "youtu.be", "youtube-nocookie.com"].includes(host)) {
    return null;
  }

  let video = url.searchParams.get("v");
  if (!video && host === "youtu.be") video = url.pathname.slice(1).split("/")[0];
  if (!video) {
    const match = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    if (match) video = match[1];
  }
  if (video && !/^[\w-]{11}$/.test(video)) video = null;

  let list = url.searchParams.get("list");
  if (list && !/^[\w-]+$/.test(list)) list = null;

  return video || list ? { video, list } : null;
}

function stopMusic() {
  musicTicket++;
  if (ytPlayer) {
    try {
      ytPlayer.destroy();
    } catch (error) {
      // already gone
    }
    ytPlayer = null;
  }
  musicStage.replaceChildren();
  musicStage.hidden = true;
  musicToggle.classList.remove("playing");
}

function openMusic() {
  musicCard.hidden = false;
  musicToggle.setAttribute("aria-expanded", "true");
  if (!musicInput.value) {
    try {
      musicInput.value = localStorage.getItem("sanctuaryMusic") || "";
    } catch (error) {
      // remembering the last link is optional
    }
  }
}

function closeMusic() {
  stopMusic();
  musicCard.hidden = true;
  musicToggle.setAttribute("aria-expanded", "false");
  musicNote.textContent = MUSIC_NOTE;
}

async function playMusic(source) {
  const found = parseYouTube(source);
  if (!found) {
    musicNote.textContent = "That doesn't look like a YouTube link.";
    return;
  }

  try {
    localStorage.setItem("sanctuaryMusic", String(source).trim());
  } catch (error) {
    // remembering the last link is optional
  }

  stopMusic();
  const ticket = musicTicket;
  musicNote.textContent = "Loading…";

  let YT;
  try {
    YT = await loadYouTubeApi();
  } catch (error) {
    musicNote.textContent = error.message;
    return;
  }
  if (ticket !== musicTicket) return; // closed or replaced while loading

  const target = document.createElement("div");
  musicStage.append(target);
  musicStage.hidden = false;

  const playerVars = { autoplay: 1, playsinline: 1, rel: 0 };
  if (found.list) {
    playerVars.list = found.list;
    if (!found.video) playerVars.listType = "playlist";
  }

  ytPlayer = new YT.Player(target, {
    width: "100%",
    height: "100%",
    videoId: found.video || undefined,
    playerVars,
    events: {
      onReady: (event) => {
        event.target.playVideo();
        musicToggle.classList.add("playing");
        musicNote.textContent = MUSIC_NOTE;
      },
      onAutoplayBlocked: () => {
        musicNote.textContent = "Tap the video to start the music.";
      },
      onError: () => {
        stopMusic();
        musicNote.textContent = "YouTube can't play that one here. Try another link.";
      },
    },
  });
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
  const target = event.target;

  // Tapping away from an open card or list just closes it.
  if (!sessCard.hidden && !target.closest("#sessCard, .person")) {
    closeSessCard();
    return;
  }
  if (!joinList.hidden && !target.closest("#joinList, #dockJoin")) {
    closeJoinList();
    return;
  }

  if (!document.body.classList.contains("in-room")) return;
  if (
    target.closest(
      "button, input, a, nav, .person, .sheet, .summary, .sess-card, .music-card",
    )
  ) {
    return;
  }
  setUiHidden(!document.body.classList.contains("ui-hidden"));
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!summary.hidden) hideSummary();
  else if (!sessCard.hidden) closeSessCard();
  else if (!joinList.hidden) closeJoinList();
  else if (!chatSheet.hidden) closeChat();
  else if (!musicCard.hidden) closeMusic();
});

/* ---------- Wiring ---------- */

people.addEventListener("click", (event) => {
  const card = event.target.closest(".person");
  const session = sessionForCard(card);
  if (!session) return;
  if (!sessCard.hidden && cardSid === session.id) {
    closeSessCard();
    return;
  }
  closeJoinList();
  openSessCard(session, card);
});

$("scJoin").addEventListener("click", () => {
  const session = getSessions().find((s) => s.id === cardSid);
  if (session) joinSession(session);
});

$("dockMeditate").addEventListener("click", startSession);
$("dockStart").addEventListener("click", startSession);
$("dockEnd").addEventListener("click", endMySession);
dockJoin.addEventListener("click", () =>
  joinList.hidden ? openJoinList() : closeJoinList(),
);

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

musicToggle.addEventListener("click", () =>
  musicCard.hidden ? openMusic() : closeMusic(),
);
$("musicClose").addEventListener("click", closeMusic);
musicForm.addEventListener("submit", (event) => {
  event.preventDefault();
  playMusic(musicInput.value);
});

$("sumClose").addEventListener("click", hideSummary);
sumShare.addEventListener("click", shareCard);

window.addEventListener("beforeunload", () => {
  if (room) room.disconnect();
});

resetChat();
setMicLabel(true);
setCameraLabel(true);
refreshSessions();
initLine();
