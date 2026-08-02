#!/usr/bin/env python3
"""SOOP 삼국지 whole-frame OCR adapter.

stdin으로 PNG 한 장을 받고 stdout에는 strict v2 JSON 한 개만 쓴다.
RapidOCR의 import/초기화/inference 출력은 fd 수준에서 폐기한다.
"""

from __future__ import annotations

import json
import hashlib
import logging
import math
import os
from pathlib import Path
import re
import struct
import sys
import unicodedata
import zlib
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Optional, Sequence


# NumPy/OpenCV wheels create large BLAS/OpenMP pools before RapidOCR applies
# ONNX Runtime's own thread limits.  This adapter is spawned per candidate
# frame, so cap every native pool before importing those libraries.
for _thread_env_key in (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "BLIS_NUM_THREADS",
):
    os.environ[_thread_env_key] = "1"


VERSION = 2
DEFAULT_PROFILE = "stats-panel-v1"
MAX_PNG_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 4096 * 2160
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
INTEGER_RE = re.compile(r"^(\d{1,3}(?:,\d{3})*|\d{1,9})(?:\([+-]?\d+(?:\.\d+)?\))?$")
ENHANCEMENT_RE = re.compile(r"(?:\(\s*)?\+\s*(\d{1,2})(?:\s*\))?|(?<!\d)(\d{1,2})\s*강")
ENHANCEMENT_PAREN_RE = re.compile(r"\((\d{1,2})\)$")
HORSE_STAGE_RE = re.compile(r"(?<!\d)(\d{1,2})단계")

MODEL_NAMES = (
    "PP-OCRv6_det_small.onnx",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
    "korean_PP-OCRv5_rec_mobile.onnx",
)
MODEL_SHA256 = {
    "PP-OCRv6_det_small.onnx": "090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
    "korean_PP-OCRv5_rec_mobile.onnx": "cd6e2ea50f6943ca7271eb8c56a877a5a90720b7047fe9c41a2e541a25773c9b",
}
STAT_FIELDS = {
    "무력": "strength",
    "기민": "agility",
    "기력": "vitality",
    "지모": "intelligence",
}
GEAR_FIELDS = {
    "무기": "weapon",
    "두갑": "helmet",
    "두건": "helmet",
    "투구": "helmet",
    "흉갑": "armor",
    "갑옷": "armor",
    "각갑": "shoes",
    "신발": "shoes",
}
ENHANCEMENT_MARKERS = (
    "장비강화", "강화성공확률", "단계하락확률", "강화비용", "강화하기",
)
HORSE_PANEL_HEADERS = ("군마영",)
HORSE_PANEL_TABS = ("장착", "강화", "합성")


class AdapterError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Token:
    text: str
    confidence: float
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def width(self) -> float:
        return max(1.0, self.x1 - self.x0)

    @property
    def height(self) -> float:
        return max(1.0, self.y1 - self.y0)

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def cy(self) -> float:
        return (self.y0 + self.y1) / 2


def compact_text(value: str) -> str:
    return re.sub(r"[\s:：]+", "", unicodedata.normalize("NFKC", value)).strip()


@contextmanager
def silence_library_output():
    """Python logger와 native runtime의 fd 1/2 출력을 모두 폐기한다."""
    saved = []
    null_fd = None
    try:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        except Exception:
            pass
        null_fd = os.open(os.devnull, os.O_WRONLY)
        for fd in (1, 2):
            saved.append((fd, os.dup(fd)))
            os.dup2(null_fd, fd)
        logging.disable(logging.CRITICAL)
        yield
    finally:
        for fd, original in reversed(saved):
            try:
                os.dup2(original, fd)
            finally:
                os.close(original)
        if null_fd is not None:
            os.close(null_fd)


def parse_cli(argv: Sequence[str]) -> tuple[str, Path]:
    profile = DEFAULT_PROFILE
    model_dir: Optional[str] = None
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--profile" and index + 1 < len(argv):
            index += 1
            profile = argv[index]
        elif arg.startswith("--profile="):
            profile = arg.split("=", 1)[1]
        elif arg == "--model-dir" and index + 1 < len(argv):
            index += 1
            model_dir = argv[index]
        elif arg.startswith("--model-dir="):
            model_dir = arg.split("=", 1)[1]
        else:
            raise AdapterError("invalid_args")
        index += 1
    if not PROFILE_RE.fullmatch(profile):
        raise AdapterError("invalid_args")
    path = Path(model_dir) if model_dir else Path(sys.prefix).parent / "rapidocr-models"
    if not path.is_absolute():
        raise AdapterError("invalid_args")
    return profile, path.resolve()


