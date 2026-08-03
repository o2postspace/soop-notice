"use strict";

const FRAME_WIDTH = 48;
const FRAME_HEIGHT = 27;
const FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT;
const INTEGRAL_WIDTH = FRAME_WIDTH + 1;
const TITLE_WIDTHS = Object.freeze([16, 20, 24, 28]);
const TITLE_HEIGHTS = Object.freeze([3, 5, 7]);
const PANEL_WIDTHS = Object.freeze([10, 13, 16, 19, 22, 25, 28, 31]);
const PANEL_HEIGHTS = Object.freeze([12, 14, 16, 18, 20, 22, 24]);
const MIN_WIDE_PANEL_WIDTH = 19;

// 실제 SOOP 화면의 정보/강화 overlay는 거의 전 화면이 어두워 기존 bright title이나
// panel boundary 조건을 만족하지 않는다. 로딩/사망 dim과 겹치지 않는 texture와 title
// 위치를 함께 요구해 이 분기만 제한적으로 허용한다.
const DARK_OVERLAY_LIMITS = Object.freeze({
  minOverallMean: 28,
  maxOverallMean: 58,
  minLumaStdDev: 20,
  maxLumaStdDev: 63,
  minOverallDarkRatio: 0.76,
  maxOverallDarkRatio: 0.955,
  minColumnDeltaMean: 5,
  maxColumnDeltaMean: 21,
  minEdgeRatio: 0.11,
  maxEdgeRatio: 0.26,
  minSmoothRatio: 0.4,
  maxSmoothRatio: 0.7,
  maxTitleMean: 36,
  minTitleDarkRatio: 0.93,
  minTitleContrast: 20,
  minTitleX: 18,
  minTitleRight: 34,
  minTitleY: 4,
  maxTitleY: 12,
});

const DEFAULT_THRESHOLDS = Object.freeze({
  darkPixelMax: 64,
  edgeDelta: 20,
  smoothDelta: 4,
  panelBoundaryDelta: 10,
  minOverallMean: 20,
  minLumaStdDev: 8,
  maxOverallDarkRatio: 0.97,
  minBrightMean: 78,
  maxBrightMean: 135,
  maxBrightLumaStdDev: 54,
  maxBrightColumnDeltaMean: 19,
  minBrightRowColumnRatio: 1.1,
  maxBrightEdgeRatio: 0.31,
  minBrightSmoothRatio: 0.35,
  maxTitleMean: 85,
  minTitleDarkRatio: 0.7,
  minTitleContrast: 42,
  maxPanelMean: 55,
  minPanelDarkRatio: 0.85,
  minPanelEdgeRatio: 0.2,
  minPanelBoundaryMean: 18,
  minPanelBoundaryRatio: 0.55,
  maxNarrowPanelLumaStdDev: 30,
  minHighVariancePanelMean: 48,
});

class SamgukUiGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SamgukUiGateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SamgukUiGateError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ratio(value, fallback, label) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)
    || candidate < 0 || candidate > 1) {
    fail("invalid_config", `${label}은(는) 0 이상 1 이하의 숫자여야 합니다.`);
  }
  return candidate;
}

function byteThreshold(value, fallback, label, integer = false) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)
    || candidate < 0 || candidate > 255 || (integer && !Number.isInteger(candidate))) {
    fail("invalid_config", `${label}은(는) 0 이상 255 이하의 ${integer ? "정수" : "숫자"}여야 합니다.`);
  }
  return candidate;
}

function numberInRange(value, fallback, label, min, max) {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)
    || candidate < min || candidate > max) {
    fail("invalid_config", `${label}은(는) ${min} 이상 ${max} 이하의 숫자여야 합니다.`);
  }
  return candidate;
}

