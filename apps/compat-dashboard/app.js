const RESULTS_BASE = "./results";
const SAMPLE_BASE = "./sample-results";

const ICONS = {
  pass: "✓",
  partial: "~",
  fail: "✗",
  none: "−",
};

async function loadJson(name) {
  try {
    const response = await fetch(`${RESULTS_BASE}/${name}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    const response = await fetch(`${SAMPLE_BASE}/${name}`);
    if (!response.ok) throw new Error(`Failed to load ${name}: ${error.message}`);
    return await response.json();
  }
}

function formatPercentage(value, total) {
  if (total === 0) return "0%";
  return `${Math.round((value / total) * 100)}%`;
}

function getModuleClass(module_) {
  if (module_.total === 0) return "none";
  if (module_.passed === module_.total) return "pass";
  if (module_.passed === 0) return "fail";
  return "partial";
}

function getModuleStatus(module_) {
  const cls = getModuleClass(module_);
  const ratio = `${module_.passed}/${module_.total}`;
  switch (cls) {
    case "pass":
      return `${ratio} ${ICONS.pass}`;
    case "partial":
      return `${ratio} ${ICONS.partial}`;
    case "fail":
      return `${ratio} ${ICONS.fail}`;
    default:
      return `${ratio} ${ICONS.none}`;
  }
}

function createModuleCard(module_) {
  const card = document.createElement("button");
  card.className = `module-card ${getModuleClass(module_)}`;
  card.setAttribute("type", "button");
  card.setAttribute("aria-expanded", "false");

  const name = document.createElement("span");
  name.className = "module-name";
  name.textContent = module_.name;

  const ratio = document.createElement("span");
  ratio.className = "module-ratio";
  ratio.textContent = `${module_.passed} of ${module_.total} tests passed`;

  const status = document.createElement("span");
  status.className = "module-status";
  status.textContent = getModuleStatus(module_);

  const detail = document.createElement("div");
  detail.className = "module-detail";
  detail.appendChild(createTestList(module_.tests || []));

  card.appendChild(name);
  card.appendChild(ratio);
  card.appendChild(status);
  card.appendChild(detail);

  card.addEventListener("click", () => {
    const expanded = card.getAttribute("aria-expanded") === "true";
    card.setAttribute("aria-expanded", String(!expanded));
  });

  return card;
}

function createTestList(tests) {
  const list = document.createElement("ul");
  list.className = "test-list";

  if (tests.length === 0) {
    const item = document.createElement("li");
    item.className = "test-item skip";
    item.textContent = "No test details available.";
    list.appendChild(item);
    return list;
  }

  for (const test of tests) {
    const item = document.createElement("li");
    item.className = `test-item ${test.status}`;

    const file = document.createElement("span");
    file.className = "test-file";
    file.textContent = test.file;

    const status = document.createElement("span");
    status.className = "test-status";
    status.textContent = test.status;

    item.appendChild(file);
    item.appendChild(status);

    if (test.error) {
      const error = document.createElement("p");
      error.className = "test-error";
      error.textContent = test.error;
      item.appendChild(error);
    }

    list.appendChild(item);
  }

  return list;
}

function renderModules(data) {
  const grid = document.getElementById("module-grid");
  const meta = document.getElementById("compat-meta");
  const percentage = document.getElementById("node-percentage");
  grid.innerHTML = "";

  if (!data || !data.modules || data.modules.length === 0) {
    grid.appendChild(createEmptyState("No module data yet."));
    meta.textContent = "";
    percentage.textContent = "N/A";
    return;
  }

  const total = data.modules.reduce((sum, m) => sum + m.total, 0);
  const passed = data.modules.reduce((sum, m) => sum + m.passed, 0);
  const generated = data.generatedAt ? new Date(data.generatedAt).toLocaleString() : "unknown";

  percentage.textContent = formatPercentage(passed, total);
  meta.textContent = `Node ${data.nodeVersion ?? "unknown"} • ${passed}/${total} tests passed • generated ${generated}`;

  for (const module_ of data.modules) {
    grid.appendChild(createModuleCard(module_));
  }
}

function createPackageGroup(title, packages) {
  const group = document.createElement("div");
  group.className = "package-group";

  const heading = document.createElement("h3");
  heading.textContent = title;
  group.appendChild(heading);

  const list = document.createElement("ul");
  list.className = "package-list";

  for (const pkg of packages) {
    const item = document.createElement("li");
    item.className = "package-item";

    const name = document.createElement("span");
    name.className = "package-name";
    name.textContent = pkg.name;

    const status = document.createElement("span");
    status.className = `package-status ${pkg.status}`;
    status.textContent = `${pkg.status} ${ICONS[pkg.status] ?? ICONS.none}`;

    item.appendChild(name);
    item.appendChild(status);

    if (pkg.error) {
      const error = document.createElement("p");
      error.className = "package-error";
      error.textContent = pkg.error;
      item.appendChild(error);
    }

    list.appendChild(item);
  }

  group.appendChild(list);
  return group;
}

function renderPackages(data) {
  const container = document.getElementById("package-matrix");
  container.innerHTML = "";

  if (!data || !data.packages || data.packages.length === 0) {
    container.appendChild(createEmptyState("No package matrix data yet."));
    return;
  }

  const groups = new Map();
  for (const pkg of data.packages) {
    const key = pkg.class ?? "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(pkg);
  }

  for (const [className, packages] of groups) {
    container.appendChild(createPackageGroup(className, packages));
  }
}

function createEmptyState(message) {
  const state = document.createElement("div");
  state.className = "empty-state";

  const title = document.createElement("p");
  title.className = "empty-state-title";
  title.textContent = "No data";

  const desc = document.createElement("p");
  desc.className = "empty-state-desc";
  desc.textContent = message;

  state.appendChild(title);
  state.appendChild(desc);
  return state;
}

function renderError(message) {
  document.getElementById("node-percentage").textContent = "N/A";
  document.getElementById("compat-meta").textContent = message;
  document.getElementById("module-grid").innerHTML = "";
  document
    .getElementById("module-grid")
    .appendChild(createEmptyState("Could not load compatibility data."));
  document.getElementById("package-matrix").innerHTML = "";
  document
    .getElementById("package-matrix")
    .appendChild(createEmptyState("Could not load package data."));
}

async function init() {
  try {
    const [nodeCompat, packageMatrix] = await Promise.all([
      loadJson("node-compat.json"),
      loadJson("package-matrix.json"),
    ]);
    renderModules(nodeCompat);
    renderPackages(packageMatrix);
  } catch (error) {
    renderError(String(error));
  }
}

init();
