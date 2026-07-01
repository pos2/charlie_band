const API_BASE = window.CHARLIE_BAND_API_BASE ?? "http://127.0.0.1:8787";
const ASSET_VERSION = Date.now();
const MODE = document.body.dataset.mode || "view";

const ROLE_MAP = {
  Vocals: { characterId: "vocal", character: "Charlie Brown", role: "Vocal", threshold: 0.035, gain: 0.92 },
  Drums: { characterId: "drum", character: "Linus", role: "Drums", threshold: 0.035, gain: 0.82 },
  Piano: { characterId: "piano", character: "Schroeder", role: "Piano", threshold: 0.035, gain: 0.78 },
  Guitar: { characterId: "guitar", character: "Snoopy", role: "Guitar", threshold: 0.035, gain: 0.78 },
  Bass: { characterId: "bass", character: "Lucy", role: "Bass", threshold: 0.035, gain: 0.78 },
  Other: { characterId: "dj", character: "Woodstock", role: "DJ", threshold: 0.008, gain: 0.72 },
};

const DEFAULT_POSITIONS = {
  Vocals: { position: { left: 45.6, top: 58 }, size: { width: 15 } },
  Drums: { position: { left: 31.4, top: 14.2 }, size: { width: 17 } },
  Piano: { position: { left: 40, top: 36 }, size: { width: 16 } },
  Guitar: { position: { left: 15.5, top: 41.2 }, size: { width: 17 } },
  Bass: { position: { left: 69.1, top: 46.2 }, size: { width: 16 } },
  Other: { position: { left: 62.3, top: 9.7 }, size: { width: 16 } },
};

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
const frameRateSlider = document.querySelector("#frameRate");
const frameRateValue = document.querySelector("#frameRateValue");
const editStageButton = document.querySelector("#editStage");
const saveStageButton = document.querySelector("#saveStage");
const uploadForm = document.querySelector("#uploadForm");
const audioFile = document.querySelector("#audioFile");
const rvcModelSelect = document.querySelector("#rvcModelSelect");
const editRvcModelSelect = document.querySelector("#editRvcModelSelect");
const revoiceVocalsButton = document.querySelector("#revoiceVocals");
const revoiceStatus = document.querySelector("#revoiceStatus");
const addVocalSwitchCueButton = document.querySelector("#addVocalSwitchCue");
const clearVocalSwitchCueButton = document.querySelector("#clearVocalSwitchCue");
const vocalSwitchStatus = document.querySelector("#vocalSwitchStatus");
const modelFolderPath = document.querySelector("#modelFolderPath");
const importModelFolderButton = document.querySelector("#importModelFolder");
const processStatus = document.querySelector("#processStatus");
const uploadPanel = document.querySelector("#uploadPanel");
const bandApp = document.querySelector("#bandApp");
const shareUrl = document.querySelector("#shareUrl");

let tracks = [];
let performanceConfig = null;
let audioContext;
let animationId;
let seeking = false;
let masterDuration = 0;
let editMode = false;
let dragState = null;
let resizeState = null;
let rvcVariantCache = new Map();
let appliedSwitchCueIds = new Set();
let switchInProgress = false;
let vocalSwitchVariant = null;

function absoluteApiUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE}${path}`;
}

function frameSources(characterId) {
  return Array.from({ length: 6 }, (_, index) => `./assets/characters/aligned/${characterId}/frame-${index + 1}.png?v=${ASSET_VERSION}`);
}

function toggleIconSource(track, enabled = true) {
  return `./assets/ui/toggles/${track.characterId}-${enabled ? "on" : "off"}.png?v=${ASSET_VERSION}`;
}

function stemAudioUrl(result, stemName) {
  if (stemName === "Vocals" && result.urls?.animation_audio) {
    return absoluteApiUrl(result.urls.animation_audio);
  }
  const stem = result.stems.find((item) => item.name === stemName && item.url && !item.silent);
  return stem ? absoluteApiUrl(stem.url) : null;
}

function tracksFromProcessResult(result) {
  const order = ["Vocals", "Drums", "Piano", "Guitar", "Bass", "Other"];
  return order
    .map((stem) => {
      const audio = stemAudioUrl(result, stem);
      const role = ROLE_MAP[stem];
      if (!audio || !role) return null;
      const defaults = DEFAULT_POSITIONS[stem] || {};
      return {
        stem,
        audio,
        ...role,
        threshold: role.threshold,
        activityScale: 1,
        position: defaults.position,
        size: defaults.size,
      };
    })
    .filter(Boolean);
}

function jobIdFromTracks(trackList) {
  for (const track of trackList || []) {
    const match = String(track.audio || "").match(/\/api\/pipeline\/([^/]+)\//);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

function trackPayload(track) {
  return {
    stem: track.stem,
    audio: track.audio,
    characterId: track.characterId,
    character: track.character,
    role: track.role,
    gain: track.gain,
    threshold: track.threshold,
    activityScale: track.activityScale || 1,
    position: track.card ? captureCurrentPosition(track) : track.position,
    size: track.card ? captureCurrentSize(track) : track.size,
  };
}

function payloadTracks() {
  const currentTracks = tracks.map(trackPayload);
  if (!appliedSwitchCueIds.size || !performanceConfig?.tracks?.length) return currentTracks;
  return performanceConfig.tracks.map((baseTrack) => {
    const currentTrack = currentTracks.find((track) => track.stem === baseTrack.stem);
    if (!currentTrack) return baseTrack;
    return {
      ...baseTrack,
      gain: currentTrack.gain,
      threshold: currentTrack.threshold,
      activityScale: currentTrack.activityScale,
      position: currentTrack.position,
      size: currentTrack.size,
    };
  });
}

function switchCuePayload(cue) {
  return {
    id: cue.id,
    time: Number(cue.time) || 0,
    stem: cue.stem || "Vocals",
    audio: cue.audio,
    characterId: cue.characterId,
    character: cue.character,
    role: cue.role,
    rvcModel: cue.rvcModel,
  };
}

function normalizeTrack(config) {
  return {
    ...config,
    frames: frameSources(config.characterId),
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
    toggleIcon: null,
    volumeSlider: null,
    thresholdSlider: null,
    voiceSwitchButton: null,
  };
}

function resetBand(nextTracks, options = {}) {
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  pauseAll();
  if (!options.keepSwitchState) appliedSwitchCueIds = new Set();
  band.innerHTML = "";
  trackControls.innerHTML = "";
  tracks = nextTracks.map(normalizeTrack);
  tracks.forEach((track) => {
    track.audioElement.preload = "auto";
    track.audioElement.crossOrigin = "anonymous";
    track.audioElement.volume = 1;
    track.frames.forEach((src) => {
      const img = new Image();
      img.src = src;
    });
  });
  buildUi();
  updateVocalSwitchAvailability();
  attachMetadataListeners();
  setStatus(false);
}

function createPerformer(track) {
  const node = performerTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.stem = track.stem;

  const image = node.querySelector(".performer-image");
  image.src = track.frames[0];
  image.alt = `${track.character} ${track.role}`;

  node.querySelector(".performer-name").textContent = track.character;
  node.querySelector(".performer-role").textContent = track.role;

  track.image = image;
  track.card = node;

  const resizeHandle = node.querySelector(".resize-handle");
  if (resizeHandle) {
    resizeHandle.addEventListener("pointerdown", (event) => beginResize(event, track));
  }
  if (MODE === "make") {
    node.addEventListener("pointerdown", (event) => beginDrag(event, track));
  }

  band.append(node);
  applyTrackPosition(track, track.position);
  applyTrackSize(track, track.size);
}

function createTrackControl(track) {
  const node = trackControlTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.stem = track.stem;

  node.querySelector(".track-name").textContent = `${track.role} · ${track.character}`;
  track.levelLabel = node.querySelector(".track-level");

  const volume = node.querySelector(".track-volume");
  volume.value = track.gain;
  volume.addEventListener("input", () => {
    track.gain = Number(volume.value);
    if (track.gainNode) track.gainNode.gain.value = track.enabled ? track.gain : 0;
  });
  track.volumeSlider = volume;

  const threshold = node.querySelector(".track-threshold");
  if (threshold) {
    threshold.value = track.threshold;
    threshold.addEventListener("input", () => {
      track.threshold = Number(threshold.value);
    });
    track.thresholdSlider = threshold;
  }

  const toggle = node.querySelector(".track-toggle");
  const toggleIcon = document.createElement("img");
  toggleIcon.className = "track-toggle-icon";
  toggleIcon.src = toggleIconSource(track, true);
  toggleIcon.alt = `${track.character} ${track.role}`;
  toggle.replaceChildren(toggleIcon);
  toggle.setAttribute("aria-label", `停止 ${track.role}`);
  toggle.addEventListener("click", () => toggleTrack(track));
  track.toggleButton = toggle;
  track.toggleIcon = toggleIcon;

  if (track.stem === "Vocals") {
    node.classList.add("has-voice-switch");
    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.textContent = "换声";
    switchButton.disabled = true;
    switchButton.title = "需要先有已生成的 Weeknd 人声音频";
    switchButton.addEventListener("click", switchVocalToWeeknd);
    toggle.insertAdjacentElement("afterend", switchButton);
    track.voiceSwitchButton = switchButton;
  }

  trackControls.append(node);
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
  return Math.sqrt(sum / track.data.length) * (track.activityScale || 1);
}

function setTrackStill(track) {
  track.currentFrame = 0;
  if (track.image) track.image.src = track.frames[0];
  track.card?.classList.remove("is-playing");
}

function toggleTrack(track) {
  track.enabled = !track.enabled;
  if (track.gainNode) track.gainNode.gain.value = track.enabled ? track.gain : 0;
  track.toggleButton.classList.toggle("is-off", !track.enabled);
  if (track.toggleIcon) track.toggleIcon.src = toggleIconSource(track, track.enabled);
  track.toggleButton.setAttribute("aria-label", track.enabled ? `停止 ${track.role}` : `恢复 ${track.role}`);
  track.card.classList.toggle("is-disabled", !track.enabled);
  if (!track.enabled) setTrackStill(track);
}

function anyTrackPlaying() {
  return tracks.some((track) => !track.audioElement.paused && !track.audioElement.ended);
}

function setStatus(isPlaying) {
  stateDot.classList.toggle("playing", isPlaying);
  stateText.textContent = isPlaying ? "乐队演奏中" : "等待播放";
  playIcon.textContent = isPlaying ? "Ⅱ" : "▶";
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function syncToMaster(time) {
  tracks.forEach((track) => {
    if (Number.isFinite(track.audioElement.duration)) {
      track.audioElement.currentTime = Math.min(time, Math.max(0, track.audioElement.duration - 0.05));
    }
  });
}

function seekAndMaybePlay(time, shouldResume) {
  let attempts = 0;
  const apply = () => {
    attempts += 1;
    syncToMaster(time);
    if (masterDuration > 0) timeline.value = String(Math.min(1, time / masterDuration));
    updateTimeline();
    if (shouldResume) playAll();
    switchInProgress = false;
  };
  const ready = () => tracks.every((track) => Number.isFinite(track.audioElement.duration) || attempts > 8);
  const wait = () => {
    if (ready()) apply();
    else window.setTimeout(wait, 120);
  };
  wait();
}

function weekndVariantFromCache() {
  const variants = Array.from(rvcVariantCache.values());
  return (
    variants.find((variant) => variant.exists && /weeknd/i.test(`${variant.label} ${variant.value}`)) ||
    (performanceConfig?.voiceSwitches || []).find((variant) => /weeknd/i.test(`${variant.label} ${variant.value}`) && (variant.url || variant.audio))
  );
}

function updateVocalSwitchAvailability() {
  vocalSwitchVariant = weekndVariantFromCache();
  const vocal = tracks.find((track) => track.stem === "Vocals");
  if (!vocal?.voiceSwitchButton) return;
  vocal.voiceSwitchButton.disabled = !vocalSwitchVariant;
  vocal.voiceSwitchButton.title = vocalSwitchVariant
    ? `切换到 ${vocalSwitchVariant.label} 人声和 Weeknd 纸袋素材`
    : "没有已生成的 Weeknd 人声音频";
}

function switchVocalToWeeknd() {
  const variant = vocalSwitchVariant || weekndVariantFromCache();
  const vocal = tracks.find((track) => track.stem === "Vocals");
  const variantUrl = variant?.url || variant?.audio;
  if (!variantUrl || !vocal || switchInProgress) {
    stateText.textContent = "没有可切换的 Weeknd 人声缓存";
    return;
  }
  const switchTime = tracks[0]?.audioElement.currentTime || 0;
  const shouldResume = anyTrackPlaying();
  switchInProgress = true;
  pauseAll();
  const nextTracks = tracks.map(trackPayload);
  const nextVocal = nextTracks.find((track) => track.stem === "Vocals");
  if (nextVocal) {
    nextVocal.audio = absoluteApiUrl(variantUrl);
    nextVocal.characterId = "vocal_cos_weeknd";
    nextVocal.character = "Weeknd Bag Charlie";
    nextVocal.role = "Vocal";
  }
  resetBand(nextTracks, { keepSwitchState: true });
  updateVocalSwitchAvailability();
  seekAndMaybePlay(switchTime, shouldResume);
  stateText.textContent = "正在切换 Weeknd 人声";
}

function applySwitchCue(cue) {
  if (switchInProgress || appliedSwitchCueIds.has(cue.id)) return;
  const vocal = tracks.find((track) => track.stem === (cue.stem || "Vocals"));
  if (!vocal || !cue.audio || !cue.characterId) return;
  const switchTime = tracks[0]?.audioElement.currentTime || cue.time || 0;
  const shouldResume = anyTrackPlaying();
  switchInProgress = true;
  appliedSwitchCueIds.add(cue.id);
  const nextTracks = tracks.map(trackPayload);
  const nextVocal = nextTracks.find((track) => track.stem === (cue.stem || "Vocals"));
  if (nextVocal) {
    nextVocal.audio = cue.audio;
    nextVocal.characterId = cue.characterId;
    nextVocal.character = cue.character || nextVocal.character;
    nextVocal.role = cue.role || nextVocal.role;
  }
  resetBand(nextTracks, { keepSwitchState: true });
  seekAndMaybePlay(switchTime, shouldResume);
  stateText.textContent = "已切换人声和人物";
}

function applyDueSwitchCues() {
  if (!performanceConfig?.switches?.length || !tracks.length || switchInProgress) return;
  const currentTime = tracks[0]?.audioElement.currentTime || 0;
  const cue = performanceConfig.switches
    .map(switchCuePayload)
    .filter((item) => item.time <= currentTime && !appliedSwitchCueIds.has(item.id))
    .sort((a, b) => a.time - b.time)
    .at(0);
  if (cue) applySwitchCue(cue);
}

function resetSwitchesForSeek(time) {
  if (!appliedSwitchCueIds.size || !performanceConfig?.switches?.length) return false;
  const earliestCue = Math.min(...performanceConfig.switches.map((cue) => Number(cue.time) || 0));
  if (time >= earliestCue) return false;
  resetBand(performanceConfig.tracks || []);
  seekAndMaybePlay(time, false);
  return true;
}

async function playAll() {
  if (!tracks.length) return;
  try {
    setupAudioGraph();
    await audioContext.resume();
  } catch {
    stateText.textContent = "音频初始化失败";
    return;
  }
  syncToMaster(tracks[0].audioElement.currentTime || 0);
  await Promise.all(
    tracks.map((track) => {
      if (track.gainNode) track.gainNode.gain.value = track.enabled ? track.gain : 0;
      return track.audioElement.play().catch(() => setTrackStill(track));
    }),
  );
  setStatus(true);
  if (!animationId) animationId = requestAnimationFrame(tick);
}

function pauseAll() {
  tracks.forEach((track) => track.audioElement.pause());
  tracks.forEach(setTrackStill);
  setStatus(false);
}

function togglePlayback() {
  if (anyTrackPlaying()) pauseAll();
  else playAll();
}

function updateTimeline() {
  if (!tracks.length) return;
  const master = tracks[0].audioElement;
  if (!seeking && masterDuration > 0) timeline.value = String(master.currentTime / masterDuration);
  timeText.textContent = formatTime(master.currentTime);
}

function tick(now) {
  const frameInterval = 1000 / Number(frameRateSlider.value);
  const isPlaying = anyTrackPlaying();
  tracks.forEach((track) => {
    if (!isPlaying || !track.enabled) {
      track.smoothedLevel *= 0.86;
      if (track.levelLabel) track.levelLabel.textContent = "";
      if (!track.enabled || track.smoothedLevel < track.threshold * 0.45) setTrackStill(track);
      return;
    }
    track.smoothedLevel = track.smoothedLevel * 0.8 + getLevel(track) * 0.2;
    if (track.levelLabel) track.levelLabel.textContent = `${Math.min(99, Math.round(track.smoothedLevel * 300))}`;
    if (track.smoothedLevel > track.threshold) track.activeUntil = now + 180;
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

function applyTrackPosition(track, position) {
  if (!track.card || !position) return;
  track.position = { left: Number(position.left), top: Number(position.top) };
  track.card.style.left = `${track.position.left}%`;
  track.card.style.top = `${track.position.top}%`;
  track.card.style.right = "auto";
  track.card.style.bottom = "auto";
}

function captureCurrentPosition(track) {
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
  const bandRect = band.getBoundingClientRect();
  const cardRect = track.card.getBoundingClientRect();
  return { width: (cardRect.width / bandRect.width) * 100 };
}

function beginDrag(event, track) {
  if (!editMode || !track.card || event.target.closest(".resize-handle")) return;
  event.preventDefault();
  track.card.setPointerCapture(event.pointerId);
  const bandRect = band.getBoundingClientRect();
  const cardRect = track.card.getBoundingClientRect();
  dragState = { track, pointerId: event.pointerId, offsetX: event.clientX - cardRect.left, offsetY: event.clientY - cardRect.top, bandRect };
  track.card.classList.add("is-dragging");
}

function beginResize(event, track) {
  if (!editMode || !track.card) return;
  event.preventDefault();
  event.stopPropagation();
  event.target.setPointerCapture(event.pointerId);
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

function movePointer(event) {
  if (resizeState && event.pointerId === resizeState.pointerId) {
    const deltaX = ((event.clientX - resizeState.startX) / resizeState.bandRect.width) * 100;
    const deltaY = ((event.clientY - resizeState.startY) / resizeState.bandRect.width) * 100;
    applyTrackSize(resizeState.track, { width: resizeState.startWidth + (Math.abs(deltaX) > Math.abs(deltaY) ? deltaX : deltaY) });
    return;
  }
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const { track, offsetX, offsetY, bandRect } = dragState;
  const cardRect = track.card.getBoundingClientRect();
  const leftPx = Math.min(Math.max(event.clientX - bandRect.left - offsetX, 0), bandRect.width - cardRect.width);
  const topPx = Math.min(Math.max(event.clientY - bandRect.top - offsetY, 0), bandRect.height - cardRect.height);
  applyTrackPosition(track, { left: (leftPx / bandRect.width) * 100, top: (topPx / bandRect.height) * 100 });
}

function endPointer(event) {
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

function setEditMode(nextValue) {
  editMode = nextValue;
  band.classList.toggle("is-editing", editMode);
  if (editStageButton) editStageButton.hidden = editMode;
  if (saveStageButton) saveStageButton.hidden = !editMode;
  tracks.forEach((track) => track.card?.classList.toggle("is-draggable", editMode));
}

function performancePayload() {
  return {
    id: performanceConfig?.id,
    createdAt: performanceConfig?.createdAt || new Date().toISOString(),
    sourceJobId: performanceConfig?.sourceJobId || jobIdFromTracks(tracks),
    rvcModel: performanceConfig?.rvcModel || editRvcModelSelect?.value || rvcModelSelect?.value,
    switches: (performanceConfig?.switches || []).map(switchCuePayload),
    tracks: payloadTracks(),
  };
}

async function savePerformance() {
  const response = await fetch(`${API_BASE}/api/performances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(performancePayload()),
  });
  const result = await response.json();
  if (!response.ok) {
    stateText.textContent = "保存失败";
    return;
  }
  performanceConfig = { ...performancePayload(), id: result.id };
  const fullUrl = new URL(result.url, window.location.href).href;
  if (shareUrl) {
    shareUrl.hidden = false;
    shareUrl.innerHTML = `<a href="${fullUrl}">${fullUrl}</a>`;
  }
  stateText.textContent = "演奏页已生成";
  setEditMode(false);
}

