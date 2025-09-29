const startButton = document.getElementById('start-btn');
const confirmButton = document.getElementById('confirm-btn');
const cancelButton = document.getElementById('cancel-btn');
const statusElement = document.getElementById('status');
const listContainer = document.getElementById('list-container');
const unitListElement = document.getElementById('unit-list');
const refreshLogsButton = document.getElementById('refresh-logs');
const clearLogsButton = document.getElementById('clear-logs');
const requestLogsElement = document.getElementById('request-logs');

let unitIds = [];
let timecodes = [];
let mismatchInfo = { unitCount: 0, timecodeCount: 0, mismatched: false };
let courseContext = null;
let isRunInProgress = false;

function setStatus(message) {
  statusElement.textContent = message;
}

function setStartLoading(isLoading) {
  if (isRunInProgress) {
    return;
  }

  if (isLoading) {
    startButton.disabled = true;
    startButton.textContent = '추출 중...';
  } else {
    startButton.disabled = false;
    startButton.textContent = 'unitId 찾기';
  }
}

function setRunningState(isRunning) {
  isRunInProgress = isRunning;

  if (isRunning) {
    startButton.disabled = true;
    startButton.textContent = '진행 중...';
    confirmButton.disabled = true;
    cancelButton.disabled = false;
  } else {
    startButton.disabled = false;
    startButton.textContent = 'unitId 찾기';
    const hasUnits = unitIds.length > 0;
    confirmButton.disabled = !hasUnits;
    cancelButton.disabled = !hasUnits;
  }
}

function summarizeTimecodesPreview() {
  if (!timecodes.length) {
    return '시간 정보 없음';
  }
  const previewCount = Math.min(5, timecodes.length);
  const preview = timecodes.slice(0, previewCount).map((item, index) => {
    const duration = item?.durationSeconds ?? '?';
    return `#${index + 1}: ${item?.raw || '?'} (${duration}s)`;
  });
  if (timecodes.length > previewCount) {
    preview.push(`... 총 ${timecodes.length}개`);
  }
  return preview.join('\n');
}

function showUnitList(units) {
  unitListElement.innerHTML = '';
  units.forEach((unitId, index) => {
    const li = document.createElement('li');
    const timePreview = timecodes[index]?.raw;
    const display = timePreview ? `예상 시간 ${timePreview}` : '시간 정보 없음';
    li.textContent = `unitId=${unitId} (${display})`;
    unitListElement.appendChild(li);
  });
  listContainer.classList.remove('hidden');
  confirmButton.disabled = units.length === 0;
  cancelButton.disabled = units.length === 0;
}

function resetExtraction() {
  unitIds = [];
  timecodes = [];
  mismatchInfo = { unitCount: 0, timecodeCount: 0, mismatched: false };
  courseContext = null;
  unitListElement.innerHTML = '';
  listContainer.classList.add('hidden');
  confirmButton.disabled = true;
  cancelButton.disabled = true;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript.js']
    });
  } catch (error) {
    throw new Error(`콘텐츠 스크립트를 주입할 수 없습니다: ${error.message}`);
  }
}

function describeMismatch(info) {
  if (!info.mismatched) {
    return '';
  }
  return `\n⚠️ unitId ${info.unitCount}개, 시간 정보 ${info.timecodeCount}개로 개수가 맞지 않습니다. 영상이 아닌 unit은 자동으로 건너뜁니다.`;
}

function describeCourseContext(context) {
  if (!context || !context.courseId) {
    return '\n⚠️ 강의 ID를 찾지 못했습니다. 필요한 경우 수동으로 unit 페이지를 열어야 할 수 있습니다.';
  }
  const params = [
    `courseId=${context.courseId}`,
    `tab=${context.tab}`,
    `type=${context.type}`,
    `subtitleLanguage=${context.subtitleLanguage}`
  ].join(', ');
  return `\n강의 페이지 컨텍스트: ${params}`;
}

