function extractUnitIds(html) {
  const regex = /unitId=(\d+)/g;
  const results = [];
  const seen = new Set();
  let match = regex.exec(html);

  while (match) {
    const id = Number(match[1]);
    if (!Number.isNaN(id) && !seen.has(id)) {
      seen.add(id);
      results.push(id);
    }
    match = regex.exec(html);
  }

  return results;
}

function extractTimecodes(html) {
  const regex = />\s*(\d{2}:\d{2})\s*</g;
  const results = [];
  let match = regex.exec(html);

  while (match) {
    const minutes = Number(match[1].slice(0, 2));
    const seconds = Number(match[1].slice(3, 5));
    if (!Number.isNaN(minutes) && !Number.isNaN(seconds)) {
      const durationSeconds = minutes * 60 + seconds;
      results.push({ raw: match[1], durationSeconds });
    }
    match = regex.exec(html);
  }

  return results;
}

function extractFromUrl(searchParams, key) {
  const value = searchParams.get(key);
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return value;
}

function extractCourseIdFromHtml(html) {
  const directMatch = html.match(/강의 ID\s*(\d+)/);
  if (directMatch && directMatch[1]) {
    return Number(directMatch[1]);
  }
  const paramMatch = html.match(/courseId=(\d+)/);
  if (paramMatch && paramMatch[1]) {
    return Number(paramMatch[1]);
  }
  return null;
}

function extractCourseContext(html) {
  try {
    const url = new URL(window.location.href);
    const { searchParams } = url;
    const fromParams = extractFromUrl(searchParams, 'courseId');
    const courseId = fromParams ? Number(fromParams) : extractCourseIdFromHtml(html);
    const tab = extractFromUrl(searchParams, 'tab') || 'curriculum';
    const type = extractFromUrl(searchParams, 'type') || 'LECTURE';
    const subtitleLanguage = extractFromUrl(searchParams, 'subtitleLanguage') || 'ko';

    return {
      courseId: Number.isNaN(courseId) ? null : courseId,
      tab,
      type,
      subtitleLanguage
    };
  } catch (error) {
    return {
      courseId: extractCourseIdFromHtml(html),
      tab: 'curriculum',
      type: 'LECTURE',
      subtitleLanguage: 'ko'
    };
  }
}

function extractData() {
  const html = document.documentElement?.innerHTML || '';
  const unitIds = extractUnitIds(html);
  const timecodes = extractTimecodes(html);
  const courseContext = extractCourseContext(html);

  return {
    unitIds,
    timecodes,
    mismatchInfo: {
      unitCount: unitIds.length,
      timecodeCount: timecodes.length,
      mismatched: unitIds.length !== timecodes.length
    },
    courseContext
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'EXTRACT_UNIT_DATA') {
    const data = extractData();
    sendResponse(data);
  }
});