async function processUpload(event) {
  event.preventDefault();
  const file = audioFile.files[0];
  if (!file) return;
  processStatus.textContent = "处理中...";
  uploadForm.querySelector("button").disabled = true;
  const form = new FormData();
  form.append("audio", file);
  if (rvcModelSelect?.value) form.append("rvc_model", rvcModelSelect.value);
  const response = await fetch(`${API_BASE}/api/process`, { method: "POST", body: form });
  const result = await response.json();
  uploadForm.querySelector("button").disabled = false;
  if (!response.ok) {
    processStatus.textContent = `处理失败: ${result.detail || response.status}`;
    return;
  }
  const nextTracks = tracksFromProcessResult(result);
  performanceConfig = { sourceJobId: result.job_id, rvcModel: result.rvc_model, createdAt: new Date().toISOString(), switches: [], tracks: nextTracks };
  if (editRvcModelSelect) editRvcModelSelect.value = result.rvc_model;
  resetBand(nextTracks);
  await loadRvcVariants(result.job_id);
  updateVocalSwitchStatus();
  uploadPanel.classList.add("is-hidden");
  bandApp.classList.remove("is-hidden");
  processStatus.textContent = "处理完成";
  setEditMode(true);
}

async function loadRvcModels() {
  if (!API_BASE) return;
  try {
    const response = await fetch(`${API_BASE}/api/rvc/models`);
    const result = await response.json();
    if (!response.ok || !Array.isArray(result.models) || !result.models.length) return;
    [rvcModelSelect, editRvcModelSelect].filter(Boolean).forEach((select) => {
      const previousValue = select.value;
      select.innerHTML = "";
      result.models.forEach((model) => {
        const option = document.createElement("option");
        option.value = model.value;
        option.textContent = model.has_index ? model.label : `${model.label} (无 index)`;
        option.selected = model.value === (previousValue || result.default);
        select.append(option);
      });
    });
  } catch {
    processStatus.textContent = "模型列表加载失败，使用默认模型";
  }
}

