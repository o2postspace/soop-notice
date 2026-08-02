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
DECIMAL_RE = re.compile(r"^\+?(\d{1,3}(?:,\d{3})*|\d{1,9})(?:\.(\d{1,4}))?$")
PERCENT_RE = re.compile(r"^([+-]?\d{1,6}(?:\.\d{1,4})?)%$")
ENHANCEMENT_RE = re.compile(r"(?:\(\s*)?\+\s*(\d{1,2})(?:\s*\))?|(?<!\d)(\d{1,2})\s*강")
ENHANCEMENT_PAREN_RE = re.compile(r"\((\d{1,2})\)$")
HORSE_STAGE_RE = re.compile(r"(?<!\d)(\d{1,2})단계")
HEALTH_RATIO_RE = re.compile(
    r"^\(?\s*(\d{1,3}(?:,\d{3})*|\d{1,7})\s*/\s*"
    r"(\d{1,3}(?:,\d{3})*|\d{1,7})\s*\)?$",
)
HORSE_HEALTH_RATIO_RE = re.compile(
    r"^\(?\s*(\d{1,3}(?:,\d{3})*|\d{1,7})\s*/\s*"
    r"(\d{1,3}(?:,\d{3})*|\d{1,7})\s*HP\s*\)?$",
    re.IGNORECASE,
)
COMBINED_GEAR_TITLE_RE = re.compile(
    r"^(무기|두갑|두건|투구|흉갑|갑옷|각갑|신발)\(\+(\d{1,2})\)$",
)

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
INFO_LABEL_FIELDS = {
    "현재영군": "activeGeneral",
    "공격력": "attackPower",
    "방어력": "defense",
    "공격력증가량": "attackPowerBonusPct",
    "받는피해감소": "damageReductionPct",
    "치명타확률": "criticalChancePct",
    "치명타대미지": "criticalDamagePct",
    "치명타데미지": "criticalDamagePct",
    "크리티컬확률": "criticalChancePct",
    "크리티컬대미지": "criticalDamagePct",
    "크리티컬데미지": "criticalDamagePct",
    "절기대기시간감소": "skillCooldownReductionPct",
    "쿨타임감소율": "skillCooldownReductionPct",
    "절기피해량증가량": "skillDamageBonusPct",
    "절기피해량증가": "skillDamageBonusPct",
    "이동속도증가량": "moveSpeedBonusPct",
    "이동속도증가율": "moveSpeedBonusPct",
}
INFO_FIELD_ROWS = (
    ("healthStat", 0, "number"),
    ("activeGeneral", 1, "text"),
    ("attackPower", 3, "number"),
    ("defense", 4, "number"),
    ("attackPowerBonusPct", 5, "percent"),
    ("damageReductionPct", 6, "percent"),
    ("criticalChancePct", 7, "percent"),
    ("criticalDamagePct", 8, "percent"),
    ("skillCooldownReductionPct", 9, "percent"),
    ("skillDamageBonusPct", 10, "percent"),
    ("moveSpeedBonusPct", 11, "percent"),
)
INFO_FIELD_ROW_INDEX = {field: row for field, row, _kind in INFO_FIELD_ROWS}
FLEXIBLE_INFO_FIELDS = ("skillDamageBonusPct", "moveSpeedBonusPct")
RED_HARE_HEALTH_LEVELS = {1700: 0, 1900: 1}
ENHANCEMENT_MARKERS = (
    "장비강화", "강화성공확률", "단계하락확률", "강화비용", "강화하기",
)
HORSE_PANEL_HEADERS = ("군마영",)
HORSE_PANEL_TABS = ("장착", "강화", "합성")
HUD_COMBAT_PROFILE = "hud-combat-v1"


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


def _decimal_value(text: str) -> Optional[int | float]:
    match = DECIMAL_RE.fullmatch(compact_text(text))
    if not match:
        return None
    integer_part = match.group(1).replace(",", "")
    value = float(f"{integer_part}.{match.group(2)}") if match.group(2) else int(integer_part)
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _percentage_value(text: str) -> Optional[int | float]:
    match = PERCENT_RE.fullmatch(compact_text(text))
    if not match:
        return None
    value = float(match.group(1))
    return int(value) if value.is_integer() else value


