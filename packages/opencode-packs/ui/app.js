const state = {
  packs: [],
  selectedPack: null,
  selectedInvocationId: null,
};

const packList = document.querySelector('#pack-list');
const packSearch = document.querySelector('#pack-search');
const packTitle = document.querySelector('#pack-title');
const packDescription = document.querySelector('#pack-description');
const packAgent = document.querySelector('#pack-agent');
const packMode = document.querySelector('#pack-mode');
const packExamplesCount = document.querySelector('#pack-examples-count');
const contractView = document.querySelector('#contract-view');
const renderedPrompt = document.querySelector('#rendered-prompt');
const examplesView = document.querySelector('#examples-view');
const handoffView = document.querySelector('#handoff-view');
const historyList = document.querySelector('#history-list');
const invocationDetail = document.querySelector('#invocation-detail');
const validationResult = document.querySelector('#validation-result');

const requestInput = document.querySelector('#request');
const contextInput = document.querySelector('#context');
const constraintsInput = document.querySelector('#constraints');
const channelInput = document.querySelector('#channel');
const outputJsonInput = document.querySelector('#output-json');

document.querySelector('#render-button').addEventListener('click', handleRender);
document.querySelector('#execute-button').addEventListener('click', handleExecute);
document.querySelector('#validate-button').addEventListener('click', handleValidate);
document.querySelector('#complete-button').addEventListener('click', handleComplete);
document.querySelector('#refresh-history').addEventListener('click', () => loadHistory());
packSearch.addEventListener('input', renderPackList);

for (const button of document.querySelectorAll('.tab-button')) {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
}

init().catch((error) => {
  validationResult.textContent = error.message;
  validationResult.className = 'status-box bad';
});

async function init() {
  const response = await fetchJson('/api/packs');
  state.packs = response.packs;
  renderPackList();
  if (state.packs.length > 0) {
    await selectPack(state.packs[0].name);
  }
  await loadHistory();
}

function renderPackList() {
  const query = packSearch.value.trim().toLowerCase();
  const visible = state.packs.filter((pack) => {
    if (!query) {
      return true;
    }
    return `${pack.name} ${pack.title} ${pack.description}`.toLowerCase().includes(query);
  });

  packList.innerHTML = '';
  for (const pack of visible) {
    const button = document.createElement('button');
    button.className = `pack-chip${state.selectedPack?.name === pack.name ? ' active' : ''}`;
    button.innerHTML = `<strong>${pack.title}</strong><small>${pack.description}</small>`;
    button.addEventListener('click', () => selectPack(pack.name));
    packList.appendChild(button);
  }
}

async function selectPack(packName) {
  state.selectedPack = await fetchJson(`/api/packs/${encodeURIComponent(packName)}`);
  packTitle.textContent = state.selectedPack.title;
  packDescription.textContent = state.selectedPack.description;
  packAgent.textContent = state.selectedPack.agentPreset.preferredAgent;
  packMode.textContent = state.selectedPack.agentPreset.mode;
  packExamplesCount.textContent = String(state.selectedPack.examples.length);
  contractView.textContent = JSON.stringify(state.selectedPack.outputContract, null, 2);
  examplesView.innerHTML = '';
  for (const example of state.selectedPack.examples) {
    const card = document.createElement('article');
    card.className = 'example-card';
    card.innerHTML = `<h4>${example.description}</h4><pre class="code-block">${escapeHtml(JSON.stringify(example, null, 2))}</pre>`;
    examplesView.appendChild(card);
  }
  requestInput.value = state.selectedPack.examples[0]?.input.request ?? requestInput.value;
  contextInput.value = state.selectedPack.examples[0]?.input.context ?? contextInput.value;
  constraintsInput.value = (state.selectedPack.examples[0]?.input.constraints ?? []).join('\n');
  renderedPrompt.textContent = 'Render output will appear here.';
  handoffView.textContent = 'Remote handoff preview will appear here after execution.';
  renderPackList();
}

async function handleRender() {
  if (!state.selectedPack) {
    return;
  }
  const payload = buildPayload();
  const rendered = await postJson('/api/render', payload);
  renderedPrompt.textContent = rendered.prompt;
  contractView.textContent = JSON.stringify(rendered.outputContract, null, 2);
  setStatus('Rendered pack payload.', true);
  selectTab('render');
}

async function handleExecute() {
  if (!state.selectedPack) {
    return;
  }
  const payload = buildPayload();
  const invocation = await postJson('/api/execute', payload);
  state.selectedInvocationId = invocation.invocationId;
  handoffView.textContent = JSON.stringify(invocation.handoff, null, 2);
  invocationDetail.textContent = JSON.stringify(invocation, null, 2);
  await loadHistory();
  setStatus(`Prepared ${invocation.invocationId}.`, true);
  selectTab('handoff');
}

async function handleValidate() {
  if (!state.selectedPack) {
    return;
  }
  const output = outputJsonInput.value.trim();
  const result = await postJson('/api/validate', {
    packName: state.selectedPack.name,
    output,
  });
  if (result.valid) {
    setStatus('Output matches the selected contract.', true);
  } else {
    setStatus(result.errors.join('\n'), false);
  }
}

async function handleComplete() {
  if (!state.selectedInvocationId) {
    setStatus('Select or prepare an invocation first.', false);
    return;
  }
  const output = outputJsonInput.value.trim();
  const invocation = await postJson('/api/complete', {
    invocationId: state.selectedInvocationId,
    output,
  });
  invocationDetail.textContent = JSON.stringify(invocation, null, 2);
  await loadHistory();
  if (invocation.status === 'completed') {
    setStatus(`Completed ${invocation.invocationId}.`, true);
  } else {
    setStatus((invocation.completion?.errors ?? ['Validation failed.']).join('\n'), false);
  }
}

async function loadHistory() {
  const history = await fetchJson('/api/history?limit=20');
  historyList.innerHTML = '';
  for (const entry of history.entries) {
    const button = document.createElement('button');
    button.className = 'history-entry';
    button.innerHTML = `<strong>${entry.packName}</strong><small>${entry.action} · ${entry.status} · ${entry.at}</small>`;
    button.addEventListener('click', () => selectInvocation(entry.invocationId));
    historyList.appendChild(button);
  }
  if (history.entries.length === 0) {
    historyList.innerHTML = '<div class="muted">No pack invocations yet.</div>';
  }
}

async function selectInvocation(invocationId) {
  state.selectedInvocationId = invocationId;
  const invocation = await fetchJson(`/api/invocations/${encodeURIComponent(invocationId)}`);
  invocationDetail.textContent = JSON.stringify(invocation, null, 2);
  handoffView.textContent = JSON.stringify(invocation.handoff, null, 2);
  if (invocation.completion?.output) {
    outputJsonInput.value = JSON.stringify(invocation.completion.output, null, 2);
  }
}

function buildPayload() {
  return {
    packName: state.selectedPack.name,
    request: requestInput.value.trim(),
    context: contextInput.value.trim(),
    constraints: constraintsInput.value.split('\n').map((line) => line.trim()).filter(Boolean),
    channel: channelInput.value,
  };
}

function setStatus(message, good) {
  validationResult.textContent = message;
  validationResult.className = `status-box ${good ? 'good' : 'bad'}`;
}

function selectTab(tabName) {
  for (const button of document.querySelectorAll('.tab-button')) {
    button.classList.toggle('active', button.dataset.tab === tabName);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('active', panel.id === `${tabName}-tab`);
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error((await response.json()).error || `Request failed: ${response.status}`);
  }
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body;
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
