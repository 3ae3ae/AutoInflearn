const API_URL = 'https://www.inflearn.com/api/v2/unit/complete/current-time';
const USER_ID = 1634556;
const COOKIE_VALUE = 'connect.sid=s%3A4mOr5GPjrSER9SgGeuINj2RKBWmeCFty.F3anYwh6EG2una7taN%2Fm7wAxIBaTIGJA56nRviSfXW8; connectedSidString=connect.sid=s%3A4mOr5GPjrSER9SgGeuINj2RKBWmeCFty.F3anYwh6EG2una7taN%2Fm7wAxIBaTIGJA56nRviSfXW8*** Domain=.inflearn.com*** Path=/*** Expires=Mon; deviceId=daf8a4db-7540-49ee-abb0-60d450e7de11';
const LECTURE_URL_BASE = 'https://www.inflearn.com/courses/lecture';

let currentRun = null;
let requestLogs = [];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRandomDelay() {
  const min = 200;
  const max = 800;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function appendLog(entry) {
  requestLogs.push({
    timestamp: new Date().toISOString(),
    ...entry
  });

  if (requestLogs.length > 200) {
    requestLogs = requestLogs.slice(-200);
  }
}

function buildHeaders() {
  const headers = new Headers({
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json'
  });
  const blockedHeaders = [];

  const desiredHeaders = [
    ['referer', 'inflearn-mobile://CourseDetail'],
    ['user-agent', 'Android/15 (InflearnMobile 2025.908.28;)'],
    ['accept-encoding', 'gzip'],
    ['cookie', COOKIE_VALUE]
  ];

  for (const [key, value] of desiredHeaders) {
    try {
      headers.set(key, value);
    } catch (error) {
      blockedHeaders.push({ key, value, error: error.message });
    }
  }

  return {
    headers,
    appliedHeaders: Object.fromEntries(headers.entries()),
    blockedHeaders
  };
}

function buildPayload(unitId, durationSeconds) {
  const prevRequestTime = Date.now() - 60_000;
  return {
    unitId,
    userId: USER_ID,
    currentTime: durationSeconds,
    prevRequestTime
  };
}

function buildLectureUrl(unitId, context) {
  if (!context || !context.courseId) {
    return null;
  }

  const url = new URL(LECTURE_URL_BASE);
  url.searchParams.set('courseId', context.courseId);
  url.searchParams.set('tab', context.tab || 'curriculum');
  url.searchParams.set('type', context.type || 'LECTURE');
  url.searchParams.set('unitId', unitId);
  return url.toString();
}

function waitForTabComplete(tabId, cancelPredicate = () => false, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => cleanup({ status: 'timeout' }), timeoutMs);
    const poll = setInterval(() => {
      if (!settled && cancelPredicate()) {
        cleanup({ status: 'cancelled' });
      }
    }, 150);

    function cleanup(result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve(result);
    }

    function handleUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup({ status: 'complete' });
      }
    }

    chrome.tabs.onUpdated.addListener(handleUpdated);
  });
}

async function visitLecturePage(unitId, context) {
  const targetUrl = buildLectureUrl(unitId, context);
  if (!targetUrl) {
    appendLog({
      unitId,
      phase: 'visit',
      status: 'skipped',
      message: 'courseId 정보가 없어 강의 페이지를 열지 않습니다.'
    });
    return { tabId: null, result: 'skipped', url: null };
  }

  try {
    const createdTab = await chrome.tabs.create({ url: targetUrl, active: false });
    const tabId = createdTab.id;
    const waitResult = await waitForTabComplete(tabId, () => currentRun?.cancelRequested === true);
    let finalUrl = targetUrl;

    if (waitResult.status === 'complete' || waitResult.status === 'cancelled') {
      try {
        const tabInfo = await chrome.tabs.get(tabId);
        if (tabInfo?.url) {
          finalUrl = tabInfo.url;
        }
      } catch (error) {
        appendLog({
          unitId,
          phase: 'visit',
          status: 'warning',
          message: `탭 URL을 가져오지 못했습니다: ${error.message}`
        });
      }
    }

    const startedWithoutSubtitle = !new URL(targetUrl).searchParams.has('subtitleLanguage');
    const hasSubtitle = finalUrl ? new URL(finalUrl).searchParams.has('subtitleLanguage') : false;

    appendLog({
      unitId,
      phase: 'visit',
      status: waitResult.status === 'complete' ? 'success' : waitResult.status === 'cancelled' ? 'cancelled' : 'warning',
      visit: { url: finalUrl, result: waitResult.status, autoAppended: startedWithoutSubtitle && hasSubtitle }
    });

    await delay(300);
    return { tabId, result: waitResult.status, url: finalUrl };
  } catch (error) {
    appendLog({
      unitId,
      phase: 'visit',
      status: 'error',
      message: `강의 페이지를 열 수 없습니다: ${error.message}`
    });
    return { tabId: null, result: 'error', url: null };
  }
}