def validate_model_dir(model_dir: Path) -> None:
    if not model_dir.is_dir():
        raise AdapterError("model_unavailable")
    for name in MODEL_NAMES:
        candidate = model_dir / name
        if not candidate.is_file():
            raise AdapterError("model_unavailable")
        digest = hashlib.sha256()
        try:
            with candidate.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
        except OSError:
            raise AdapterError("model_unavailable") from None
        if digest.hexdigest() != MODEL_SHA256[name]:
            raise AdapterError("model_unavailable")


def validate_png(data: bytes) -> tuple[int, int]:
    if not data or len(data) > MAX_PNG_BYTES or not data.startswith(PNG_SIGNATURE):
        raise AdapterError("invalid_png")
    offset = len(PNG_SIGNATURE)
    width = height = None
    chunks = 0
    found_end = False
    while offset + 12 <= len(data):
        chunks += 1
        if chunks > 10000:
            raise AdapterError("invalid_png")
        size = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if end > len(data):
            raise AdapterError("invalid_png")
        payload = data[offset + 8:offset + 8 + size]
        expected = struct.unpack(">I", data[offset + 8 + size:end])[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected:
            raise AdapterError("invalid_png")
        if chunks == 1:
            if kind != b"IHDR" or size != 13:
                raise AdapterError("invalid_png")
            width, height = struct.unpack(">II", payload[:8])
            if width < 1 or height < 1 or width > 4096 or height > 2160 or width * height > MAX_PIXELS:
                raise AdapterError("invalid_png")
        if kind == b"IEND":
            if size != 0 or end != len(data):
                raise AdapterError("invalid_png")
            found_end = True
            break
        offset = end
    if not found_end or width is None or height is None:
        raise AdapterError("invalid_png")
    return width, height


def read_png(stream: Any) -> bytes:
    data = stream.read(MAX_PNG_BYTES + 1)
    validate_png(data)
    return data


def _box_bounds(box: Any) -> Optional[tuple[float, float, float, float]]:
    try:
        points = list(box)
        coordinates = [(float(point[0]), float(point[1])) for point in points]
    except Exception:
        return None
    if len(coordinates) < 4 or any(not math.isfinite(v) for pair in coordinates for v in pair):
        return None
    xs, ys = zip(*coordinates)
    return min(xs), min(ys), max(xs), max(ys)


def normalize_engine_output(output: Any) -> list[Token]:
    """RapidOCR 3.x object와 rapidocr_onnxruntime legacy tuple을 격리한다."""
    if hasattr(output, "boxes") and hasattr(output, "txts") and hasattr(output, "scores"):
        boxes = output.boxes if output.boxes is not None else []
        texts = output.txts if output.txts is not None else []
        scores = output.scores if output.scores is not None else []
        rows = zip(boxes, texts, scores)
    else:
        value = output[0] if isinstance(output, tuple) and len(output) == 2 else output
        rows = [] if value is None else ((row[0], row[1], row[2]) for row in value)
    tokens = []
    try:
        for box, text, score in rows:
            bounds = _box_bounds(box)
            confidence = float(score)
            if bounds is None or not isinstance(text, str) or len(text) > 256:
                continue
            if not math.isfinite(confidence) or confidence < 0 or confidence > 1:
                continue
            if compact_text(text):
                tokens.append(Token(text, confidence, *bounds))
            if len(tokens) >= 1000:
                break
    except Exception as exc:
        raise AdapterError("invalid_ocr_result") from None
    return tokens


class RapidOcrRuntime:
    def __init__(self, model_dir: Path):
        self.model_dir = model_dir
        with silence_library_output():
            try:
                import cv2
                import numpy as np
                cv2.setNumThreads(1)
                cv2.ocl.setUseOpenCL(False)
                self.cv2, self.np = cv2, np
                self.engine = self._new_engine()
                self.flavor = "new"
            except ImportError:
                self.engine = self._legacy_engine()
                self.flavor = "legacy"
            except Exception:
                raise AdapterError("engine_init_failed") from None

    def _new_engine(self):
        from rapidocr import RapidOCR
        from rapidocr.utils.typings import LangRec
        root = str(self.model_dir)
        params = {
            "Global.model_root_dir": root,
            "Global.log_level": "critical",
            "Global.text_score": 0.30,
            "EngineConfig.onnxruntime.intra_op_num_threads": 1,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
            "Det.model_path": str(self.model_dir / MODEL_NAMES[0]),
            "Cls.model_path": str(self.model_dir / MODEL_NAMES[1]),
            "Rec.model_path": str(self.model_dir / MODEL_NAMES[2]),
            "Rec.lang_type": LangRec.KOREAN,
        }
        return RapidOCR(params=params)

    def _legacy_engine(self):
        from rapidocr_onnxruntime import RapidOCR
        return RapidOCR(
            det_model_path=str(self.model_dir / MODEL_NAMES[0]),
            cls_model_path=str(self.model_dir / MODEL_NAMES[1]),
            rec_model_path=str(self.model_dir / MODEL_NAMES[2]),
        )

    def decode(self, png: bytes, expected: tuple[int, int]):
        with silence_library_output():
            try:
                image = self.cv2.imdecode(self.np.frombuffer(png, dtype=self.np.uint8), self.cv2.IMREAD_COLOR)
            except Exception:
                raise AdapterError("invalid_png") from None
        if image is None or image.ndim != 3 or (image.shape[1], image.shape[0]) != expected:
            raise AdapterError("invalid_png")
        scale = min(2.0, 2000.0 / max(image.shape[:2]))
        if scale > 1.05:
            image = self.cv2.resize(image, None, fx=scale, fy=scale, interpolation=self.cv2.INTER_CUBIC)
        return image

    def detect(self, image: Any) -> list[Token]:
        with silence_library_output():
            try:
                raw = self.engine(image)
            except Exception:
                raise AdapterError("ocr_failed") from None
        return normalize_engine_output(raw)

    def recognize_line(self, image: Any, scale: int) -> tuple[str, float]:
        resized = image if scale == 1 else self.cv2.resize(
            image, None, fx=scale, fy=scale, interpolation=self.cv2.INTER_CUBIC,
        )
        with silence_library_output():
            try:
                raw = self.engine(resized, use_det=False, use_cls=False, use_rec=True)
            except Exception:
                return "", 0.0
        if hasattr(raw, "txts"):
            texts = raw.txts or ()
            scores = raw.scores or ()
            return (str(texts[0]), float(scores[0])) if texts and scores else ("", 0.0)
        value = raw[0] if isinstance(raw, tuple) and len(raw) == 2 else raw
        if value and isinstance(value[0], (list, tuple)) and len(value[0]) >= 2:
            return str(value[0][0]), float(value[0][1])
        return "", 0.0


def _numeric_value(text: str) -> Optional[int]:
    match = INTEGER_RE.fullmatch(compact_text(text))
    return int(match.group(1).replace(",", "")) if match else None


def _neighbor_value(label: Token, tokens: Sequence[Token]) -> Optional[tuple[int, float]]:
    candidates = []
    for token in tokens:
        value = _numeric_value(token.text)
        if value is None or token is label:
            continue
        below = token.y0 >= label.y0 and token.y0 - label.y1 <= 3.2 * label.height
        aligned = abs(token.cx - label.cx) <= max(3.0 * label.height, label.width)
        right = token.x0 >= label.x1 - label.height and token.x0 - label.x1 <= 12 * label.height
        same_line = abs(token.cy - label.cy) <= 1.1 * max(label.height, token.height)
        if below and aligned:
            distance = max(0.0, token.y0 - label.y1) + abs(token.cx - label.cx) * 0.25
        elif right and same_line:
            distance = max(0.0, token.x0 - label.x1) + abs(token.cy - label.cy)
        else:
            continue
        candidates.append((distance, value, min(label.confidence, token.confidence)))
    if not candidates:
        return None
    _, value, confidence = min(candidates)
    return value, confidence


def _enhancement_value(text: str) -> Optional[int]:
    compact = compact_text(text)
    match = ENHANCEMENT_RE.search(compact)
    if not match:
        # 작은 tooltip 제목에서 '+' 한 획만 누락되는 경우가 있다. 이 형태는
        # exact 장비 종류 anchor와 3-scale 동일 숫자일 때만 0.95가 될 수 있다.
        paren = ENHANCEMENT_PAREN_RE.search(compact)
        return int(paren.group(1)) if paren else None
    return int(match.group(1) or match.group(2))


def _title_consensus(
    image: Any,
    category: Token,
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> Optional[tuple[int, float]]:
    height, width = image.shape[:2]
    unit = category.height
    x0 = max(0, int(category.x0 - 2.0 * unit))
    x1 = min(width, int(category.x0 + 17.0 * unit))
    y0 = max(0, int(category.y0 - 4.2 * unit))
    y1 = min(height, int(category.y1 + 0.4 * unit))
    if x1 <= x0 or y1 <= y0:
        return None
    crop = image[y0:y1, x0:x1]
    votes: dict[int, list[float]] = {}
    for scale in (1, 2, 4):
        text, score = line_reader(crop, scale)
        value = _enhancement_value(text)
        if value is not None and 0 <= value <= 99 and 0 <= score <= 1:
            votes.setdefault(value, []).append(score)
    if not votes:
        return None
    value, scores = max(votes.items(), key=lambda item: (len(item[1]), max(item[1])))
    if len(scores) == 3:
        # 배율 간 합의는 오독 가능성을 낮추지만 OCR confidence 자체를
        # 올릴 근거는 아니다. 세 결과 중 가장 낮은 raw score를 보존한다.
        return value, min(category.confidence, min(scores))
    # 서로 다른 값이 나온 frame은 raw score가 높아도 write threshold를
    # 넘지 못하게 한다. 값은 dry-run 진단용으로만 남긴다.
    return value, min(category.confidence, max(scores), 0.94)


def _horse_stage(
    normalized: Sequence[tuple[Token, str]],
) -> tuple[bool, Optional[tuple[int, float]]]:
    headers = [token for token, text in normalized if text in HORSE_PANEL_HEADERS]
    tabs = {text: token for token, text in normalized if text in HORSE_PANEL_TABS}
    buttons = [token for token, text in normalized if text == "강화하기"]
    panel_visible = bool(headers) and "강화" in tabs and len(tabs) >= 2 and bool(buttons)
    if not panel_visible:
        return False, None

    votes: dict[int, list[float]] = {}
    for token, text in normalized:
        if "→" in text or "->" in text:
            continue
        match = HORSE_STAGE_RE.search(text)
        if match:
            value = int(match.group(1))
            if 0 <= value <= 99:
                votes.setdefault(value, []).append(token.confidence)
    if not votes:
        return True, None

    value, scores = max(votes.items(), key=lambda item: (len(item[1]), max(item[1])))
    structural_confidence = min(
        max(token.confidence for token in headers),
        tabs["강화"].confidence,
        max(token.confidence for token in buttons),
    )
    return True, (value, min(structural_confidence, max(scores)))


def parse_panel(
    image: Any,
    tokens: Sequence[Token],
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> tuple[bool, list[dict[str, Any]]]:
    normalized = [(token, compact_text(token.text)) for token in tokens if token.confidence >= 0.30]
    stat_labels = [(token, STAT_FIELDS[text]) for token, text in normalized if text in STAT_FIELDS]
    quantity_titles = [token for token, text in normalized if text == "기량"]
    stat_panel = bool(quantity_titles) and len({field for _, field in stat_labels}) >= 3

    results: list[dict[str, Any]] = []
    if stat_panel:
        for label, field in stat_labels:
            match = _neighbor_value(label, tokens)
            if match is not None and field not in {item["field"] for item in results}:
                value, confidence = match
                results.append({"field": field, "value": value, "confidence": confidence})
        # title + exact label/value 구조는 panel 판별에만 사용한다.
        # 숫자 confidence는 잘못 읽은 값도 반복될 수 있어 절대 상향하지 않는다.

    gear_categories = [(token, GEAR_FIELDS[text]) for token, text in normalized if text in GEAR_FIELDS]
    for category, field in gear_categories:
        match = _title_consensus(image, category, line_reader)
        if match is not None and field not in {item["field"] for item in results}:
            value, confidence = match
            results.append({"field": field, "value": value, "confidence": confidence})

    horse_panel, horse_stage = _horse_stage(normalized)
    if horse_stage is not None:
        value, confidence = horse_stage
        results.append({"field": "horseLevel", "value": value, "confidence": confidence})

    texts = {text for _, text in normalized}
    marker_count = sum(any(marker in text for text in texts) for marker in ENHANCEMENT_MARKERS)
    has_stage = any("단계" in text and ("→" in text or "->" in text) for text in texts)
    # 작은 단계 제목이 detector에서 빠져도 성공/하락/button/비용의 네 구조가
    # 동시에 있으면 강화 panel로 볼 수 있다. 장비 종류가 없으면 값은 비운다.
    enhancement_panel = marker_count >= 3 and (has_stage or marker_count >= 4)
    panel_visible = stat_panel or enhancement_panel or horse_panel or bool(results)
    order = {name: index for index, name in enumerate(
        ("horseLevel", "weapon", "helmet", "armor", "shoes", "strength", "agility", "vitality", "intelligence")
    )}
    results.sort(key=lambda item: order[item["field"]])
    return panel_visible, results


def make_batch(profile: str, panel_visible: bool, results: Iterable[dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": VERSION,
        "profileId": profile,
        "panelVisible": bool(panel_visible),
        "results": list(results),
    }


def run(argv: Sequence[str], stdin: Any) -> dict[str, Any]:
    profile, model_dir = parse_cli(argv)
    png = read_png(stdin)
    dimensions = validate_png(png)
    validate_model_dir(model_dir)
    runtime = RapidOcrRuntime(model_dir)
    image = runtime.decode(png, dimensions)
    tokens = runtime.detect(image)
    visible, results = parse_panel(image, tokens, runtime.recognize_line)
    return make_batch(profile, visible, results)


def main() -> int:
    try:
        batch = run(sys.argv[1:], sys.stdin.buffer)
        payload = json.dumps(batch, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        os.write(1, payload)
        return 0
    except AdapterError as error:
        os.write(2, f"samguk_ocr_adapter:{error.code}\n".encode("ascii"))
        return 2
    except Exception:
        os.write(2, b"samguk_ocr_adapter:internal_error\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