async function loadRvcVariants(jobId) {
  rvcVariantCache = new Map();
  if (!jobId || !API_BASE) return;
  try {
    const response = await fetch(`${API_BASE}/api/pipeline/${encodeURIComponent(jobId)}/rvc-variants`);
    const result = await response.json();
    if (!response.ok || !Array.isArray(result.variants)) return;
    rvcVariantCache = new Map(result.variants.map((variant) => [variant.value, variant]));
    updateRevoiceCacheHint();
    updateVocalSwitchAvailability();
  } catch {
    if (revoiceStatus) revoiceStatus.textContent = "本地模型音频缓存检查失败";
    updateVocalSwitchAvailability();
  }
}

function updateRevoiceCacheHint() {
  if (!revoiceStatus || !editRvcModelSelect) return;
  const variant = rvcVariantCache.get(editRvcModelSelect.value);
  if (!variant) {
    revoiceStatus.textContent = "";
    return;
  }
  revoiceStatus.classList.remove("is-working");
  revoiceStatus.textContent = variant.exists
    ? `${variant.label} 的人声音频本地已存在，点击会直接复用`
    : `${variant.label} 尚未生成，点击会重新推理`;
}

function updateVocalSwitchStatus() {
  if (!vocalSwitchStatus) return;
  const cue = (performanceConfig?.switches || []).find((item) => item.stem === "Vocals");
  vocalSwitchStatus.textContent = cue
    ? `已设置 ${formatTime(cue.time)} 切换到 ${String(cue.rvcModel || "").replace(/\.pth$/i, "")} + Weeknd纸袋查理`
    : "尚未设置中途换声点";
}