function normalizeThresholds(options = {}) {
  if (!isPlainObject(options)) fail("invalid_config", "thresholds는 object여야 합니다.");
  const known = new Set(Object.keys(DEFAULT_THRESHOLDS));
  for (const key of Object.keys(options)) {
    if (!known.has(key)) fail("invalid_config", `알 수 없는 threshold입니다: ${key}`);
  }
  const normalized = {
    darkPixelMax: byteThreshold(
      options.darkPixelMax,
      DEFAULT_THRESHOLDS.darkPixelMax,
      "darkPixelMax",
      true,
    ),
    edgeDelta: byteThreshold(
      options.edgeDelta,
      DEFAULT_THRESHOLDS.edgeDelta,
      "edgeDelta",
      true,
    ),
    smoothDelta: byteThreshold(
      options.smoothDelta,
      DEFAULT_THRESHOLDS.smoothDelta,
      "smoothDelta",
      true,
    ),
    panelBoundaryDelta: byteThreshold(
      options.panelBoundaryDelta,
      DEFAULT_THRESHOLDS.panelBoundaryDelta,
      "panelBoundaryDelta",
      true,
    ),
    minOverallMean: byteThreshold(
      options.minOverallMean,
      DEFAULT_THRESHOLDS.minOverallMean,
      "minOverallMean",
    ),
    minLumaStdDev: byteThreshold(
      options.minLumaStdDev,
      DEFAULT_THRESHOLDS.minLumaStdDev,
      "minLumaStdDev",
    ),
    maxOverallDarkRatio: ratio(
      options.maxOverallDarkRatio,
      DEFAULT_THRESHOLDS.maxOverallDarkRatio,
      "maxOverallDarkRatio",
    ),
    minBrightMean: byteThreshold(
      options.minBrightMean,
      DEFAULT_THRESHOLDS.minBrightMean,
      "minBrightMean",
    ),
    maxBrightMean: byteThreshold(
      options.maxBrightMean,
      DEFAULT_THRESHOLDS.maxBrightMean,
      "maxBrightMean",
    ),
    maxBrightLumaStdDev: byteThreshold(
      options.maxBrightLumaStdDev,
      DEFAULT_THRESHOLDS.maxBrightLumaStdDev,
      "maxBrightLumaStdDev",
    ),
    maxBrightColumnDeltaMean: byteThreshold(
      options.maxBrightColumnDeltaMean,
      DEFAULT_THRESHOLDS.maxBrightColumnDeltaMean,
      "maxBrightColumnDeltaMean",
    ),
    minBrightRowColumnRatio: numberInRange(
      options.minBrightRowColumnRatio,
      DEFAULT_THRESHOLDS.minBrightRowColumnRatio,
      "minBrightRowColumnRatio",
      0,
      16,
    ),
    maxBrightEdgeRatio: ratio(
      options.maxBrightEdgeRatio,
      DEFAULT_THRESHOLDS.maxBrightEdgeRatio,
      "maxBrightEdgeRatio",
    ),
    minBrightSmoothRatio: ratio(
      options.minBrightSmoothRatio,
      DEFAULT_THRESHOLDS.minBrightSmoothRatio,
      "minBrightSmoothRatio",
    ),
    maxTitleMean: byteThreshold(
      options.maxTitleMean,
      DEFAULT_THRESHOLDS.maxTitleMean,
      "maxTitleMean",
    ),
    minTitleDarkRatio: ratio(
      options.minTitleDarkRatio,
      DEFAULT_THRESHOLDS.minTitleDarkRatio,
      "minTitleDarkRatio",
    ),
    minTitleContrast: byteThreshold(
      options.minTitleContrast,
      DEFAULT_THRESHOLDS.minTitleContrast,
      "minTitleContrast",
    ),
    maxPanelMean: byteThreshold(
      options.maxPanelMean,
      DEFAULT_THRESHOLDS.maxPanelMean,
      "maxPanelMean",
    ),
    minPanelDarkRatio: ratio(
      options.minPanelDarkRatio,
      DEFAULT_THRESHOLDS.minPanelDarkRatio,
      "minPanelDarkRatio",
    ),
    minPanelEdgeRatio: ratio(
      options.minPanelEdgeRatio,
      DEFAULT_THRESHOLDS.minPanelEdgeRatio,
      "minPanelEdgeRatio",
    ),
    minPanelBoundaryMean: byteThreshold(
      options.minPanelBoundaryMean,
      DEFAULT_THRESHOLDS.minPanelBoundaryMean,
      "minPanelBoundaryMean",
    ),
    minPanelBoundaryRatio: ratio(
      options.minPanelBoundaryRatio,
      DEFAULT_THRESHOLDS.minPanelBoundaryRatio,
      "minPanelBoundaryRatio",
    ),
    maxNarrowPanelLumaStdDev: byteThreshold(
      options.maxNarrowPanelLumaStdDev,
      DEFAULT_THRESHOLDS.maxNarrowPanelLumaStdDev,
      "maxNarrowPanelLumaStdDev",
    ),
    minHighVariancePanelMean: byteThreshold(
      options.minHighVariancePanelMean,
      DEFAULT_THRESHOLDS.minHighVariancePanelMean,
      "minHighVariancePanelMean",
    ),
  };
  if (normalized.smoothDelta > normalized.edgeDelta
    || normalized.minBrightMean > normalized.maxBrightMean) {
    fail("invalid_config", "threshold 범위의 최소값과 최대값 순서가 올바르지 않습니다.");
  }
  return Object.freeze(normalized);
}

