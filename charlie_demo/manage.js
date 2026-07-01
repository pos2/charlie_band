const API_BASE = window.CHARLIE_BAND_API_BASE ?? "http://127.0.0.1:8787";

const performanceList = document.querySelector("#performanceList");
const jobList = document.querySelector("#jobList");
const modelList = document.querySelector("#modelList");
const modelImportForm = document.querySelector("#modelImportForm");
const modelFolderPath = document.querySelector("#modelFolderPath");
const modelImportStatus = document.querySelector("#modelImportStatus");
const refreshButton = document.querySelector("#refreshManager");

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return "-";
  const date = typeof timestamp === "number" ? new Date(timestamp * 1000) : new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function itemNode({ title, meta, actions }) {
  const node = document.createElement("article");
  node.className = "manager-item";
  node.innerHTML = `
    <div>
      <strong></strong>
      <p></p>
    </div>
    <div class="manager-actions"></div>
  `;
  node.querySelector("strong").textContent = title;
  node.querySelector("p").textContent = meta;
  const actionRoot = node.querySelector(".manager-actions");
  actions.forEach((action) => actionRoot.append(action));
  return node;
}

function actionButton(label, onClick) {
  const button = document.createElement("button");
  button.className = "compact-action";
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

async function deleteResource(url, label) {
  if (!window.confirm(`确定删除 ${label}？`)) return;
  const response = await fetch(url, { method: "DELETE" });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    window.alert(`删除失败: ${result.detail || response.status}`);
    return;
  }
  await loadManager();
}

function renderPerformances(items) {
  performanceList.innerHTML = "";
  if (!items.length) {
    performanceList.textContent = "暂无作品";
    return;
  }
  items.forEach((item) => {
    const openUrl = `./performance.html?id=${encodeURIComponent(item.id)}`;
    const editUrl = `./make.html?id=${encodeURIComponent(item.id)}`;
    performanceList.append(
      itemNode({
        title: item.input_name || item.id,
        meta: `作品 ${item.id} · ${item.tracks} 条音轨 · ${item.sourceJobId || "无 job"} · ${formatSize(item.size_bytes)} · ${formatDate(item.createdAt || item.updatedAt)}`,
        actions: [
          actionButton("打开", () => window.open(openUrl, "_blank")),
          actionButton("编辑", () => window.open(editUrl, "_blank")),
          actionButton("删除配置", () => deleteResource(`${API_BASE}/api/performances/${encodeURIComponent(item.id)}`, item.id)),
        ],
      }),
    );
  });
}

function renderJobs(items) {
  jobList.innerHTML = "";
  if (!items.length) {
    jobList.textContent = "暂无处理产物";
    return;
  }
  items.forEach((item) => {
    jobList.append(
      itemNode({
        title: item.input_name || item.id,
        meta: `job ${item.id} · ${item.tracks} 条分轨 · ${item.rvc_model || "-"} · ${formatSize(item.size_bytes)} · ${formatDate(item.updatedAt)}`,
        actions: [
          actionButton("删除音频", () => deleteResource(`${API_BASE}/api/pipeline/jobs/${encodeURIComponent(item.id)}`, item.id)),
        ],
      }),
    );
  });
}

function renderModels(result) {
  const items = result.models || [];
  modelList.innerHTML = "";
  if (!items.length) {
    modelList.textContent = "暂无模型";
    return;
  }
  items.forEach((item) => {
    modelList.append(
      itemNode({
        title: item.label,
        meta: `${item.value} · ${item.has_index ? "已安装 index" : "无 index"}${item.default ? " · 默认模型" : ""}`,
        actions: [
          actionButton("删除模型", () => deleteResource(`${API_BASE}/api/rvc/models/${encodeURIComponent(item.value)}`, item.value)),
        ].filter(() => !item.default),
      }),
    );
  });
}

async function importModelFolder(event) {
  event.preventDefault();
  const folderPath = modelFolderPath.value.trim();
  if (!folderPath) return;
  modelImportStatus.textContent = "导入模型中...";
  modelImportStatus.classList.add("is-working");
  const submitButton = modelImportForm.querySelector("button");
  submitButton.disabled = true;
  const form = new FormData();
  form.append("folder_path", folderPath);
  const response = await fetch(`${API_BASE}/api/rvc/models/import-folder`, { method: "POST", body: form });
  const result = await response.json();
  submitButton.disabled = false;
  modelImportStatus.classList.remove("is-working");
  if (!response.ok) {
    modelImportStatus.textContent = `导入失败: ${result.detail || response.status}`;
    return;
  }
  modelImportStatus.textContent = "模型已导入";
  modelFolderPath.value = "";
  renderModels(result);
}

async function loadManager() {
  performanceList.textContent = "加载中...";
  jobList.textContent = "加载中...";
  modelList.textContent = "加载中...";
  const [performancesResponse, jobsResponse, modelsResponse] = await Promise.all([
    fetch(`${API_BASE}/api/performances`),
    fetch(`${API_BASE}/api/pipeline/jobs`),
    fetch(`${API_BASE}/api/rvc/models`),
  ]);
  const performances = await performancesResponse.json();
  const jobs = await jobsResponse.json();
  const models = await modelsResponse.json();
  renderPerformances(performances.performances || []);
  renderJobs(jobs.jobs || []);
  renderModels(models);
}

refreshButton.addEventListener("click", loadManager);
modelImportForm.addEventListener("submit", importModelFolder);
loadManager().catch((error) => {
  performanceList.textContent = `加载失败: ${error.message}`;
  jobList.textContent = `加载失败: ${error.message}`;
  modelList.textContent = `加载失败: ${error.message}`;
});
