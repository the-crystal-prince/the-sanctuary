// The lotus: a transparent video on a continuous loop.
//
// It opens the app, centred over the night sky, until someone taps (or presses
// a key). Then it glides down and keeps looping under the moon, for as long as
// the room is open.
//
// Two files are tried, best match first:
//   lotus/lotus.mov   for Apple devices (iPhone, iPad, Mac Safari), which every
//                     browser on iOS and iPadOS is built on, LINE included
//   lotus/lotus.webm  VP9 with alpha: Chrome, Android, desktop Firefox
// Address options for testing:
//   ?intro=off   skip the opening, go straight to the room
//   ?intro=webm  or  ?intro=mov   try just that file
//   ?lotus=off   no lotus at all

const body = document.body;
const intro = document.getElementById("intro");
const note = document.getElementById("introNote");
const lotus = document.getElementById("lotus");
const video = document.getElementById("lotusVideo");

const SOURCES = [
  { name: "webm", src: "lotus/lotus.webm", type: 'video/webm; codecs="vp9"' },
  { name: "mov", src: "lotus/lotus.mov", type: "video/quicktime" },
];
const START_TIMEOUT_MS = 8000; // give up on a file if it hasn't started by then

// The video frame is mostly empty; the box is cropped to the lotus (see style.css).
const ASPECT = 1.16; // width / height of that crop
const HEAD_OFFSET = 0.1216; // how far below the box centre the bloom's heart sits, in box widths
const ROOM_SCALE = 2.5; // lotus width, in sphere-wrapper widths, under the moon

const params = new URLSearchParams(location.search);
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let phase = "intro"; // "intro", then "room"
let playing = false;
let startTimer = null;
let lastBox = "";

/* ---------- Where the lotus sits ---------- */

function introBox() {
  const width = Math.min(window.innerWidth * 0.86, 560);
  const height = width / ASPECT;
  return {
    left: (window.innerWidth - width) / 2,
    top: Math.max(8, (window.innerHeight - height) / 2 - window.innerHeight * 0.03),
    width,
    height,
  };
}

// Centred on the moon, with the heart of the bloom behind it and the petals around.
function roomBox() {
  const orb = document.querySelector(".orb-wrap");
  if (!orb) return introBox();
  const rect = orb.getBoundingClientRect();
  if (!rect.width) return introBox();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const width = Math.min(rect.width * ROOM_SCALE, window.innerWidth * 0.94);
  const height = width / ASPECT;
  return { left: cx - width / 2, top: cy + HEAD_OFFSET * width - height / 2, width, height };
}

function place(box) {
  const key = [box.left, box.top, box.width, box.height].map((n) => Math.round(n * 10)).join();
  if (key === lastBox) return;
  lastBox = key;
  lotus.style.left = box.left + "px";
  lotus.style.top = box.top + "px";
  lotus.style.width = box.width + "px";
  lotus.style.height = box.height + "px";
}

// In the room the moon moves (it shrinks on joining, the layout shifts), so follow it.
function follow() {
  if (phase === "room") place(roomBox());
  requestAnimationFrame(follow);
}

/* ---------- Choosing and playing the file ---------- */

// iPhone, iPad (which reports itself as a Mac), and Safari on Mac.
function isAppleWebKit() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Android|Edg/.test(ua);
}

function chooseSources() {
  const wanted = params.get("intro");
  let list = SOURCES.slice();
  if (wanted === "webm" || wanted === "mov") {
    list = list.filter((item) => item.name === wanted);
  } else if (isAppleWebKit()) {
    list.reverse(); // the mov first; the webm only if the mov can't play
  }
  // Only try files this browser says it can play.
  return list.filter((item) => video.canPlayType(item.type) !== "");
}

function playFrom(queue, onPlaying, onGiveUp) {
  const tryNext = () => {
    const item = queue.shift();
    if (!item) {
      onGiveUp();
      return;
    }
    clearTimeout(startTimer);
    startTimer = setTimeout(tryNext, START_TIMEOUT_MS);
    video.onerror = tryNext;
    video.onplaying = () => {
      clearTimeout(startTimer);
      onPlaying(item);
    };
    video.src = item.src;
    video.load();
    const started = video.play();
    if (started && typeof started.catch === "function") {
      // Autoplay refused: carry on without the lotus rather than show a frozen frame.
      started.catch((error) => {
        if (error && error.name === "NotAllowedError") onGiveUp();
      });
    }
  };
  tryNext();
}

/* ---------- Opening, then settling under the moon ---------- */

function enterRoom() {
  if (phase === "room") return;
  phase = "room";
  clearTimeout(startTimer);

  if (playing && !reduceMotion) lotus.classList.add("gliding");
  place(roomBox());
  if (lotus.classList.contains("gliding")) {
    setTimeout(() => lotus.classList.remove("gliding"), 1500);
  }

  intro.classList.add("leaving");
  body.classList.remove("intro-on");
  setTimeout(() => intro.remove(), 1000);
}

function onLotusPlaying(item) {
  playing = true;
  lotus.classList.add("ready");
  note.textContent = `Intro: ${item.name} · tap to enter`;
  if (reduceMotion) {
    // A still frame instead of movement.
    video.pause();
    video.currentTime = 1.6;
  }
}

function giveUp() {
  // No file plays here: the room simply appears without the lotus.
  video.removeAttribute("src");
  enterRoom();
  body.classList.remove("has-lotus");
}

function start() {
  window.__introStarted = true;

  const queue = params.get("lotus") === "off" || !lotus || !video ? [] : chooseSources();
  if (queue.length === 0) {
    body.classList.remove("intro-on");
    intro.remove();
    return;
  }

  const skipOpening = params.get("intro") === "off" || reduceMotion;

  // Make room under the moon from the start, so nothing shifts when the room appears.
  body.classList.add("has-lotus");

  place(skipOpening ? roomBox() : introBox());
  requestAnimationFrame(follow);

  window.addEventListener("resize", () => {
    if (phase === "intro") place(introBox());
  });
  // Don't spin a video nobody can see.
  document.addEventListener("visibilitychange", () => {
    if (!playing || reduceMotion) return;
    if (document.hidden) video.pause();
    else video.play().catch(() => {});
  });

  if (skipOpening) {
    enterRoom();
  } else {
    intro.addEventListener("click", enterRoom);
    window.addEventListener("keydown", enterRoom, { once: true });
  }

  playFrom(queue, onLotusPlaying, giveUp);
}

if (intro && lotus && video) start();
else {
  window.__introStarted = true;
  body.classList.remove("intro-on");
}