function asBytes(value, code = "invalid_frame") {
  if (!ArrayBuffer.isView(value) || typeof value.byteLength !== "number"
    || value.BYTES_PER_ELEMENT !== 1) {
    fail(code, "8-bit Buffer 또는 Uint8Array가 필요합니다.");
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function rounded(value) {
  return Math.round(value * 10_000) / 10_000;
}

function incompleteResult(receivedBytes) {
  return Object.freeze({
    uiCandidate: false,
    reason: "short_frame",
    features: Object.freeze({
      receivedBytes,
      expectedBytes: FRAME_BYTES,
      overallMean: null,
      lumaStdDev: null,
      overallDarkRatio: null,
      columnDeltaMean: null,
      rowDeltaMean: null,
      rowColumnDeltaRatio: null,
      edgeRatio: null,
      smoothRatio: null,
      titleContrast: null,
      titleRect: null,
      panelBoundaryMean: null,
      panelBoundaryRatio: null,
      panelRect: null,
      candidateKind: null,
    }),
  });
}

function integralRect(integral, x, y, width, height) {
  const right = x + width;
  const bottom = y + height;
  return integral[bottom * INTEGRAL_WIDTH + right]
    - integral[y * INTEGRAL_WIDTH + right]
    - integral[bottom * INTEGRAL_WIDTH + x]
    + integral[y * INTEGRAL_WIDTH + x];
}

function verticalPrefixRange(prefix, boundaryX, y, height) {
  return prefix[(y + height) * INTEGRAL_WIDTH + boundaryX]
    - prefix[y * INTEGRAL_WIDTH + boundaryX];
}

function findTitlePattern(metrics, thresholds) {
  let best = null;
  for (const height of TITLE_HEIGHTS) {
    for (const width of TITLE_WIDTHS) {
      const area = width * height;
      const ringCount = 2 * width + 2 * height + 4;
      for (let y = 1; y + height < FRAME_HEIGHT; y += 1) {
        for (let x = 1; x + width < FRAME_WIDTH; x += 1) {
          const insideSum = integralRect(metrics.lumaIntegral, x, y, width, height);
          const insideMean = insideSum / area;
          if (insideMean > thresholds.maxTitleMean) continue;
          const darkRatio = integralRect(metrics.darkIntegral, x, y, width, height) / area;
          if (darkRatio < thresholds.minTitleDarkRatio) continue;
          const outerSum = integralRect(metrics.lumaIntegral, x - 1, y - 1, width + 2, height + 2);
          const contrast = (outerSum - insideSum) / ringCount - insideMean;
          if (!best || contrast > best.contrast) {
            best = { x, y, width, height, mean: insideMean, darkRatio, contrast };
          }
        }
      }
    }
  }
  return best;
}

function findPanelPattern(metrics, thresholds) {
  // 어두운 로딩 splash는 밝은 캐릭터/overlay 때문에 직사각형 경계처럼 보일 수 있다.
  // 균일하게 dim 된 실제 inventory는 낮은 분산 분기로 계속 허용한다.
  if (metrics.overallMean < thresholds.minHighVariancePanelMean
    && metrics.lumaStdDev > thresholds.maxNarrowPanelLumaStdDev) {
    return null;
  }
  let best = null;
  for (const height of PANEL_HEIGHTS) {
    for (const width of PANEL_WIDTHS) {
      if (width < MIN_WIDE_PANEL_WIDTH
        && metrics.lumaStdDev > thresholds.maxNarrowPanelLumaStdDev) {
        continue;
      }
      const area = width * height;
      for (let y = 1; y + height < FRAME_HEIGHT; y += 1) {
        for (let x = 1; x + width < FRAME_WIDTH; x += 1) {
          const mean = integralRect(metrics.lumaIntegral, x, y, width, height) / area;
          if (mean > thresholds.maxPanelMean) continue;
          const darkRatio = integralRect(metrics.darkIntegral, x, y, width, height) / area;
          if (darkRatio < thresholds.minPanelDarkRatio) continue;
          const edgeRatio = integralRect(metrics.edgeIntegral, x, y, width, height)
            / (2 * area);
          if (edgeRatio < thresholds.minPanelEdgeRatio) continue;

          const leftMean = verticalPrefixRange(
            metrics.leftBoundaryPrefix,
            x,
            y,
            height,
          ) / height;
          const rightMean = verticalPrefixRange(
            metrics.rightBoundaryPrefix,
            x + width,
            y,
            height,
          ) / height;
          const boundaryMean = Math.min(leftMean, rightMean);
          if (boundaryMean < thresholds.minPanelBoundaryMean) continue;
          const leftRatio = verticalPrefixRange(
            metrics.leftBoundaryCountPrefix,
            x,
            y,
            height,
          ) / height;
          const rightRatio = verticalPrefixRange(
            metrics.rightBoundaryCountPrefix,
            x + width,
            y,
            height,
          ) / height;
          const boundaryRatio = Math.min(leftRatio, rightRatio);
          if (boundaryRatio < thresholds.minPanelBoundaryRatio) continue;

          const score = boundaryMean + 40 * boundaryRatio + 20 * edgeRatio;
          if (!best || score > best.score) {
            best = {
              x,
              y,
              width,
              height,
              mean,
              darkRatio,
              edgeRatio,
              boundaryMean,
              boundaryRatio,
              score,
            };
          }
        }
      }
    }
  }
  return best;
}

function isDarkOverlayCandidate(metrics, title) {
  if (!title) return false;
  const limits = DARK_OVERLAY_LIMITS;
  return metrics.overallMean >= limits.minOverallMean
    && metrics.overallMean <= limits.maxOverallMean
    && metrics.lumaStdDev >= limits.minLumaStdDev
    && metrics.lumaStdDev <= limits.maxLumaStdDev
    && metrics.overallDarkRatio >= limits.minOverallDarkRatio
    && metrics.overallDarkRatio <= limits.maxOverallDarkRatio
    && metrics.columnDeltaMean >= limits.minColumnDeltaMean
    && metrics.columnDeltaMean <= limits.maxColumnDeltaMean
    && metrics.edgeRatio >= limits.minEdgeRatio
    && metrics.edgeRatio <= limits.maxEdgeRatio
    && metrics.smoothRatio >= limits.minSmoothRatio
    && metrics.smoothRatio <= limits.maxSmoothRatio
    && title.mean <= limits.maxTitleMean
    && title.darkRatio >= limits.minTitleDarkRatio
    && title.contrast >= limits.minTitleContrast
    && title.x >= limits.minTitleX
    && title.x + title.width >= limits.minTitleRight
    && title.y >= limits.minTitleY
    && title.y <= limits.maxTitleY;
}

function frameMetrics(bytes, thresholds) {
  const integralSize = (FRAME_WIDTH + 1) * (FRAME_HEIGHT + 1);
  const lumaIntegral = new Float64Array(integralSize);
  const darkIntegral = new Uint16Array(integralSize);
  const edgeValues = new Uint8Array(FRAME_BYTES);
  const edgeIntegral = new Uint16Array(integralSize);
  const leftBoundaryPrefix = new Float64Array(integralSize);
  const rightBoundaryPrefix = new Float64Array(integralSize);
  const leftBoundaryCountPrefix = new Uint16Array(integralSize);
  const rightBoundaryCountPrefix = new Uint16Array(integralSize);
  let overallSum = 0;
  let overallSquaredSum = 0;
  let overallDark = 0;
  let columnDeltaSum = 0;
  let rowDeltaSum = 0;
  let edgeCount = 0;
  let smoothCount = 0;

  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    let rowLuma = 0;
    let rowDark = 0;
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const pixel = bytes[y * FRAME_WIDTH + x];
      overallSum += pixel;
      overallSquaredSum += pixel * pixel;
      rowLuma += pixel;
      if (pixel <= thresholds.darkPixelMax) {
        overallDark += 1;
        rowDark += 1;
      }
      const integralIndex = (y + 1) * INTEGRAL_WIDTH + x + 1;
      lumaIntegral[integralIndex] = lumaIntegral[y * INTEGRAL_WIDTH + x + 1] + rowLuma;
      darkIntegral[integralIndex] = darkIntegral[y * INTEGRAL_WIDTH + x + 1] + rowDark;

      if (x + 1 < FRAME_WIDTH) {
        const delta = Math.abs(pixel - bytes[y * FRAME_WIDTH + x + 1]);
        columnDeltaSum += delta;
        if (delta > thresholds.edgeDelta) {
          edgeCount += 1;
          edgeValues[y * FRAME_WIDTH + x] += 1;
        }
        if (delta <= thresholds.smoothDelta) smoothCount += 1;
      }
      if (y + 1 < FRAME_HEIGHT) {
        const delta = Math.abs(pixel - bytes[(y + 1) * FRAME_WIDTH + x]);
        rowDeltaSum += delta;
        if (delta > thresholds.edgeDelta) {
          edgeCount += 1;
          edgeValues[y * FRAME_WIDTH + x] += 1;
        }
        if (delta <= thresholds.smoothDelta) smoothCount += 1;
      }
    }
  }

  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    let rowEdge = 0;
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      rowEdge += edgeValues[y * FRAME_WIDTH + x];
      const integralIndex = (y + 1) * INTEGRAL_WIDTH + x + 1;
      edgeIntegral[integralIndex] = edgeIntegral[y * INTEGRAL_WIDTH + x + 1] + rowEdge;
    }
    for (let boundaryX = 1; boundaryX < FRAME_WIDTH; boundaryX += 1) {
      const delta = bytes[y * FRAME_WIDTH + boundaryX - 1]
        - bytes[y * FRAME_WIDTH + boundaryX];
      const prefixIndex = (y + 1) * INTEGRAL_WIDTH + boundaryX;
      const previousIndex = y * INTEGRAL_WIDTH + boundaryX;
      leftBoundaryPrefix[prefixIndex] = leftBoundaryPrefix[previousIndex] + delta;
      rightBoundaryPrefix[prefixIndex] = rightBoundaryPrefix[previousIndex] - delta;
      leftBoundaryCountPrefix[prefixIndex] = leftBoundaryCountPrefix[previousIndex]
        + (delta > thresholds.panelBoundaryDelta ? 1 : 0);
      rightBoundaryCountPrefix[prefixIndex] = rightBoundaryCountPrefix[previousIndex]
        + (delta < -thresholds.panelBoundaryDelta ? 1 : 0);
    }
  }

  const overallMean = overallSum / FRAME_BYTES;
  const lumaVariance = Math.max(0, overallSquaredSum / FRAME_BYTES - overallMean ** 2);
  const columnDeltaMean = columnDeltaSum / (FRAME_HEIGHT * (FRAME_WIDTH - 1));
  const rowDeltaMean = rowDeltaSum / ((FRAME_HEIGHT - 1) * FRAME_WIDTH);
  const adjacentPairCount = FRAME_HEIGHT * (FRAME_WIDTH - 1)
    + (FRAME_HEIGHT - 1) * FRAME_WIDTH;
  return {
    overallMean,
    lumaStdDev: Math.sqrt(lumaVariance),
    overallDarkRatio: overallDark / FRAME_BYTES,
    columnDeltaMean,
    rowDeltaMean,
    rowColumnDeltaRatio: columnDeltaMean === 0 ? 0 : rowDeltaMean / columnDeltaMean,
    edgeRatio: edgeCount / adjacentPairCount,
    smoothRatio: smoothCount / adjacentPairCount,
    lumaIntegral,
    darkIntegral,
    edgeIntegral,
    leftBoundaryPrefix,
    rightBoundaryPrefix,
    leftBoundaryCountPrefix,
    rightBoundaryCountPrefix,
  };
}