async function closeTab(tabId) {
  if (tabId === null || tabId === undefined) {
    return;
  }
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    appendLog({
      unitId: currentRun?.lastUnitId || null,
      phase: 'visit-cleanup',
      status: 'warning',
      message: `탭 정리에 실패했습니다: ${error.message}`
    });
  }
}

async function sendCompletionRequest(unitId, durationSeconds, meta) {
  const payloadObj = buildPayload(unitId, durationSeconds);
  const payload = JSON.stringify(payloadObj);
  const { headers, appliedHeaders, blockedHeaders } = buildHeaders();

  appendLog({
    unitId,
    phase: 'request',
    status: 'pending',
    request: {
      method: 'PATCH',
      url: API_URL,
      body: payload,
      headers: appliedHeaders
    },
    blockedHeaders: blockedHeaders.length ? blockedHeaders : undefined,
    meta
  });

  console.log('[Inflearn Unit Completer] Sending request', {
    method: 'PATCH',
    url: API_URL,
    unitId,
    body: payload,
    headers: appliedHeaders,
    blockedHeaders,
    meta
  });

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'PATCH',
      headers,
      credentials: 'include',
      body: payload
    });
  } catch (fetchError) {
    appendLog({
      unitId,
      phase: 'response',
      status: 'error',
      message: fetchError.message,
      meta
    });

    console.log('[Inflearn Unit Completer] Request failed before response', {
      unitId,
      error: fetchError.message
    });

    throw fetchError;
  }

  const rawBody = await response.text();
  const bodyPreview = rawBody.length > 400 ? `${rawBody.slice(0, 400)}…` : rawBody;

  const responseLog = {
    unitId,
    phase: 'response',
    status: response.ok ? 'success' : 'error',
    response: {
      status: response.status,
      ok: response.ok,
      bodySnippet: bodyPreview
    },
    meta
  };

  if (!response.ok) {
    responseLog.message = `HTTP ${response.status}`;
  }

  appendLog(responseLog);

  console.log('[Inflearn Unit Completer] Response received', {
    unitId,
    status: response.status,
    ok: response.ok,
    body: bodyPreview
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${rawBody}`);
  }

  appendLog({
    unitId,
    phase: 'summary',
    status: 'success',
    meta
  });

  return rawBody;
}

function notifyProgress(payload) {
  chrome.runtime.sendMessage({
    type: 'COMPLETION_PROGRESS',
    payload
  }).catch(() => {
    // popup이 닫힌 경우 무시
  });
}

async function runCompletion(unitIds, timecodes, context) {
  currentRun = {
    status: 'running',
    total: unitIds.length,
    processed: 0,
    skipped: 0,
    error: null,
    courseContext: context || null,
    lastUnitId: null,
    timeIndex: 0,
    cancelRequested: false
  };

  notifyProgress({
    status: 'running',
    total: currentRun.total,
    processed: 0,
    skipped: 0
  });

  let cancelled = false;

  try {
    for (const unitId of unitIds) {
      if (currentRun.cancelRequested) {
        cancelled = true;
        break;
      }

      let lectureTabId = null;

      try {
        const visitResult = await visitLecturePage(unitId, context);
        lectureTabId = visitResult.tabId;

        if (currentRun.cancelRequested || visitResult.result === 'cancelled') {
          cancelled = true;
          if (visitResult.result === 'cancelled') {
            appendLog({
              unitId,
              phase: 'cancel',
              status: 'cancelled',
              message: '탭 로딩 중 취소 요청이 감지되었습니다.'
            });
          }
          break;
        }

        const finalUrl = visitResult.url || '';
        const hasSubtitle = finalUrl.includes('subtitleLanguage=');

        if (!hasSubtitle) {
          currentRun.skipped += 1;
          currentRun.lastUnitId = unitId;
          appendLog({
            unitId,
            phase: 'skip',
            status: 'skipped',
            message: 'subtitleLanguage 파라미터가 없어 건너뜁니다.',
            visit: { url: finalUrl || '(알 수 없음)' }
          });
          notifyProgress({
            status: 'running',
            total: currentRun.total,
            processed: currentRun.processed,
            skipped: currentRun.skipped,
            lastUnitId: unitId
          });
          continue;
        }

        if (currentRun.timeIndex >= timecodes.length) {
          currentRun.skipped += 1;
          currentRun.lastUnitId = unitId;
          appendLog({
            unitId,
            phase: 'skip',
            status: 'skipped',
            message: '시간 정보를 찾지 못해 건너뜁니다.',
            visit: { url: finalUrl || '(알 수 없음)' }
          });
          notifyProgress({
            status: 'running',
            total: currentRun.total,
            processed: currentRun.processed,
            skipped: currentRun.skipped,
            lastUnitId: unitId
          });
          continue;
        }

        const timecode = timecodes[currentRun.timeIndex + currentRun.skipped];

        if (!timecode || Number.isNaN(timecode.durationSeconds)) {
          currentRun.skipped += 1;
          currentRun.lastUnitId = unitId;
          appendLog({
            unitId,
            phase: 'skip',
            status: 'skipped',
            message: '추출된 시간 정보가 잘못되어 건너뜁니다.',
            visit: { url: finalUrl || '(알 수 없음)' }
          });
          notifyProgress({
            status: 'running',
            total: currentRun.total,
            processed: currentRun.processed,
            skipped: currentRun.skipped,
            lastUnitId: unitId
          });
          continue;
        }

        currentRun.timeIndex += 1;

        if (currentRun.cancelRequested) {
          if (currentRun.timeIndex > 0) {
            currentRun.timeIndex -= 1;
          }
          cancelled = true;
          break;
        }

        await sendCompletionRequest(unitId, timecode.durationSeconds, {
          durationSeconds: timecode.durationSeconds,
          timecode: timecode.raw,
          visitUrl: finalUrl
        });

        currentRun.processed += 1;
        currentRun.lastUnitId = unitId;
      } catch (error) {
        appendLog({
          unitId,
          phase: 'summary',
          status: 'error',
          message: error.message
        });
        throw error;
      } finally {
        if (lectureTabId !== null) {
          await closeTab(lectureTabId);
        }
      }

      if (cancelled || currentRun.cancelRequested) {
        cancelled = true;
        break;
      }

      notifyProgress({
        status: 'running',
        total: currentRun.total,
        processed: currentRun.processed,
        skipped: currentRun.skipped,
        lastUnitId: currentRun.lastUnitId
      });

      if (currentRun.processed < currentRun.total) {
        await delay(getRandomDelay());
      }
    }

    if (cancelled || currentRun.cancelRequested) {
      currentRun.status = 'cancelled';
      appendLog({
        unitId: currentRun.lastUnitId,
        phase: 'cancel',
        status: 'cancelled',
        message: '사용자가 작업을 취소했습니다.'
      });
      notifyProgress({
        status: 'cancelled',
        total: currentRun.total,
        processed: currentRun.processed,
        skipped: currentRun.skipped
      });
      return;
    }

    currentRun.status = 'done';
    notifyProgress({
      status: 'done',
      total: currentRun.total,
      processed: currentRun.processed,
      skipped: currentRun.skipped
    });
  } catch (error) {
    currentRun.status = 'error';
    currentRun.error = error.message;
    notifyProgress({
      status: 'error',
      total: currentRun.total,
      processed: currentRun.processed,
      skipped: currentRun.skipped,
      errorMessage: error.message
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'START_COMPLETION') {
    if (currentRun?.status === 'running') {
      sendResponse({ status: 'already-running' });
      return;
    }

    const unitIds = Array.isArray(message.unitIds) ? message.unitIds : [];
    const sanitizedUnitIds = unitIds
      .map((value) => Number(value))
      .filter((value, index, arr) => Number.isInteger(value) && value > 0 && arr.indexOf(value) === index);

    const timecodes = Array.isArray(message.timecodes) ? message.timecodes : [];
    const sanitizedTimecodes = timecodes
      .map((item) => ({
        raw: item?.raw || null,
        durationSeconds: Number(item?.durationSeconds)
      }))
      .filter((item) => item.raw !== null && !Number.isNaN(item.durationSeconds));

    if (!sanitizedUnitIds.length) {
      sendResponse({ status: 'no-entries' });
      return;
    }

    const context = message.courseContext || null;

    runCompletion(sanitizedUnitIds, sanitizedTimecodes, context);
    sendResponse({ status: 'started', total: sanitizedUnitIds.length });
    return true;
  }

  if (message?.type === 'CANCEL_COMPLETION') {
    if (currentRun?.status === 'running') {
      currentRun.cancelRequested = true;
      appendLog({
        unitId: currentRun.lastUnitId,
        phase: 'cancel',
        status: 'pending',
        message: '사용자가 취소를 요청했습니다.'
      });
      sendResponse({ status: 'cancelling' });
    } else {
      sendResponse({ status: 'idle' });
    }
    return;
  }

  if (message?.type === 'COMPLETION_STATUS_REQUEST') {
    sendResponse(currentRun || { status: 'idle' });
    return true;
  }

  if (message?.type === 'GET_REQUEST_LOGS') {
    sendResponse({ logs: requestLogs });
    return true;
  }

  if (message?.type === 'CLEAR_REQUEST_LOGS') {
    requestLogs = [];
    sendResponse({ cleared: true });
    return true;
  }
});