async function ensureRvcVariant(jobId, model) {
  const form = new FormData();
  form.append("rvc_model", model);
  const response = await fetch(`${API_BASE}/api/pipeline/${encodeURIComponent(jobId)}/rvc`, { method: "POST", body: form });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.detail || response.status);
  }
  return result;
}

async function addVocalSwitchCue() {
  const jobId = performanceConfig?.sourceJobId || jobIdFromTracks(tracks);
  const model = editRvcModelSelect?.value || rvcModelSelect?.value;
  if (!jobId || !model) {
    if (vocalSwitchStatus) vocalSwitchStatus.textContent = "当前作品没有可复用的分轨 job 或模型";
    return;
  }
  const cueTime = tracks[0]?.audioElement.currentTime || 0;
  const variant = rvcVariantCache.get(model);
  const previousButtonText = addVocalSwitchCueButton.textContent;
  addVocalSwitchCueButton.disabled = true;
  clearVocalSwitchCueButton.disabled = true;
  addVocalSwitchCueButton.textContent = "准备换声点...";
  if (vocalSwitchStatus) {
    vocalSwitchStatus.classList.add("is-working");
    vocalSwitchStatus.textContent = variant?.exists ? "正在复用本地人声缓存..." : "正在生成该模型的人声缓存...";
  }
  try {
    const result = await ensureRvcVariant(jobId, model);
    const cue = {
      id: "vocal-weeknd-switch",
      time: cueTime,
      stem: "Vocals",
      audio: absoluteApiUrl(result.url),
      characterId: "vocal_cos_weeknd",
      character: "Weeknd Bag Charlie",
      role: "Vocal",
      rvcModel: result.rvc_model,
    };
    performanceConfig = {
      ...(performanceConfig || {}),
      sourceJobId: jobId,
      switches: [cue, ...(performanceConfig?.switches || []).filter((item) => item.stem !== "Vocals")],
    };
    await loadRvcVariants(jobId);
    updateVocalSwitchStatus();
    stateText.textContent = "换声换人点已添加，保存后演奏页生效";
  } catch (error) {
    if (vocalSwitchStatus) vocalSwitchStatus.textContent = `换声点创建失败: ${error.message}`;
    stateText.textContent = "换声点创建失败";
  } finally {
    addVocalSwitchCueButton.disabled = false;
    clearVocalSwitchCueButton.disabled = false;
    addVocalSwitchCueButton.textContent = previousButtonText;
    vocalSwitchStatus?.classList.remove("is-working");
  }
}