function analyzeWithThresholds(frame, thresholds) {
  const bytes = asBytes(frame);
  if (bytes.byteLength < FRAME_BYTES) return incompleteResult(bytes.byteLength);
  if (bytes.byteLength !== FRAME_BYTES) {
    return Object.freeze({
      uiCandidate: false,
      reason: "invalid_frame_size",
      features: Object.freeze({ receivedBytes: bytes.byteLength, expectedBytes: FRAME_BYTES }),
    });
  }

  const metrics = frameMetrics(bytes, thresholds);
  const title = findTitlePattern(metrics, thresholds);
  const panel = findPanelPattern(metrics, thresholds);
  const titleCandidate = metrics.overallMean >= thresholds.minBrightMean
    && metrics.overallMean <= thresholds.maxBrightMean
    && metrics.lumaStdDev <= thresholds.maxBrightLumaStdDev
    && metrics.columnDeltaMean <= thresholds.maxBrightColumnDeltaMean
    && metrics.rowColumnDeltaRatio >= thresholds.minBrightRowColumnRatio
    && metrics.edgeRatio <= thresholds.maxBrightEdgeRatio
    && metrics.smoothRatio >= thresholds.minBrightSmoothRatio
    && title?.contrast >= thresholds.minTitleContrast;
  const panelCandidate = panel !== null;
  const darkOverlayCandidate = isDarkOverlayCandidate(metrics, title);
  const detectedKind = panelCandidate
    ? "panel"
    : titleCandidate
      ? "text_panel"
      : darkOverlayCandidate
        ? "dark_overlay"
        : null;
  let reason = detectedKind ? "candidate" : "no_local_ui_pattern";
  if (metrics.overallMean < thresholds.minOverallMean
    || metrics.overallDarkRatio > thresholds.maxOverallDarkRatio) {
    reason = "frame_too_dark";
  } else if (metrics.lumaStdDev < thresholds.minLumaStdDev) {
    reason = "frame_too_flat";
  }
  const candidateKind = reason === "candidate" ? detectedKind : null;

  const features = Object.freeze({
    receivedBytes: FRAME_BYTES,
    expectedBytes: FRAME_BYTES,
    overallMean: rounded(metrics.overallMean),
    lumaStdDev: rounded(metrics.lumaStdDev),
    overallDarkRatio: rounded(metrics.overallDarkRatio),
    columnDeltaMean: rounded(metrics.columnDeltaMean),
    rowDeltaMean: rounded(metrics.rowDeltaMean),
    rowColumnDeltaRatio: rounded(metrics.rowColumnDeltaRatio),
    edgeRatio: rounded(metrics.edgeRatio),
    smoothRatio: rounded(metrics.smoothRatio),
    titleContrast: title ? rounded(title.contrast) : null,
    titleRect: title ? Object.freeze({
      x: title.x,
      y: title.y,
      width: title.width,
      height: title.height,
      mean: rounded(title.mean),
      darkRatio: rounded(title.darkRatio),
    }) : null,
    panelBoundaryMean: panel ? rounded(panel.boundaryMean) : null,
    panelBoundaryRatio: panel ? rounded(panel.boundaryRatio) : null,
    panelRect: panel ? Object.freeze({
      x: panel.x,
      y: panel.y,
      width: panel.width,
      height: panel.height,
      mean: rounded(panel.mean),
      darkRatio: rounded(panel.darkRatio),
      edgeRatio: rounded(panel.edgeRatio),
    }) : null,
    candidateKind,
  });

  return Object.freeze({ uiCandidate: reason === "candidate", reason, features });
}