def _active_general_value(text: str) -> Optional[str]:
    value = " ".join(unicodedata.normalize("NFKC", text).split())
    parenthesized = re.search(r"\(([^()]{1,40})\)", value)
    if parenthesized:
        # 직업/칭호 부분의 작은 글자는 오독이 잦지만 괄호 안 장수명은
        # 선명하다. 오독된 접두어를 원장에 저장하지 않는다.
        value = parenthesized.group(1).strip()
    compact = compact_text(value)
    if not value or len(value) > 80 or compact in INFO_LABEL_FIELDS:
        return None
    if _decimal_value(compact) is not None or _percentage_value(compact) is not None:
        return None
    if not re.search(r"[A-Za-z가-힣]", value):
        return None
    return value


def _active_general_consensus(
    image: Any,
    token: Token,
    fallback_value: str,
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> tuple[str, float]:
    """괄호 안 장수명만 잘라 3배율이 합의할 때 raw confidence를 교체한다."""
    source = " ".join(unicodedata.normalize("NFKC", token.text).split())
    parenthesized = re.search(r"\(([^()]{1,40})\)", source)
    if not parenthesized or not source:
        return fallback_value, token.confidence

    height, width = image.shape[:2]
    # detector bbox 안의 문자 폭이 대체로 균일하므로 OCR 문자열에서 괄호가
    # 시작하는 비율로 접두어를 버린다. 고정 화면 ROI는 사용하지 않는다.
    start_ratio = parenthesized.start() / len(source)
    x0 = max(0, int(math.floor(token.x0 + token.width * start_ratio)))
    x1 = min(width, int(math.ceil(token.x1)))
    y0 = max(0, int(math.floor(token.y0)))
    y1 = min(height, int(math.ceil(token.y1)))
    if x1 <= x0 or y1 <= y0:
        return fallback_value, token.confidence

    crop = image[y0:y1, x0:x1]
    votes: list[tuple[str, float]] = []
    for scale in (1, 2, 4):
        text, score = line_reader(crop, scale)
        value = _active_general_value(text)
        if value is None or not 0 <= score <= 1:
            return fallback_value, token.confidence
        value = value.strip("() ")
        if not re.fullmatch(r"[A-Za-z가-힣·]{1,20}", value):
            return fallback_value, token.confidence
        votes.append((value, score))
    names = {value for value, _score in votes}
    if len(votes) != 3 or len(names) != 1:
        return fallback_value, token.confidence
    value = votes[0][0]
    return value, max(token.confidence, min(score for _value, score in votes))


def _information_panel(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> tuple[bool, list[dict[str, Any]]]:
    """구조가 고정된 캐릭터 정보창의 우측 값 열을 읽는다.

    공격력/방어력처럼 작은 회색 라벨은 OCR이 자주 깨진다. 그래서 ``소속``과
    바로 아래 ``체력`` 행으로 간격을 정하고, 최소 두 개의 정확한 보조 라벨과
    네 개의 백분율 값이 같은 열에 있을 때만 행 기반 추출을 허용한다.
    """
    candidates: list[tuple[tuple[int, int, float], list[dict[str, Any]]]] = []
    affiliations = [token for token, text in normalized if text == "소속"]
    health_labels = [token for token, text in normalized if text == "체력"]

    for affiliation in affiliations:
        for health_label in health_labels:
            step = health_label.cy - affiliation.cy
            label_height = max(affiliation.height, health_label.height)
            # 저해상도 frame에서는 두 detector bbox가 조금 겹쳐 중심 간격이
            # bbox 높이보다 작다. 이후 라벨/숫자열 검증이 있으므로 이를 허용한다.
            if not (0.80 * label_height <= step <= 4.0 * label_height):
                continue
            if abs(health_label.cx - affiliation.cx) > 2.0 * label_height:
                continue

            row_tolerance = max(0.46 * step, 0.60 * health_label.height)
            health_values: list[tuple[float, Token, int | float]] = []
            for token, _text in normalized:
                value = _decimal_value(token.text)
                if value is None or token is health_label:
                    continue
                if abs(token.cy - health_label.cy) > row_tolerance:
                    continue
                if token.x0 < health_label.x1 + step:
                    continue
                if token.cx - health_label.cx > 18.0 * step:
                    continue
                # 정보창 값은 우측 정렬이다. 같은 행에서는 가장 오른쪽 값을
                # 우선하되 confidence도 작은 tie-break로만 사용한다.
                health_values.append((token.x1 + token.confidence * 0.01, token, value))
            if not health_values:
                continue
            _, health_value_token, health_value = max(health_values, key=lambda item: item[0])
            value_right = health_value_token.x1
            value_x_min = health_label.x1 + step
            structural_confidence = min(affiliation.confidence, health_label.confidence)

            anchor_fields: set[str] = set()
            anchor_steps: list[float] = []
            flexible_labels: dict[str, list[Token]] = {
                field: [] for field in FLEXIBLE_INFO_FIELDS
            }
            for token, text in normalized:
                field = INFO_LABEL_FIELDS.get(text)
                if field is None or token.cx >= health_value_token.x0 - 0.25 * step:
                    continue
                if field in flexible_labels:
                    # 구버전 정보창은 마지막 두 행(이동속도/절기피해)의 순서가
                    # 반대다. 고정 행 anchor들의 간격을 구한 뒤 배치한다.
                    delta_y = token.cy - health_label.cy
                    if 7.5 * step <= delta_y <= 14.5 * step:
                        flexible_labels[field].append(token)
                    continue
                expected_row = INFO_FIELD_ROW_INDEX[field]
                if expected_row < 1:
                    continue
                observed_step = (token.cy - health_label.cy) / expected_row
                if not (0.75 * step <= observed_step <= 1.35 * step):
                    continue
                anchor_fields.add(field)
                anchor_steps.append(observed_step)
            possible_anchor_count = len(anchor_fields) + sum(bool(items) for items in flexible_labels.values())
            if possible_anchor_count < 2:
                continue

            # 첫 두 행보다 아래 통계 행의 간격이 2~3px 더 넓은 화면이 있다.
            # 정확히 읽힌 라벨들의 기대 행 번호로 전체 기울기를 다시 잡는다.
            if anchor_steps:
                anchor_steps.sort()
                middle = len(anchor_steps) // 2
                refined_step = anchor_steps[middle] if len(anchor_steps) % 2 else (
                    anchor_steps[middle - 1] + anchor_steps[middle]
                ) / 2
            else:
                refined_step = step
            row_tolerance = min(
                0.48 * refined_step,
                max(0.40 * refined_step, 0.55 * health_label.height),
            )

            field_rows = dict(INFO_FIELD_ROW_INDEX)
            flexible_positions: dict[str, tuple[Token, float, float]] = {}
            for field, items in flexible_labels.items():
                if not items:
                    continue
                token = min(
                    items,
                    key=lambda item: min(
                        abs(item.cy - (health_label.cy + row * refined_step)) for row in (10, 11)
                    ),
                )
                distance_10 = abs(token.cy - (health_label.cy + 10 * refined_step))
                distance_11 = abs(token.cy - (health_label.cy + 11 * refined_step))
                if min(distance_10, distance_11) <= 0.75 * refined_step:
                    flexible_positions[field] = (token, distance_10, distance_11)

            skill_position = flexible_positions.get("skillDamageBonusPct")
            move_position = flexible_positions.get("moveSpeedBonusPct")
            if skill_position and move_position:
                default_cost = skill_position[1] + move_position[2]
                swapped_cost = skill_position[2] + move_position[1]
                if swapped_cost < default_cost:
                    field_rows["skillDamageBonusPct"] = 11
                    field_rows["moveSpeedBonusPct"] = 10
                anchor_fields.update(FLEXIBLE_INFO_FIELDS)
            elif skill_position:
                skill_row = 10 if skill_position[1] <= skill_position[2] else 11
                field_rows["skillDamageBonusPct"] = skill_row
                field_rows["moveSpeedBonusPct"] = 21 - skill_row
                anchor_fields.add("skillDamageBonusPct")
            elif move_position:
                move_row = 10 if move_position[1] <= move_position[2] else 11
                field_rows["moveSpeedBonusPct"] = move_row
                field_rows["skillDamageBonusPct"] = 21 - move_row
                anchor_fields.add("moveSpeedBonusPct")

            values: dict[str, tuple[Any, float]] = {
                "healthStat": (health_value, health_value_token.confidence),
            }
            for field, row, kind in INFO_FIELD_ROWS[1:]:
                row = field_rows[field]
                target_y = health_label.cy + row * refined_step
                row_candidates: list[tuple[float, Token, Any]] = []
                for token, _text in normalized:
                    if token.x0 < value_x_min:
                        continue
                    y_distance = abs(token.cy - target_y)
                    if y_distance > row_tolerance:
                        continue
                    right_distance = abs(token.x1 - value_right)
                    if right_distance > 3.0 * refined_step:
                        continue
                    if kind == "number":
                        parsed = _decimal_value(token.text)
                    elif kind == "percent":
                        parsed = _percentage_value(token.text)
                    else:
                        parsed = _active_general_value(token.text)
                    if parsed is None:
                        continue
                    distance = y_distance + right_distance * 0.20 - token.confidence * 0.01
                    row_candidates.append((distance, token, parsed))
                if row_candidates:
                    _, value_token, value = min(row_candidates, key=lambda item: item[0])
                    value_confidence = value_token.confidence
                    if field == "activeGeneral":
                        value, value_confidence = _active_general_consensus(
                            image, value_token, value, line_reader,
                        )
                    values[field] = (value, value_confidence)

            percent_count = sum(
                field in values for field, _row, kind in INFO_FIELD_ROWS if kind == "percent"
            )
            numeric_count = sum(
                field in values for field, _row, kind in INFO_FIELD_ROWS if kind in ("number", "percent")
            )
            if len(anchor_fields) < 2 or percent_count < 4 or numeric_count < 6:
                continue

            results = [
                {
                    "field": field,
                    "value": values[field][0],
                    "confidence": min(structural_confidence, values[field][1]),
                }
                for field, _row, _kind in INFO_FIELD_ROWS
                if field in values
            ]
            score = (len(results), len(anchor_fields), structural_confidence)
            candidates.append((score, results))

    if not candidates:
        return False, []
    _, results = max(candidates, key=lambda item: item[0])
    return True, results


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
        if value is not None and 0 <= value <= 15 and 0 <= score <= 1:
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
            if 0 <= value <= 80:
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


def _player_max_health(
    image: Any,
    tokens: Sequence[Token],
) -> Optional[tuple[int, float]]:
    """중앙 하단 플레이어 HUD의 ``현재/최대`` 체력 표기만 고른다.

    우측 하단 군마 HP, 좌상단 날짜·재화와 혼동하지 않도록 좌표를
    해상도 비율로 제한한다. OCR confidence를 구조만으로 올리지 않는다.
    """
    height, width = image.shape[:2]
    candidates = []
    for token in tokens:
        match = HEALTH_RATIO_RE.fullmatch(
            unicodedata.normalize("NFKC", token.text).strip(),
        )
        if not match:
            continue
        current = int(match.group(1).replace(",", ""))
        maximum = int(match.group(2).replace(",", ""))
        if maximum < 1 or maximum > 1_000_000 or current < 0 or current > maximum:
            continue
        normalized_x = token.cx / width
        normalized_y = token.cy / height
        normalized_height = token.height / height
        if not (0.20 <= normalized_x <= 0.70 and 0.78 <= normalized_y <= 0.98):
            continue
        if not (0.008 <= normalized_height <= 0.08):
            continue
        distance = abs(normalized_x - 0.42) + abs(normalized_y - 0.93)
        candidates.append((distance, -token.confidence, maximum, token.confidence))
    if not candidates:
        return None
    _, _, maximum, confidence = min(candidates)
    return maximum, confidence


def _horse_max_health(
    image: Any,
    tokens: Sequence[Token],
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> Optional[tuple[int, float]]:
    """우측 하단의 ``(현재/최대HP)`` 군마 체력만 고른다."""
    height, width = image.shape[:2]
    candidates = []
    for token in tokens:
        text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", token.text))
        match = HORSE_HEALTH_RATIO_RE.fullmatch(text)
        if not match:
            continue
        current = int(match.group(1).replace(",", ""))
        maximum = int(match.group(2).replace(",", ""))
        if maximum < 1 or maximum > 1_000_000 or current < 0 or current > maximum:
            continue
        normalized_x = token.cx / width
        normalized_y = token.cy / height
        normalized_height = token.height / height
        if not (0.70 <= normalized_x <= 0.99 and 0.72 <= normalized_y <= 0.99):
            continue
        if not (0.008 <= normalized_height <= 0.08):
            continue
        confidence = token.confidence
        x0 = max(0, int(math.floor(token.x0)))
        x1 = min(width, int(math.ceil(token.x1)))
        y0 = max(0, int(math.floor(token.y0)))
        y1 = min(height, int(math.ceil(token.y1)))
        if x1 > x0 and y1 > y0:
            crop = image[y0:y1, x0:x1]
            votes: list[tuple[int, int, float]] = []
            for scale in (1, 2, 4):
                recrop_text, score = line_reader(crop, scale)
                recrop_match = HORSE_HEALTH_RATIO_RE.fullmatch(
                    re.sub(r"\s+", "", unicodedata.normalize("NFKC", recrop_text)),
                )
                if not recrop_match or not 0 <= score <= 1:
                    votes = []
                    break
                recrop_current = int(recrop_match.group(1).replace(",", ""))
                recrop_maximum = int(recrop_match.group(2).replace(",", ""))
                if recrop_maximum < 1 or recrop_current < 0 or recrop_current > recrop_maximum:
                    votes = []
                    break
                votes.append((recrop_current, recrop_maximum, score))
            ratios = {(current_value, maximum_value) for current_value, maximum_value, _score in votes}
            if len(votes) == 3 and len(ratios) == 1 and votes[0][1] == maximum:
                # 다른 최대체력으로의 외삽은 금지하고, 세 raw score 중 최저값만 쓴다.
                confidence = max(confidence, min(score for _current, _maximum, score in votes))
        distance = abs(normalized_x - 0.91) + abs(normalized_y - 0.93)
        candidates.append((distance, -confidence, maximum, confidence))
    if not candidates:
        return None
    _, _, maximum, confidence = min(candidates)
    return maximum, confidence


def parse_panel(
    image: Any,
    tokens: Sequence[Token],
    line_reader: Callable[[Any, int], tuple[str, float]],
    profile: str = DEFAULT_PROFILE,
) -> tuple[bool, list[dict[str, Any]]]:
    normalized = [(token, compact_text(token.text)) for token in tokens if token.confidence >= 0.30]
    info_panel, info_results = _information_panel(image, normalized, line_reader)
    stat_labels = [(token, STAT_FIELDS[text]) for token, text in normalized if text in STAT_FIELDS]
    quantity_titles = [token for token, text in normalized if text == "기량"]
    stat_panel = bool(quantity_titles) and len({field for _, field in stat_labels}) >= 3

    results: list[dict[str, Any]] = list(info_results)
    if stat_panel:
        for label, field in stat_labels:
            match = _neighbor_value(label, tokens)
            if match is not None and field not in {item["field"] for item in results}:
                value, confidence = match
                results.append({"field": field, "value": value, "confidence": confidence})
        # title + exact label/value 구조는 panel 판별에만 사용한다.
        # 숫자 confidence는 잘못 읽은 값도 반복될 수 있어 절대 상향하지 않는다.

    for title, text in normalized:
        combined = COMBINED_GEAR_TITLE_RE.fullmatch(text)
        if not combined:
            continue
        field = GEAR_FIELDS[combined.group(1)]
        value = int(combined.group(2))
        if 0 <= value <= 15 and field not in {item["field"] for item in results}:
            results.append({"field": field, "value": value, "confidence": title.confidence})

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

    hud_visible = False
    if profile == HUD_COMBAT_PROFILE:
        max_health = _player_max_health(image, tokens)
        if max_health is not None:
            value, confidence = max_health
            results.append({"field": "maxHealth", "value": value, "confidence": confidence})
            hud_visible = True

        horse_health = _horse_max_health(image, tokens, line_reader)
        if horse_health is not None:
            value, confidence = horse_health
            results.append({"field": "horseMaxHealth", "value": value, "confidence": confidence})
            hud_visible = True
            horse_level = RED_HARE_HEALTH_LEVELS.get(value)
            if horse_level is not None:
                results.append({"field": "horse", "value": "적토마", "confidence": confidence})
                if "horseLevel" not in {item["field"] for item in results}:
                    results.append({"field": "horseLevel", "value": horse_level, "confidence": confidence})

    texts = {text for _, text in normalized}
    marker_count = sum(any(marker in text for text in texts) for marker in ENHANCEMENT_MARKERS)
    has_stage = any("단계" in text and ("→" in text or "->" in text) for text in texts)
    # 작은 단계 제목이 detector에서 빠져도 성공/하락/button/비용의 네 구조가
    # 동시에 있으면 강화 panel로 볼 수 있다. 장비 종류가 없으면 값은 비운다.
    enhancement_panel = marker_count >= 3 and (has_stage or marker_count >= 4)
    panel_visible = info_panel or stat_panel or enhancement_panel or horse_panel or hud_visible or bool(results)
    order = {name: index for index, name in enumerate(
        (
            "maxHealth", "healthStat", "activeGeneral", "attackPower", "defense",
            "attackPowerBonusPct", "damageReductionPct", "criticalChancePct",
            "criticalDamagePct", "skillCooldownReductionPct", "skillDamageBonusPct",
            "moveSpeedBonusPct", "horseMaxHealth", "horse", "horseLevel",
            "weapon", "helmet", "armor", "shoes",
            "strength", "agility", "vitality", "intelligence",
        )
    )}
    results.sort(key=lambda item: order.get(item["field"], len(order)))
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
    visible, results = parse_panel(image, tokens, runtime.recognize_line, profile=profile)
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
