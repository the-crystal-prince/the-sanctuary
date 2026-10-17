// Plays the transparent intro video on a continuous loop, on top of the night
// sky, until the person taps (or presses any key) to enter the room.
//
// Two files are tried, best match first:
//   intro/intro.mov   for Apple devices (iPhone, iPad, Mac Safari), which every
//                     browser on iOS and iPadOS is built on, LINE included
//   intro/intro.webm  VP9 with alpha: Chrome, Android, desktop Firefox
// Add ?intro=webm or ?intro=mov to the address to try just one, ?intro=off to skip.

const body = document.body;
const intro = document.getElementById("intro");
const video = document.getElementById("introVideo");
const note = document.getElementById("introNote");

const SOURCES = [
  { name: "webm", src: "intro/intro.webm", type: 'video/webm; codecs="vp9"' },
  { name: "mov", src: "intro/intro.mov", type: "video/quicktime" },
];
const START_TIMEOUT_MS = 6000; // give up if nothing has started playing by then

let finished = false;
let startTimer = null;

function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(startTimer);
  video.pause();
  intro.classList.add("leaving");
  body.classList.remove("intro-on");
  setTimeout(() => {
    intro.remove();
  }, 1000);
}

// iPhone, iPad (which reports itself as a Mac), and Safari on Mac.
function isAppleWebKit() {
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return true;
  return /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Android|Edg/.test(ua);
}

function chooseSources() {
  const wanted = new URLSearchParams(location.search).get("intro");
  if (wanted === "off") return [];
  let list = SOURCES.slice();
  if (wanted === "webm" || wanted === "mov") {
    list = list.filter((item) => item.name === wanted);
  } else if (isAppleWebKit()) {
    list.reverse(); // the mov first; the webm only if the mov can't play
  }
  // Only try files this browser says it can play.
  return list.filter((item) => video.canPlayType(item.type) !== "");
}

function start() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const queue = chooseSources();
  if (reduceMotion || queue.length === 0) {
    finish();
    return;
  }

  intro.addEventListener("click", finish);
  window.addEventListener("keydown", finish, { once: true });
  video.loop = true;

  const tryNext = () => {
    const item = queue.shift();
    if (!item) {
      finish();
      return;
    }
    clearTimeout(startTimer);
    startTimer = setTimeout(tryNext, START_TIMEOUT_MS);
    video.onerror = tryNext;
    video.onplaying = () => {
      clearTimeout(startTimer);
      video.classList.add("ready");
      note.textContent = `Intro: ${item.name} · tap to enter`;
    };
    video.src = item.src;
    video.load();
    const played = video.play();
    if (played && typeof played.catch === "function") {
      // Autoplay refused: skip rather than show a frozen frame.
      played.catch((error) => {
        if (error && error.name === "NotAllowedError") finish();
      });
    }
  };

  tryNext();
}

window.__introStarted = true;
if (intro && video) start();
else body.classList.remove("intro-on");