function analyzeGrayFrame(frame, thresholdOptions = {}) {
  return analyzeWithThresholds(frame, normalizeThresholds(thresholdOptions));
}

function createGrayFrameParser(options = {}) {
  if (!isPlainObject(options)) fail("invalid_config", "parser options는 object여야 합니다.");
  const parserOptionNames = new Set(["onFrame", "onPartialFrame", "maxBufferedBytes"]);
  for (const key of Object.keys(options)) {
    if (!parserOptionNames.has(key)) fail("invalid_config", `알 수 없는 parser option입니다: ${key}`);
  }
  const onFrame = options.onFrame === undefined ? () => {} : options.onFrame;
  const onPartialFrame = options.onPartialFrame === undefined ? () => {} : options.onPartialFrame;
  if (typeof onFrame !== "function" || typeof onPartialFrame !== "function") {
    fail("invalid_config", "onFrame과 onPartialFrame은 함수여야 합니다.");
  }
  const maxBufferedBytes = options.maxBufferedBytes === undefined
    ? FRAME_BYTES
    : options.maxBufferedBytes;
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < FRAME_BYTES
    || maxBufferedBytes > 16 * 1024 * 1024) {
    fail("invalid_config", `maxBufferedBytes는 ${FRAME_BYTES}~16777216 정수여야 합니다.`);
  }

  // 입력 chunk 전체를 합치지 않고 한 프레임 크기의 accumulator만 유지한다.
  const accumulator = Buffer.alloc(FRAME_BYTES);
  let bufferedBytes = 0;
  let totalBytes = 0;
  let totalFrames = 0;
  let ended = false;
  let active = false;

  function snapshot(extra = {}) {
    return Object.freeze({
      frameBytes: FRAME_BYTES,
      maxBufferedBytes,
      bufferedBytes,
      totalBytes,
      totalFrames,
      ended,
      ...extra,
    });
  }

  function enter() {
    if (active) fail("parser_busy", "parser callback 안에서 parser를 다시 호출할 수 없습니다.");
    active = true;
  }

  function push(chunk) {
    if (ended) fail("parser_ended", "종료된 parser에는 chunk를 추가할 수 없습니다.");
    const bytes = asBytes(chunk, "invalid_chunk");
    enter();
    let offset = 0;
    let framesParsed = 0;
    totalBytes += bytes.byteLength;
    try {
      while (offset < bytes.byteLength) {
        const remaining = bytes.byteLength - offset;
        if (bufferedBytes === 0 && remaining >= FRAME_BYTES) {
          onFrame(bytes.subarray(offset, offset + FRAME_BYTES));
          offset += FRAME_BYTES;
          framesParsed += 1;
          totalFrames += 1;
          continue;
        }

        const copied = Math.min(FRAME_BYTES - bufferedBytes, remaining);
        accumulator.set(bytes.subarray(offset, offset + copied), bufferedBytes);
        bufferedBytes += copied;
        offset += copied;
        if (bufferedBytes === FRAME_BYTES) {
          bufferedBytes = 0;
          try {
            onFrame(accumulator);
          } finally {
            accumulator.fill(0);
          }
          framesParsed += 1;
          totalFrames += 1;
        }
      }
      return snapshot({ framesParsed });
    } finally {
      active = false;
    }
  }

  function end() {
    if (ended) return snapshot({ discardedBytes: 0 });
    enter();
    const discardedBytes = bufferedBytes;
    ended = true;
    bufferedBytes = 0;
    try {
      if (discardedBytes > 0) onPartialFrame(Object.freeze({
        receivedBytes: discardedBytes,
        expectedBytes: FRAME_BYTES,
      }));
      return snapshot({ discardedBytes });
    } finally {
      accumulator.fill(0);
      active = false;
    }
  }

  function reset() {
    enter();
    try {
      bufferedBytes = 0;
      ended = false;
      accumulator.fill(0);
      return snapshot();
    } finally {
      active = false;
    }
  }

  return Object.freeze({ push, end, reset, getState: () => snapshot() });
}