async function requestEntriesFromPage() {
  setStatus('페이지에서 unitId와 시간 정보를 추출하는 중...');
  setStartLoading(true);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id === undefined) {
      throw new Error('활성 탭을 찾을 수 없습니다.');
    }

    await ensureContentScript(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_UNIT_DATA' });

    const units = response?.unitIds || [];
    if (!units.length) {
      resetExtraction();
      setStatus('unitId를 찾지 못했습니다. 페이지를 확인하세요.');
      return;
    }

    unitIds = units;
    timecodes = response?.timecodes || [];
    mismatchInfo = response?.mismatchInfo || { unitCount: units.length, timecodeCount: timecodes.length, mismatched: units.length !== timecodes.length };
    courseContext = response?.courseContext || null;

    showUnitList(unitIds);
    const preview = summarizeTimecodesPreview();
    setStatus(`총 ${unitIds.length}개의 unitId를 찾았습니다.${describeMismatch(mismatchInfo)}${describeCourseContext(courseContext)}\n시간 정보 미리보기:\n${preview}\n확인 후 "요청 보내기"를 눌러주세요.`);
  } catch (error) {
    resetExtraction();
    setStatus(error.message.includes('Receiving end does not exist')
      ? '콘텐츠 스크립트를 불러오지 못했습니다. 페이지를 새로고침하고 다시 시도하세요.'
      : `예기치 못한 오류: ${error.message}`);
  } finally {
    setStartLoading(false);
  }
}

function startCompletionRequests() {
  if (!unitIds.length) {
    setStatus('보낼 unitId가 없습니다. 다시 추출하세요.');
    return;
  }

  setStatus('요청을 시작합니다...');
  setRunningState(true);

  chrome.runtime.sendMessage({ type: 'START_COMPLETION', unitIds, timecodes, courseContext }, (response) => {
    if (chrome.runtime.lastError) {
      setRunningState(false);
      setStatus(`백그라운드 오류: ${chrome.runtime.lastError.message}`);
      return;
    }

    switch (response?.status) {
      case 'started':
        setStatus(`총 ${response.total}개의 unitId에 대해 검증 후 요청을 보냅니다.${describeMismatch(mismatchInfo)}${describeCourseContext(courseContext)}`);
        loadRequestLogs();
        break;
      case 'already-running':
        setStatus('이미 요청이 진행 중입니다. 잠시만 기다려주세요.');
        setRunningState(true);
        break;
      case 'no-entries':
        setStatus('전달된 unitId가 없습니다. 다시 시도하세요.');
        setRunningState(false);
        break;
      default:
        setRunningState(false);
        setStatus('요청을 시작하지 못했습니다. 다시 시도하세요.');
    }
  });
}

function renderRequestLogs(logs) {
  requestLogsElement.innerHTML = '';

  if (!logs.length) {
    const empty = document.createElement('li');
    empty.textContent = '로그가 아직 없습니다.';
    requestLogsElement.appendChild(empty);
    return;
  }

  logs.slice().reverse().forEach((log) => {
    const lines = [];
    const time = new Date(log.timestamp).toLocaleTimeString();
    const unitIdLabel = log.unitId !== undefined && log.unitId !== null ? `unitId=${log.unitId}` : 'unitId=알 수 없음';
    const phaseLabel = log.phase ? ` (${log.phase})` : '';

    lines.push(`${time} | ${unitIdLabel} | ${log.status}${phaseLabel}`);

    if (log.request) {
      lines.push(`→ ${log.request.method} ${log.request.url}`);
      if (log.request.headers) {
        lines.push(`  headers: ${JSON.stringify(log.request.headers)}`);
      }
      if (log.request.body) {
        lines.push(`  body: ${log.request.body}`);
      }
    }

    if (log.response) {
      lines.push(`← status ${log.response.status} (${log.response.ok ? 'ok' : 'error'})`);
      if (log.response.bodySnippet) {
        lines.push(`  response: ${log.response.bodySnippet}`);
      }
    }

    if (log.blockedHeaders?.length) {
      lines.push('  blocked headers:');
      log.blockedHeaders.forEach((blocked) => {
        lines.push(`    ${blocked.key}: ${blocked.value} (${blocked.error || '차단됨'})`);
      });
    }

    if (log.visit) {
      lines.push(`  visit: ${JSON.stringify(log.visit)}`);
    }

    if (log.message) {
      lines.push(`  message: ${log.message}`);
    }

    if (log.meta) {
      lines.push(`  meta: ${JSON.stringify(log.meta)}`);
    }

    const li = document.createElement('li');
    li.textContent = lines.join('\n');

    if (log.status === 'success') {
      li.classList.add('log-success');
    } else if (log.status === 'error') {
      li.classList.add('log-error');
    }

    requestLogsElement.appendChild(li);
  });
}