function clearVocalSwitchCue() {
  performanceConfig = {
    ...(performanceConfig || {}),
    switches: (performanceConfig?.switches || []).filter((item) => item.stem !== "Vocals"),
  };
  appliedSwitchCueIds = new Set();
  updateVocalSwitchStatus();
  stateText.textContent = "换声点已清除，保存后生效";
}

async function importModelFolder() {
  if (!modelFolderPath?.value.trim()) return;
  processStatus.textContent = "导入模型中...";
  importModelFolderButton.disabled = true;
  const form = new FormData();
  form.append("folder_path", modelFolderPath.value.trim());
  const response = await fetch(`${API_BASE}/api/rvc/models/import-folder`, { method: "POST", body: form });
  const result = await response.json();
  importModelFolderButton.disabled = false;
  if (!response.ok) {
    processStatus.textContent = `导入失败: ${result.detail || response.status}`;
    return;
  }
  await loadRvcModels();
  const imported = result.imported?.[0]?.value;
  if (imported) {
    if (rvcModelSelect) rvcModelSelect.value = imported;
    if (editRvcModelSelect) editRvcModelSelect.value = imported;
  }
  await loadRvcVariants(performanceConfig?.sourceJobId || jobIdFromTracks(tracks));
  processStatus.textContent = "模型已导入";
}

