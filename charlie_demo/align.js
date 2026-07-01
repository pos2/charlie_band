const API_BASE = "http://127.0.0.1:8787";
const CHARACTERS = [
  { id: "vocal", label: "Vocal" },
  { id: "vocal_cos_weeknd", label: "Vocal Weeknd" },
  { id: "drum", label: "Drums" },
  { id: "piano", label: "Piano" },
  { id: "guitar", label: "Guitar" },
  { id: "bass", label: "Bass" },
  { id: "dj", label: "DJ" },
];

const state = {
  config: null,
  character: "vocal",
  frame: 1,
  useTransparent: false,
};

const characterTabs = document.querySelector("#characterTabs");
const frameStrip = document.querySelector("#frameStrip");
const alignmentCanvas = document.querySelector("#alignmentCanvas");
const activeFrame = document.querySelector("#activeFrame");
const referenceFrame = document.querySelector("#referenceFrame");
const panelTitle = document.querySelector("#panelTitle");
const panelSubtitle = document.querySelector("#panelSubtitle");
const removeBackground = document.querySelector("#removeBackground");
const offsetX = document.querySelector("#offsetX");
const offsetY = document.querySelector("#offsetY");
const offsetXValue = document.querySelector("#offsetXValue");
const offsetYValue = document.querySelector("#offsetYValue");
const onionToggle = document.querySelector("#onionToggle");
const transparentToggle = document.querySelector("#transparentToggle");
const resetFrame = document.querySelector("#resetFrame");
const processFrames = document.querySelector("#processFrames");
const statusLog = document.querySelector("#statusLog");

function log(message) {
  statusLog.textContent = message;
}

function defaultOffsets() {
  return Object.fromEntries(Array.from({ length: 6 }, (_, idx) => [String(idx + 1), [0, 0]]));
}

function ensureCharacterConfig(id) {
  state.config.defaults ||= { removeBackground: true, offsets: defaultOffsets() };
  state.config.characters ||= {};
  state.config.characters[id] ||= {
    removeBackground: state.config.defaults.removeBackground ?? true,
    offsets: defaultOffsets(),
  };
  state.config.characters[id].offsets ||= defaultOffsets();
  return state.config.characters[id];
}

function frameSrc(id, frame, transparent = false) {
  const root = transparent ? "./assets/characters/aligned" : "./assets/characters";
  return `${root}/${id}/frame-${frame}.png?cache=${Date.now()}`;
}

function currentOffset() {
  const charConfig = ensureCharacterConfig(state.character);
  return charConfig.offsets[String(state.frame)] || [0, 0];
}

function setCurrentOffset(x, y) {
  const charConfig = ensureCharacterConfig(state.character);
  charConfig.offsets[String(state.frame)] = [x, y];
}

function renderTabs() {
  characterTabs.innerHTML = "";
  for (const character of CHARACTERS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = character.label;
    button.classList.toggle("is-active", character.id === state.character);
    button.addEventListener("click", () => {
      state.character = character.id;
      state.frame = 1;
      render();
    });
    characterTabs.append(button);
  }
}

function renderFrameStrip() {
  frameStrip.innerHTML = "";
  for (let frame = 1; frame <= 6; frame += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("is-active", frame === state.frame);
    const image = document.createElement("img");
    image.src = frameSrc(state.character, frame, state.useTransparent);
    image.alt = `frame ${frame}`;
    button.append(image);
    button.addEventListener("click", () => {
      state.frame = frame;
      render();
    });
    frameStrip.append(button);
  }
}

function renderCanvas() {
  const [x, y] = currentOffset();
  activeFrame.onload = () => {
    if (activeFrame.naturalWidth && activeFrame.naturalHeight) {
      alignmentCanvas.style.width = `${activeFrame.naturalWidth}px`;
      alignmentCanvas.style.height = `${activeFrame.naturalHeight}px`;
    }
  };
  activeFrame.src = frameSrc(state.character, state.frame, state.useTransparent);
  referenceFrame.src = frameSrc(state.character, 1, state.useTransparent);
  activeFrame.style.transform = state.useTransparent ? "translate(0, 0)" : `translate(${x}px, ${y}px)`;
  referenceFrame.style.transform = "translate(0, 0)";
  referenceFrame.style.display = onionToggle.checked && state.frame !== 1 ? "block" : "none";
}

function renderPanel() {
  const char = CHARACTERS.find((item) => item.id === state.character);
  const charConfig = ensureCharacterConfig(state.character);
  const [x, y] = currentOffset();

  panelTitle.textContent = `${char.label} · 第 ${state.frame} 帧`;
  panelSubtitle.textContent = state.character;
  removeBackground.checked = charConfig.removeBackground !== false;
  offsetX.value = x;
  offsetY.value = y;
  offsetXValue.textContent = x;
  offsetYValue.textContent = y;
}

function render() {
  renderTabs();
  renderFrameStrip();
  renderCanvas();
  renderPanel();
}

function updateOffsetFromInputs() {
  const x = Number(offsetX.value);
  const y = Number(offsetY.value);
  setCurrentOffset(x, y);
  renderCanvas();
  renderPanel();
}

async function loadConfig() {
  const response = await fetch(`${API_BASE}/api/alignment/config`);
  if (!response.ok) throw new Error(`读取配置失败: ${response.status}`);
  state.config = await response.json();
  for (const character of CHARACTERS) {
    ensureCharacterConfig(character.id);
  }
  render();
  log("配置已加载");
}

async function saveCurrentConfig() {
  const response = await fetch(`${API_BASE}/api/alignment/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.config),
  });
  if (!response.ok) throw new Error(`保存失败: ${response.status}`);
  return response.json();
}

async function regenerateFrames() {
  log("正在导出方框内素材...");
  await saveCurrentConfig();
  const response = await fetch(`${API_BASE}/api/alignment/process`, { method: "POST" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail?.message || `生成失败: ${response.status}`);
  state.useTransparent = true;
  transparentToggle.checked = true;
  render();
  log(`已导出到:\n/Users/pos2/Documents/audio/charlie_demo/assets/characters/aligned\n${result.log || ""}`);
}

removeBackground.addEventListener("change", () => {
  const charConfig = ensureCharacterConfig(state.character);
  charConfig.removeBackground = removeBackground.checked;
});

offsetX.addEventListener("input", updateOffsetFromInputs);
offsetY.addEventListener("input", updateOffsetFromInputs);
onionToggle.addEventListener("change", renderCanvas);
transparentToggle.addEventListener("change", () => {
  state.useTransparent = transparentToggle.checked;
  render();
});

resetFrame.addEventListener("click", () => {
  setCurrentOffset(0, 0);
  render();
});

document.querySelectorAll("[data-nudge]").forEach((button) => {
  button.addEventListener("click", () => {
    const [dx, dy] = button.dataset.nudge.split(",").map(Number);
    const [x, y] = currentOffset();
    setCurrentOffset(x + dx, y + dy);
    render();
  });
});

processFrames.addEventListener("click", () => {
  regenerateFrames().catch((error) => log(error.message));
});

loadConfig().catch((error) => log(error.message));