async function loadRequestLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_REQUEST_LOGS' });
    renderRequestLogs(response?.logs || []);
  } catch (error) {
    const li = document.createElement('li');
    li.textContent = `로그를 불러오지 못했습니다: ${error.message}`;
    requestLogsElement.innerHTML = '';
    requestLogsElement.appendChild(li);
  }
}

async function clearRequestLogs() {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_REQUEST_LOGS' });
    renderRequestLogs([]);
  } catch (error) {
    setStatus(`로그 초기화 실패: ${error.message}`);
  }
}

startButton.addEventListener('click', () => {
  if (isRunInProgress) {
    return;
  }
  requestEntriesFromPage();
});

confirmButton.addEventListener('click', () => {
  if (isRunInProgress) {
    return;
  }
  startCompletionRequests();
});

cancelButton.addEventListener('click', () => {
  if (isRunInProgress) {
    setStatus('취소 요청을 전송했습니다. 잠시만 기다려주세요.');
    cancelButton.disabled = true;
    chrome.runtime.sendMessage({ type: 'CANCEL_COMPLETION' }, (response) => {
      if (chrome.runtime.lastError) {
        cancelButton.disabled = false;
        setStatus(`취소 요청 실패: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (response?.status === 'idle') {
        cancelButton.disabled = false;
        setRunningState(false);
        setStatus('진행 중인 작업이 없어 취소할 것이 없습니다.');
      }
    });
    return;
  }

  resetExtraction();
  setStatus('대상 unitId를 찾는 중이 아닙니다.');
});

refreshLogsButton.addEventListener('click', () => {
  loadRequestLogs();
});

clearLogsButton.addEventListener('click', () => {
  clearRequestLogs();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'COMPLETION_PROGRESS') {
    return;
  }

  const {
    processed = 0,
    total = 0,
    skipped = 0,
    lastUnitId = null,
    status = 'idle',
    errorMessage
  } = message.payload || {};

  if (status === 'running') {
    setRunningState(true);
    const skippedText = skipped ? `, 건너뜀 ${skipped}개` : '';
    setStatus(`총 ${total}개 중 ${processed}개 처리${skippedText} (최근 unitId: ${lastUnitId ?? '없음'})`);
    cancelButton.disabled = false;
    loadRequestLogs();
  } else if (status === 'done') {
    const skippedText = skipped ? ` (건너뜀 ${skipped}개)` : '';
    setStatus(`모든 요청 완료 (${total}개)${skippedText}.`);
    setRunningState(false);
    resetExtraction();
    loadRequestLogs();
  } else if (status === 'cancelled') {
    const skippedText = skipped ? ` (건너뜀 ${skipped}개)` : '';
    setStatus(`사용자가 요청을 취소했습니다.${skippedText}`);
    setRunningState(false);
    loadRequestLogs();
  } else if (status === 'error') {
    setStatus(`오류 발생: ${errorMessage || '알 수 없음'}`);
    setRunningState(false);
    resetExtraction();
    loadRequestLogs();
  } else if (status === 'idle') {
    setRunningState(false);
  }
});

chrome.runtime.sendMessage({ type: 'COMPLETION_STATUS_REQUEST' }, (response) => {
  if (!response) {
    return;
  }

  const { status, processed = 0, total = 0, skipped = 0, lastUnitId = null } = response;

  if (status === 'running') {
    setRunningState(true);
    const skippedText = skipped ? `, 건너뜀 ${skipped}개` : '';
    setStatus(`총 ${total}개 중 ${processed}개 처리${skippedText} (최근 unitId: ${lastUnitId ?? '없음'})`);
  }

  loadRequestLogs();
});

resetExtraction();
setStartLoading(false);
loadRequestLogs();