async function revoiceVocals() {
  const jobId = performanceConfig?.sourceJobId || jobIdFromTracks(tracks);
  const model = editRvcModelSelect?.value || rvcModelSelect?.value;
  if (!jobId) {
    stateText.textContent = "找不到可复用的分轨 job";
    if (revoiceStatus) revoiceStatus.textContent = "当前作品没有可复用的分轨 job";
    return;
  }
  if (!model) return;
  const variant = rvcVariantCache.get(model);
  const originalButtonText = revoiceVocalsButton.textContent;
  stateText.textContent = variant?.exists ? "正在复用本地人声缓存..." : "重新变声中...";
  if (revoiceStatus) {
    revoiceStatus.textContent = variant?.exists
      ? `本地已有 ${variant.label} 人声音频，正在切换...`
      : `正在用 ${model.replace(/\.pth$/i, "")} 处理人声...`;
    revoiceStatus.classList.add("is-working");
  }
  revoiceVocalsButton.disabled = true;
  revoiceVocalsButton.textContent = "处理中...";
  editRvcModelSelect.disabled = true;
  pauseAll();
  const form = new FormData();
  form.append("rvc_model", model);
  let result;
  try {
    const response = await fetch(`${API_BASE}/api/pipeline/${encodeURIComponent(jobId)}/rvc`, { method: "POST", body: form });
    result = await response.json();
    if (!response.ok) {
      stateText.textContent = `变声失败: ${result.detail || response.status}`;
      if (revoiceStatus) revoiceStatus.textContent = `变声失败: ${result.detail || response.status}`;
      return;
    }
  } catch (error) {
    stateText.textContent = "变声请求失败";
    if (revoiceStatus) revoiceStatus.textContent = `变声请求失败: ${error.message}`;
    return;
  } finally {
    revoiceVocalsButton.disabled = false;
    revoiceVocalsButton.textContent = originalButtonText;
    editRvcModelSelect.disabled = false;
    revoiceStatus?.classList.remove("is-working");
  }

  const nextTracks = tracks.map(trackPayload);
  const vocal = nextTracks.find((track) => track.stem === "Vocals");
  if (vocal) vocal.audio = absoluteApiUrl(result.url);
  performanceConfig = {
    ...(performanceConfig || {}),
    sourceJobId: jobId,
    rvcModel: result.rvc_model,
    tracks: nextTracks,
  };
  resetBand(nextTracks);
  setEditMode(true);
  await loadRvcVariants(jobId);
  updateVocalSwitchStatus();
  stateText.textContent = result.cached ? "已复用该模型的人声缓存" : "人声已重新变声";
  if (revoiceStatus) {
    revoiceStatus.textContent = result.cached ? "已找到缓存，直接切换到该模型音频" : "新模型人声音频已生成并切换";
  }
}

