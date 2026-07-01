const TRACKS = [
  {
    stem: "Vocals",
    audio: "./assets/audio/tracks/vocals.mp3",
    characterId: "vocal",
    character: "Charlie Brown",
    role: "Vocal",
    positionClass: "slot-vocal",
    gain: 0.92,
    activityScale: 1,
    triggerThreshold: 0.035,
  },
  {
    stem: "Drums",
    audio: "./assets/audio/tracks/drums.mp3",
    characterId: "drum",
    character: "Linus",
    role: "Drums",
    positionClass: "slot-drums",
    gain: 0.82,
    activityScale: 1,
    triggerThreshold: 0.035,
  },
  {
    stem: "Guitar",
    audio: "./assets/audio/tracks/guitar.mp3",
    characterId: "guitar",
    character: "Snoopy",
    role: "Guitar",
    positionClass: "slot-guitar",
    gain: 0.78,
    activityScale: 1,
    triggerThreshold: 0.035,
  },
  {
    stem: "Bass",
    audio: "./assets/audio/tracks/bass.mp3",
    characterId: "bass",
    character: "Lucy",
    role: "Bass",
    positionClass: "slot-bass",
    gain: 0.78,
    activityScale: 1,
    triggerThreshold: 0.035,
  },
  {
    stem: "Other",
    audio: "./assets/audio/tracks/other.mp3",
    characterId: "dj",
    character: "Woodstock",
    role: "DJ",
    positionClass: "slot-dj",
    gain: 0.72,
    activityScale: 1,
    triggerThreshold: 0.008,
  },
];

const API_BASE = "http://127.0.0.1:8787";
const band = document.querySelector("#band");
const trackControls = document.querySelector("#trackControls");
const performerTemplate = document.querySelector("#performerTemplate");
const trackControlTemplate = document.querySelector("#trackControlTemplate");
const playPauseButton = document.querySelector("#playPause");
const playIcon = document.querySelector("#playIcon");
const stateDot = document.querySelector("#stateDot");
const stateText = document.querySelector("#stateText");
const timeline = document.querySelector("#timeline");
const timeText = document.querySelector("#timeText");
const thresholdSlider = document.querySelector("#threshold");
const thresholdValue = document.querySelector("#thresholdValue");
const frameRateSlider = document.querySelector("#frameRate");
const frameRateValue = document.querySelector("#frameRateValue");
const editStageButton = document.querySelector("#editStage");
const saveStageButton = document.querySelector("#saveStage");

const ASSET_VERSION = Date.now();
const DEFAULT_TRIGGER_THRESHOLD = 0.035;

let audioContext;
let animationId;
let seeking = false;
let started = false;
let masterDuration = 0;
let editMode = false;
let dragState = null;
let resizeState = null;

const tracks = TRACKS.map((config) => ({
  ...config,
  frames: Array.from(
    { length: 6 },
    (_, index) => `./assets/characters/aligned/${config.characterId}/frame-${index + 1}.png?v=${ASSET_VERSION}`,
  ),
  audioElement: new Audio(config.audio),
  analyser: null,
  source: null,
  gainNode: null,
  data: null,
  enabled: true,
  currentFrame: 0,
  lastFrameAt: 0,
  activeUntil: 0,
  smoothedLevel: 0,
  image: null,
  card: null,
  levelLabel: null,
  toggleButton: null,
  volumeSlider: null,
  threshold: config.triggerThreshold || DEFAULT_TRIGGER_THRESHOLD,
  thresholdSlider: null,
  position: null,
  size: null,
  resizeHandle: null,
}));

tracks.forEach((track) => {
  track.audioElement.preload = "auto";
  track.audioElement.crossOrigin = "anonymous";
  track.audioElement.volume = 1;

  track.frames.forEach((src) => {
    const img = new Image();
    img.src = src;
  });
});

function createPerformer(track) {
  const node = performerTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(track.positionClass);
  node.dataset.stem = track.stem;

  const image = node.querySelector(".performer-image");
  image.src = track.frames[0];
  image.alt = `${track.character} ${track.role}`;

  node.querySelector(".performer-name").textContent = track.character;
  node.querySelector(".performer-role").textContent = track.role;

  track.image = image;
  track.card = node;
  track.resizeHandle = node.querySelector(".resize-handle");
  node.addEventListener("pointerdown", (event) => beginDrag(event, track));
  track.resizeHandle.addEventListener("pointerdown", (event) => beginResize(event, track));
  band.append(node);
}