function createSamgukUiGate(options = {}) {
  if (!isPlainObject(options)) fail("invalid_config", "gate options는 object여야 합니다.");
  const thresholdNames = new Set(Object.keys(DEFAULT_THRESHOLDS));
  const gateOptionNames = new Set(["thresholds", "maxBufferedBytes", "onResult", ...thresholdNames]);
  for (const key of Object.keys(options)) {
    if (!gateOptionNames.has(key)) fail("invalid_config", `알 수 없는 gate option입니다: ${key}`);
  }
  const directThresholds = Object.fromEntries(
    Object.entries(options).filter(([key]) => thresholdNames.has(key)),
  );
  if (options.thresholds !== undefined && Object.keys(directThresholds).length > 0) {
    fail("invalid_config", "thresholds와 직접 threshold option을 함께 사용할 수 없습니다.");
  }
  const thresholds = normalizeThresholds(
    options.thresholds === undefined ? directThresholds : options.thresholds,
  );
  const onResult = options.onResult === undefined ? () => {} : options.onResult;
  if (typeof onResult !== "function") fail("invalid_config", "onResult는 함수여야 합니다.");

  let results = null;
  function emit(result) {
    results.push(result);
    onResult(result);
  }

  const parser = createGrayFrameParser({
    maxBufferedBytes: options.maxBufferedBytes,
    onFrame: frame => emit(analyzeWithThresholds(frame, thresholds)),
    onPartialFrame: partial => emit(incompleteResult(partial.receivedBytes)),
  });

  function collect(action) {
    if (results !== null) fail("parser_busy", "gate callback 안에서 gate를 다시 호출할 수 없습니다.");
    results = [];
    try {
      action();
      return Object.freeze(results);
    } finally {
      results = null;
    }
  }

  return Object.freeze({
    push: chunk => collect(() => parser.push(chunk)),
    end: () => collect(() => parser.end()),
    reset: () => parser.reset(),
    getState: () => Object.freeze({ ...parser.getState(), thresholds }),
  });
}

module.exports = {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  FRAME_BYTES,
  DEFAULT_THRESHOLDS,
  SamgukUiGateError,
  normalizeThresholds,
  analyzeGrayFrame,
  createGrayFrameParser,
  createSamgukUiGate,
};