function showMakerEditor(message) {
  uploadPanel?.classList.add("is-hidden");
  bandApp?.classList.remove("is-hidden");
  if (processStatus && message) processStatus.textContent = message;
  setEditMode(true);
}

async function loadPerformanceFromUrl() {
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) {
    stateText.textContent = "缺少演奏 ID";
    return;
  }
  const configUrl = API_BASE
    ? `${API_BASE}/api/performances/${encodeURIComponent(id)}`
    : `./performances/${encodeURIComponent(id)}.json`;
  const response = await fetch(configUrl);
  const config = await response.json();
  if (!response.ok) {
    stateText.textContent = "演奏不存在";
    return;
  }
  performanceConfig = config;
  performanceConfig.sourceJobId = performanceConfig.sourceJobId || jobIdFromTracks(config.tracks || []);
  if (editRvcModelSelect && config.rvcModel) editRvcModelSelect.value = config.rvcModel;
  resetBand(config.tracks || []);
  await loadRvcVariants(performanceConfig.sourceJobId);
  updateVocalSwitchStatus();
}

async function loadPerformanceForEdit() {
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) return;
  if (processStatus) processStatus.textContent = "加载作品...";
  const configUrl = API_BASE
    ? `${API_BASE}/api/performances/${encodeURIComponent(id)}`
    : `./performances/${encodeURIComponent(id)}.json`;
  const response = await fetch(configUrl);
  const config = await response.json();
  if (!response.ok) {
    if (processStatus) processStatus.textContent = "作品不存在";
    return;
  }
  performanceConfig = config;
  performanceConfig.sourceJobId = performanceConfig.sourceJobId || jobIdFromTracks(config.tracks || []);
  if (editRvcModelSelect && config.rvcModel) editRvcModelSelect.value = config.rvcModel;
  resetBand(config.tracks || []);
  await loadRvcVariants(performanceConfig.sourceJobId);
  updateVocalSwitchStatus();
  showMakerEditor("作品已加载");
  stateText.textContent = "编辑中";
}

function bindControls() {
  playPauseButton.addEventListener("click", togglePlayback);
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
    if (!resetSwitchesForSeek(nextTime)) syncToMaster(nextTime);
    seeking = false;
  });
  frameRateSlider.addEventListener("input", () => {
    frameRateValue.textContent = `${frameRateSlider.value} fps`;
  });
  if (editStageButton) editStageButton.addEventListener("click", () => setEditMode(true));
  if (saveStageButton) saveStageButton.addEventListener("click", savePerformance);
  if (revoiceVocalsButton) revoiceVocalsButton.addEventListener("click", revoiceVocals);
  if (addVocalSwitchCueButton) addVocalSwitchCueButton.addEventListener("click", addVocalSwitchCue);
  if (clearVocalSwitchCueButton) clearVocalSwitchCueButton.addEventListener("click", clearVocalSwitchCue);
  if (editRvcModelSelect) editRvcModelSelect.addEventListener("change", updateRevoiceCacheHint);
  if (importModelFolderButton) importModelFolderButton.addEventListener("click", importModelFolder);
  band.addEventListener("pointermove", movePointer);
  band.addEventListener("pointerup", endPointer);
  band.addEventListener("pointercancel", endPointer);
  uploadForm?.addEventListener("submit", processUpload);
}

function attachMetadataListeners() {
  tracks.forEach((track) => {
    track.audioElement.addEventListener("loadedmetadata", () => {
      masterDuration = tracks[0]?.audioElement.duration || 0;
      timeline.max = "1";
      timeText.textContent = `0:00 / ${formatTime(masterDuration)}`;
    });
    track.audioElement.addEventListener("ended", () => {
      if (!anyTrackPlaying()) {
        pauseAll();
        syncToMaster(0);
        timeline.value = "0";
      }
    });
  });
}

bindControls();
frameRateValue.textContent = `${frameRateSlider.value} fps`;
setStatus(false);

async function initMaker() {
  await loadRvcModels();
  await loadPerformanceForEdit();
}

if (MODE === "view") {
  loadPerformanceFromUrl();
} else if (MODE === "make") {
  initMaker();
}