function createTrackControl(track) {
  const node = trackControlTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.stem = track.stem;

  const icon = node.querySelector(".track-icon");
  icon.src = track.frames[0];
  icon.alt = track.role;

  node.querySelector(".track-name").textContent = `${track.role} · ${track.character}`;
  track.levelLabel = node.querySelector(".track-level");

  const volume = node.querySelector(".track-volume");
  volume.value = track.gain;
  volume.setAttribute("aria-label", `${track.role} volume`);
  volume.addEventListener("input", () => {
    track.gain = Number(volume.value);
    if (track.gainNode) {
      track.gainNode.gain.value = track.enabled ? track.gain : 0;
    }
  });
  track.volumeSlider = volume;

  const threshold = node.querySelector(".track-threshold");
  threshold.value = track.threshold;
  threshold.setAttribute("aria-label", `${track.role} trigger threshold`);
  threshold.addEventListener("input", () => {
    track.threshold = Number(threshold.value);
  });
  track.thresholdSlider = threshold;

  const toggle = node.querySelector(".track-toggle");
  toggle.addEventListener("click", () => toggleTrack(track));
  track.toggleButton = toggle;

  trackControls.append(node);
}

function stageConfigFromTracks() {
  return {
    tracks: Object.fromEntries(
      tracks.map((track) => [
        track.stem,
        {
          threshold: track.threshold,
          activityScale: track.activityScale,
          position: track.position,
          size: track.size,
        },
      ]),
    ),
  };
}

function applyTrackPosition(track, position) {
  if (!track.card || !position) return;
  track.position = {
    left: Number(position.left),
    top: Number(position.top),
  };
  track.card.style.left = `${track.position.left}%`;
  track.card.style.top = `${track.position.top}%`;
  track.card.style.right = "auto";
  track.card.style.bottom = "auto";
}

function captureCurrentPosition(track) {
  if (!track.card) return null;
  const bandRect = band.getBoundingClientRect();
  const cardRect = track.card.getBoundingClientRect();
  return {
    left: ((cardRect.left - bandRect.left) / bandRect.width) * 100,
    top: ((cardRect.top - bandRect.top) / bandRect.height) * 100,
  };
}

function applyTrackSize(track, size) {
  if (!track.card || !size) return;
  const width = Math.min(Math.max(Number(size.width), 8), 36);
  track.size = { width };
  track.card.style.width = `${width}%`;
}

function captureCurrentSize(track) {
  if (!track.card) return null;
  const bandRect = band.getBoundingClientRect();
  const cardRect = track.card.getBoundingClientRect();
  return {
    width: (cardRect.width / bandRect.width) * 100,
  };
}

function hydrateMissingPositions() {
  requestAnimationFrame(() => {
    tracks.forEach((track) => {
      if (!track.position) {
        track.position = captureCurrentPosition(track);
      }
      if (!track.size) {
        track.size = captureCurrentSize(track);
      }
    });
  });
}

async function loadStageConfig() {
  try {
    const response = await fetch(`${API_BASE}/api/stage/config`);
    if (!response.ok) return;
    const config = await response.json();
    const configTracks = config.tracks || {};
    tracks.forEach((track) => {
      const item = configTracks[track.stem];
      if (!item) return;
      if (Number.isFinite(Number(item.threshold))) {
        track.threshold = Number(item.threshold);
        if (track.thresholdSlider) track.thresholdSlider.value = track.threshold;
      }
      if (Number.isFinite(Number(item.activityScale))) {
        track.activityScale = Number(item.activityScale);
      }
      if (item.position) {
        applyTrackPosition(track, item.position);
      }
      if (item.size) {
        applyTrackSize(track, item.size);
      }
    });
  } catch (error) {
    console.warn("Stage config unavailable", error);
  } finally {
    hydrateMissingPositions();
  }
}

async function saveStageConfig() {
  tracks.forEach((track) => {
    track.position = captureCurrentPosition(track);
    track.size = captureCurrentSize(track);
  });

  const response = await fetch(`${API_BASE}/api/stage/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stageConfigFromTracks()),
  });

  if (!response.ok) {
    stateText.textContent = "舞台保存失败";
    return;
  }

  stateText.textContent = "舞台已保存";
}

function setEditMode(nextValue) {
  editMode = nextValue;
  band.classList.toggle("is-editing", editMode);
  editStageButton.hidden = editMode;
  saveStageButton.hidden = !editMode;
  tracks.forEach((track) => {
    track.card?.classList.toggle("is-draggable", editMode);
  });
}

function beginDrag(event, track) {
  if (!editMode || !track.card) return;
  if (event.target.closest(".resize-handle")) return;
  event.preventDefault();
  track.card.setPointerCapture(event.pointerId);
  const bandRect = band.getBoundingClientRect();
  const cardRect = track.card.getBoundingClientRect();
  dragState = {
    track,
    pointerId: event.pointerId,
    offsetX: event.clientX - cardRect.left,
    offsetY: event.clientY - cardRect.top,
    bandRect,
  };
  track.card.classList.add("is-dragging");
}

function beginResize(event, track) {
  if (!editMode || !track.card) return;
  event.preventDefault();
  event.stopPropagation();
  track.resizeHandle.setPointerCapture(event.pointerId);
  const bandRect = band.getBoundingClientRect();
  const cardRect = track.card.getBoundingClientRect();
  resizeState = {
    track,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: (cardRect.width / bandRect.width) * 100,
    bandRect,
  };
  track.card.classList.add("is-resizing");
}

function moveDrag(event) {
  if (resizeState && event.pointerId === resizeState.pointerId) {
    moveResize(event);
    return;
  }
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const { track, offsetX, offsetY, bandRect } = dragState;
  const cardRect = track.card.getBoundingClientRect();
  const nextLeftPx = Math.min(Math.max(event.clientX - bandRect.left - offsetX, 0), bandRect.width - cardRect.width);
  const nextTopPx = Math.min(Math.max(event.clientY - bandRect.top - offsetY, 0), bandRect.height - cardRect.height);
  applyTrackPosition(track, {
    left: (nextLeftPx / bandRect.width) * 100,
    top: (nextTopPx / bandRect.height) * 100,
  });
}

function moveResize(event) {
  const { track, startX, startY, startWidth, bandRect } = resizeState;
  const deltaX = ((event.clientX - startX) / bandRect.width) * 100;
  const deltaY = ((event.clientY - startY) / bandRect.width) * 100;
  const delta = Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY;
  applyTrackSize(track, { width: startWidth + delta });
}

function endDrag(event) {
  if (resizeState && event.pointerId === resizeState.pointerId) {
    resizeState.track.card.classList.remove("is-resizing");
    resizeState.track.size = captureCurrentSize(resizeState.track);
    resizeState = null;
    return;
  }
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  dragState.track.card.classList.remove("is-dragging");
  dragState.track.position = captureCurrentPosition(dragState.track);
  dragState = null;
}

function buildUi() {
  tracks.forEach((track) => {
    createPerformer(track);
    createTrackControl(track);
  });
}

function setupAudioGraph() {
  if (audioContext) return;

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioContext = new AudioContextClass();

  tracks.forEach((track) => {
    const source = audioContext.createMediaElementSource(track.audioElement);
    const analyser = audioContext.createAnalyser();
    const gainNode = audioContext.createGain();

    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;
    gainNode.gain.value = track.gain;

    source.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(audioContext.destination);

    track.source = source;
    track.analyser = analyser;
    track.gainNode = gainNode;
    track.data = new Uint8Array(analyser.fftSize);
  });
}

function getLevel(track) {
  if (!track.analyser || !track.data) return 0;

  track.analyser.getByteTimeDomainData(track.data);
  let sum = 0;

  for (const value of track.data) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }

  return Math.sqrt(sum / track.data.length);
}

function setTrackStill(track) {
  track.currentFrame = 0;
  track.image.src = track.frames[0];
  track.card.classList.remove("is-playing");
}

function toggleTrack(track) {
  track.enabled = !track.enabled;

  if (track.gainNode) {
    track.gainNode.gain.value = track.enabled ? track.gain : 0;
  }

  track.toggleButton.classList.toggle("is-off", !track.enabled);
  track.toggleButton.textContent = track.enabled ? "■" : "▶";
  track.card.classList.toggle("is-disabled", !track.enabled);

  if (!track.enabled) {
    setTrackStill(track);
  }
}

function setStatus(isPlaying) {
  stateDot.classList.toggle("playing", isPlaying);
  stateText.textContent = isPlaying ? "乐队演奏中" : "等待播放";
  playIcon.textContent = isPlaying ? "Ⅱ" : "▶";
}

function anyTrackPlaying() {
  return tracks.some((track) => !track.audioElement.paused && !track.audioElement.ended);
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  const min = Math.floor(whole / 60);
  const sec = String(whole % 60).padStart(2, "0");
  return `${min}:${sec}`;
}

function syncToMaster(time) {
  tracks.forEach((track) => {
    if (Number.isFinite(track.audioElement.duration)) {
      track.audioElement.currentTime = Math.min(time, track.audioElement.duration - 0.05);
    }
  });
}

async function playAll() {
  try {
    setupAudioGraph();
    await audioContext.resume();
  } catch (error) {
    stateText.textContent = "音频初始化失败";
    console.error(error);
    return;
  }

  const currentTime = tracks[0].audioElement.currentTime || 0;
  syncToMaster(currentTime);

  await Promise.all(
    tracks.map((track) => {
      if (track.gainNode) {
        track.gainNode.gain.value = track.enabled ? track.gain : 0;
      }
      return track.audioElement.play().catch(() => {
        setTrackStill(track);
      });
    }),
  );

  started = true;
  setStatus(true);
  if (!animationId) {
    animationId = requestAnimationFrame(tick);
  }
}

function pauseAll() {
  tracks.forEach((track) => track.audioElement.pause());
  tracks.forEach(setTrackStill);
  setStatus(false);
}

function togglePlayback() {
  if (anyTrackPlaying()) {
    pauseAll();
  } else {
    playAll();
  }
}

function updateTimeline() {
  const master = tracks[0].audioElement;
  if (!seeking && masterDuration > 0) {
    timeline.value = String(master.currentTime / masterDuration);
  }
  timeText.textContent = formatTime(master.currentTime);
}

function updateControlLabels() {
  thresholdValue.textContent = Number(thresholdSlider.value).toFixed(3);
  frameRateValue.textContent = `${frameRateSlider.value} fps`;
}

function tick(now) {
  const globalThreshold = Number(thresholdSlider.value);
  const frameInterval = 1000 / Number(frameRateSlider.value);
  const isPlaying = anyTrackPlaying();

  tracks.forEach((track) => {
    if (!isPlaying || !track.enabled) {
      track.smoothedLevel *= 0.86;
      track.levelLabel.textContent = "";
      if (!track.enabled || track.smoothedLevel < track.threshold * 0.45) {
        setTrackStill(track);
      }
      return;
    }

    const instantLevel = getLevel(track) * (track.activityScale || 1);
    track.smoothedLevel = track.smoothedLevel * 0.8 + instantLevel * 0.2;
    track.levelLabel.textContent = `${Math.min(99, Math.round(track.smoothedLevel * 300))}`;

    const threshold = track.threshold || globalThreshold;

    if (track.smoothedLevel > threshold) {
      track.activeUntil = now + 180;
    }

    const active = now < track.activeUntil;
    track.card.classList.toggle("is-playing", active);

    if (active && now - track.lastFrameAt > frameInterval) {
      track.currentFrame = (track.currentFrame + 1) % track.frames.length;
      track.image.src = track.frames[track.currentFrame];
      track.lastFrameAt = now;
    } else if (!active) {
      setTrackStill(track);
    }
  });

  updateTimeline();
  setStatus(isPlaying);
  animationId = requestAnimationFrame(tick);
}

playPauseButton.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    togglePlayback();
  }
});

timeline.addEventListener("input", () => {
  seeking = true;
  timeText.textContent = formatTime(Number(timeline.value) * masterDuration);
});

timeline.addEventListener("change", () => {
  const nextTime = Number(timeline.value) * masterDuration;
  syncToMaster(nextTime);
  seeking = false;
});

thresholdSlider.addEventListener("input", updateControlLabels);
frameRateSlider.addEventListener("input", updateControlLabels);
editStageButton.addEventListener("click", () => setEditMode(true));
saveStageButton.addEventListener("click", () => {
  saveStageConfig().finally(() => setEditMode(false));
});
band.addEventListener("pointermove", moveDrag);
band.addEventListener("pointerup", endDrag);
band.addEventListener("pointercancel", endDrag);

tracks[0].audioElement.addEventListener("loadedmetadata", () => {
  masterDuration = tracks[0].audioElement.duration || 0;
  timeline.max = "1";
  timeText.textContent = `0:00 / ${formatTime(masterDuration)}`;
});

tracks.forEach((track) => {
  track.audioElement.addEventListener("ended", () => {
    if (!anyTrackPlaying()) {
      pauseAll();
      syncToMaster(0);
      timeline.value = "0";
      started = false;
    }
  });
});

buildUi();
updateControlLabels();
setStatus(false);
loadStageConfig();

window.__bandMixer = {
  tracks,
  playAll,
  pauseAll,
  togglePlayback,
  toggleTrackByStem(stem) {
    const track = tracks.find((item) => item.stem === stem);
    if (track) toggleTrack(track);
  },
  state() {
    return {
      playing: anyTrackPlaying(),
      duration: masterDuration,
      tracks: tracks.map((track) => ({
        stem: track.stem,
        enabled: track.enabled,
        paused: track.audioElement.paused,
        currentTime: track.audioElement.currentTime,
        level: track.smoothedLevel,
      })),
    };
  },
};
