#!/usr/bin/env python3
"""SOOP 삼국지 whole-frame OCR adapter.

stdin으로 PNG 한 장을 받고 stdout에는 strict v2 JSON 한 개만 쓴다.
RapidOCR의 import/초기화/inference 출력은 fd 수준에서 폐기한다.
"""

from __future__ import annotations

import json
import hashlib
import base64
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
CURRENT_SEASON_ID = "hugukji-2026-08-04"
DEFAULT_PROFILE = "stats-panel-v1"
MAX_PNG_BYTES = 16 * 1024 * 1024
MAX_PIXELS = 4096 * 2160
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PROFILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
INTEGER_RE = re.compile(r"^(\d{1,3}(?:,\d{3})*|\d{1,9})(?:\([+-]?\d+(?:\.\d+)?\))?$")
QUANTITY_VALUE_RE = re.compile(
    r"^(\d{1,3}(?:,\d{3})*|\d{1,9})(?:\(([+-]?\d+(?:\.\d+)?)\))?$",
)
DECIMAL_RE = re.compile(r"^\+?(\d{1,3}(?:,\d{3})*|\d{1,9})(?:\.(\d{1,4}))?$")
PERCENT_RE = re.compile(r"^([+-]?\d{1,6}(?:\.\d{1,4})?)%$")
ENHANCEMENT_RE = re.compile(r"(?:\(\s*)?\+\s*(\d{1,2})(?:\s*\))?|(?<!\d)(\d{1,2})\s*강")
ENHANCEMENT_PAREN_RE = re.compile(r"\((\d{1,2})\)$")
ENHANCEMENT_STAGE_RE = re.compile(
    r"(?<!\d)(\d{1,2})단(?:계|게|제)?(?:→|->|=>|[〉>])?(\d{1,2})단(?:계|게|제)?",
)
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
ITEM_ENHANCEMENT_TITLE_RE = re.compile(r"^([A-Za-z0-9가-힣]{2,40})\(\+(\d{1,2})\)$")

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
STAT_BONUS_FIELDS = {
    "strength": "strengthBonus",
    "agility": "agilityBonus",
    "vitality": "vitalityBonus",
    "intelligence": "intelligenceBonus",
}
QUANTITY_DERIVED_FIELDS = {
    "공격력증가량": "attackPowerIncrease",
    "이동속도증가량": "moveSpeedIncrease",
    "체력증가량": "healthIncrease",
    "절기가속증가량": "skillHasteIncrease",
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
    "받는피해검소": "damageReductionPct",
    "치명타확률": "criticalChancePct",
    "치명타대미지": "criticalDamagePct",
    "차명타대미지": "criticalDamagePct",
    "치명타데미지": "criticalDamagePct",
    "크리티컬확률": "criticalChancePct",
    "크리티컬대미지": "criticalDamagePct",
    "크리티컬데미지": "criticalDamagePct",
    "절기대기시간감소": "skillCooldownReductionPct",
    "철기대기시간검소": "skillCooldownReductionPct",
    "쿨타임감소율": "skillCooldownReductionPct",
    "절기피해량증가량": "skillDamageBonusPct",
    "절기피해량증가": "skillDamageBonusPct",
    "이동속도증가량": "moveSpeedBonusPct",
    "이품속도증가량": "moveSpeedBonusPct",
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
INFO_AFFILIATION_VALUES = ("위나라", "촉나라", "오나라")
RED_HARE_HEALTH_LEVELS = {1700: 0, 1900: 1}
ENHANCEMENT_MARKERS = (
    "장비강화", "강화성공확률", "단계하락확률", "강화비용", "강화하기",
)
HORSE_PANEL_HEADERS = ("군마영",)
HORSE_PANEL_TABS = ("장착", "강화", "합성")
HUD_COMBAT_PROFILE = "hud-combat-v1"
SKILL_BUILD_ROWS = (
    ("유성보", 1),
    ("호신강기", 1),
    ("회선난", 1),
    ("천패강림", 2),
    ("비룡귀참", 2),
    ("승천낙뢰", 2),
)
SKILL_NAME_ALIASES = {
    "유성보": "유성보",
    "류성보": "유성보",
    "유성브": "유성보",
    "류성브": "유성보",
    "성보": "유성보",
    "호신강기": "호신강기",
    "호신감기": "호신강기",
    "회선난": "회선난",
    "회선란": "회선난",
    "회신난": "회선난",
    "해선남": "회선난",
    "최선난": "회선난",
    "천패강림": "천패강림",
    "천파강림": "천패강림",
    "천폐강림": "천패강림",
    "천패강원": "천패강림",
    "전패강원": "천패강림",
    "전패강": "천패강림",
    "전대강일": "천패강림",
    "전매강일": "천패강림",
    "전태강일": "천패강림",
    "전태강희": "천패강림",
    "비룡귀참": "비룡귀참",
    "위룡귀참": "비룡귀참",
    "비룡귀잠": "비룡귀참",
    "비룡구참": "비룡귀참",
    "비룡귀첨": "비룡귀참",
    "비귀장": "비룡귀참",
    "비장": "비룡귀참",
    "비": "비룡귀참",
    "승천낙뢰": "승천낙뢰",
    "승천낙회": "승천낙뢰",
    "승천낙뇌": "승천낙뢰",
    "승천낙의": "승천낙뢰",
    "승천남의": "승천낙뢰",
    "승천난의": "승천낙뢰",
    "승전난의": "승천낙뢰",
}
SKILL_EXACT_NAME_ALIASES = frozenset(("비",))
SKILL_FALLBACK_ROW_STEP = 0.0685
SKILL_FALLBACK_NAME_BOUNDS = (0.375, 0.214, 0.428, 0.247)
SKILL_FALLBACK_REQUIRED_BOUNDS = (0.536, 0.202, 0.559, 0.236)
SKILL_FALLBACK_ALLOCATED_BOUNDS = (0.594, 0.202, 0.618, 0.236)
SKILL_FALLBACK_OWNED_BOUNDS = (0.486, 0.837, 0.499, 0.868)
SKILL_NINE_ROW_COUNT = 9
SKILL_NINE_ROW_STEP = 73 / 1080
SKILL_NINE_NAME_BOUNDS = (718 / 1920, 236 / 1080, 825 / 1920, 266 / 1080)
# Tooltip이 없는 강화창에서는 실제 아이콘과 충분히 비슷한 template만 쓴다.
# 각 template은 장비창 제목/단계/button 구조와 함께 사용되므로 단독 분류하지 않는다.
GEAR_ICON_TEMPLATES_B64 = {
    "weapon": (
        "WkM8PkJGTE9QTUQ/PENXXDg7SE5NUFJRVFdWUkpAOkJDR0hKSUpNT1FSUVBOSkY7QUJCRUdJTE5OTUtJSEY/"
        "PmdoaGpqa2pra2xramlnZmcqKiosLS0uLi4uLi4vLi4tKSkrKysrKikoKSkpKiopKCgoKi0tLSwsKioqKisr"
        "KigoKiwuLi0tKysqLSwrKywqKSkpKysrKyssKi0zODstKykqKioqKigqKy0+S1JXSS8rKysrKyooKC1AST8z"
        "TXAvKysrKysqKicsQDMmU3s4LSsrKissKisoMz0qU4E7MCorKysqLioqOkIwT4tIJissKiorKS8rNEU0Tn5N"
        "KSkoKSgoKCgsMD4zQYJKKC0pKSknJyw4PDozQ4JGJykoKCkpJic+UDgtPoNCJygpKikpKScoSEUnOodILCko"
        "KysqKCgnM1I2PodPJikoKSooKCcnJztTO3lRLCgnJyYnJycmJiYuT3BZKCwqJyYlJiYlJSQmJjpHLCwqKCYm"
        "JiYmJiYl",
        "HBwcHR8fHx8eHR0bGRoaHBwcHR4fHx8fHx4dJy4kHhwcHB0dHx8fHx4eLElPViwcHBwdHR0dHR0dJElRWkQh"
        "HRwcHR0dHRwdIDE5WVEgHh0cHB0dHR0dIiszRkQkHh8eHBwdHh0dIS8yOTghHR4dHRwcHR4cICEnMzEjHx0e"
        "HhwcHB0eKSEiKyojIB8dHBwcHBwdKUguKCwfHx4eHRwbGxwcHidETDgcHR0eHhwbGhobGh8xPEk3HB0dHR0c"
        "GxoaGxo6Sh4eHh0dHBwdHBsaGh0nMSIcHR0cHB0cHBsaGhodKSAbHR0cHBwdHBsbGhkZGR8eGxwcGxscHBsb"
        "GhkZGRgZGhoaGhoaGhoaGRkYGBkTExMTExMTExMSExMTEhITNjY2NTY2NTY2NTY2NjU1NiwsLSwtLSwtLS0s"
        "LCoqLC0lHhkeHh4fHx8fHh0dIiYcJC0oIiAfHh8eHyAnKiYdGRQWIiosLCksLSopJBsWFRwXFhIWGh0dHRsX"
        "FBQXGBcY",
    ),
    "armor": (
        "GxsbGxsbHywfGxsbGxsbGxsbGxsbHS9ZLhoaGxsaGxsbGxsmLCIgSS4lIyEbGhobGxsaMz0xRWBUYk4tHRob"
        "GhsbHC4pRYFuRj8+PSIcHBoZHDcyIzpYWkMuQlAoIR0bGyRANSMzSUtEIzViQRoaGhgaNTMjMUc3IhAXWEkm"
        "HxoaHy4mIDhCQBkTIjguHBwbGh8kHyRTYiwcGiIWHx4bGxseHyExQUUvNSUdHCAgGxscHh8pMj1SODgtIBob"
        "GhsbHB0eICM8Sj05NjEcGxobGxwcHhsdQUYzMC4gHhwaGxscHB4dHy8uIyAhHRsaGhsbGhobGhgcHBoaGxsb"
        "GhoaGhgYGRkZGhoZGRcXFxcXFxgXFxcXFxgYFxYWFhcXFxcXOzs6ODc2NjY3ODo7Ozs6OiwtLi0tLCwsLS0u"
        "Ly8uLy4hHx8eHx8fHx8fHxwcIiggHScoJSEiIiEhISEmKiQeGhMYICksKysrLS0tJxkTERoZFhUZGxsaGhkZ"
        "GBYUFRga",
    ),
}
KNOWN_GEAR_ITEM_NAMES = {"창룡극": "weapon"}
# 2026-08-03 실제 강화창의 각갑 아이콘(16x24 grayscale). 강화창 제목과
# 3-scale 단계 합의가 동시에 성립할 때만 이 template을 사용한다.
SHOES_ICON_TEMPLATE_WIDTH = 16
SHOES_ICON_TEMPLATE_HEIGHT = 24
SHOES_ICON_TEMPLATE_B64 = (
    "HyAgICAgISEgISAhISAfHiAhISEjLSw4LyghISEgIB8gICAhITJQSToiHyEgICAeICAfHyY2SUlELB8hHyAfHh8g"
    "ICI8PT1SQ1EnISAgHx4fHyAkOjg6YTlOHx8gHx8eHx8fJ0Q7Sls9SS8iIB8fHh8fHiw6O1NVOE0sISAfHx0fHx8i"
    "My9KRCwyHx4fHx4dHx8eK04rIiEpTz8hHx8eHB4fHyA0KBogIUcwIR8fHhseHh8dOC0fHx0vKR4fHh0bHh4eHTUp"
    "HR8eNTAeHh4dGx4eHiA9JiAeHywxIB4eHRweHhw4PCEfHh4zOh0dHh0cHR0dHh4dHh0dJycdHR0dGxwcHBwcHBwc"
    "HBscHBwcHBoaGRoaGhoZGRkZGRkZGRkYKSgoKCgoKCgoKCgoKCcnKD09PT09PT0+Pj49PTw9OzweHR4eHx4eHx8f"
    "Hh4dGyEpLSUgHx8fHyAgHx4fIyonGBolKiooKCYmJygrLSgcFRsXFhYbIyksLCgiHBcVFhYZ"
)


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


def _aligned_health_label_quality(affiliation: Token, health_label: Token) -> Optional[float]:
    """소속 바로 아래 체력 라벨인지 확인하고 위치 정렬 품질만 반환한다."""
    step = health_label.cy - affiliation.cy
    label_height = max(affiliation.height, health_label.height)
    if not (0.80 * label_height <= step <= 4.0 * label_height):
        return None
    horizontal_error = abs(health_label.cx - affiliation.cx) / (2.0 * label_height)
    if horizontal_error > 1.0:
        return None
    return max(0.0, 1.0 - horizontal_error)


def _relative_consistency(values: Sequence[float], center: float, tolerance: float) -> float:
    if not values or center <= 0 or tolerance <= 0:
        return 0.0
    worst_error = max(abs(value - center) for value in values) / (center * tolerance)
    return max(0.0, 1.0 - min(1.0, worst_error))


def _information_structure_confidence(
    health_geometry_quality: float,
    anchor_steps: Sequence[float],
    refined_step: float,
    value_geometry_qualities: Sequence[float],
    anchor_count: int,
) -> float:
    """OCR label score와 별개인 행/열 구조 품질을 결과 confidence 상한으로 만든다.

    작은 회색 라벨의 OCR score가 낮아도 구조 판별에는 참여할 수 있다. 대신
    anchor 간격이나 값 열 배치가 흔들린 후보는 선명한 숫자라도 0.95 쓰기
    기준을 넘지 못하도록 0.90~0.99 범위의 보수적인 상한을 적용한다.
    """
    anchor_geometry_quality = _relative_consistency(anchor_steps, refined_step, 0.35)
    value_geometry_quality = min(value_geometry_qualities, default=0.0)
    anchor_coverage = min(1.0, max(0, anchor_count) / 4.0)
    covered_anchor_quality = anchor_geometry_quality * (0.85 + 0.15 * anchor_coverage)
    geometry_quality = min(
        max(0.0, min(1.0, health_geometry_quality)),
        covered_anchor_quality,
        value_geometry_quality,
    )
    return round(0.90 + 0.09 * geometry_quality, 5)


def _information_percentage_consensus(
    image: Any,
    token: Token,
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> Optional[tuple[int | float, float]]:
    """깨진 작은 백분율 token을 동일 bbox의 3배율 합의로 복구한다."""
    height, width = image.shape[:2]
    x0 = max(0, int(math.floor(token.x0)))
    y0 = max(0, int(math.floor(token.y0)))
    x1 = min(width, int(math.ceil(token.x1)) + 1)
    y1 = min(height, int(math.ceil(token.y1)) + 1)
    if x1 <= x0 or y1 <= y0:
        return None
    crop = image[y0:y1, x0:x1]
    votes: list[int | float] = []
    scores: list[float] = []
    for scale in (1, 2, 4):
        text, score = line_reader(crop, scale)
        value = _percentage_value(text)
        if value is None or not 0 <= score <= 1:
            return None
        votes.append(value)
        scores.append(score)
    if len(set(votes)) != 1:
        return None
    # 세 독립 배율이 같은 짧은 값에 합의하고 고정 행/열 구조까지 통과한 경우의
    # 합의 신뢰도다. 최종값은 아래 structural confidence 상한을 다시 적용한다.
    return votes[0], max(token.confidence, min(scores), 0.95)


def _information_panel(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> tuple[bool, list[dict[str, Any]]]:
    """구조가 고정된 캐릭터 정보창의 우측 값 열을 읽는다.

    공격력/방어력처럼 작은 회색 라벨은 OCR이 자주 깨진다. 우선 ``소속``과
    바로 아래 ``체력`` 행으로 간격을 정한다. 축소 화면에서 ``체력`` 라벨만
    깨진 경우에는 ``정보`` 제목·나라 값·두 개 이상의 통계 라벨로 행 간격을
    복원한다. 네 개의 백분율 값이 같은 열에 있을 때만 추출을 허용한다.
    """
    candidates: list[tuple[tuple[int, int, float], list[dict[str, Any]]]] = []
    info_titles = [token for token, text in normalized if text == "정보"]
    affiliations = [
        token for token, text in normalized
        if text == "소속" or (
            text == "속" and any(
                title.cy < token.cy
                and token.cy - title.cy <= 6.0 * token.height
                and abs(token.cx - title.cx) <= 6.0 * token.height
                for title in info_titles
            )
        )
    ]
    health_labels = [token for token, text in normalized if text in ("체력", "체락")]
    affiliation_values = [
        token for token, text in normalized if text in INFO_AFFILIATION_VALUES
    ]

    for affiliation in affiliations:
        candidate_health_labels = [
            (health_label, quality)
            for health_label in health_labels
            if (quality := _aligned_health_label_quality(affiliation, health_label)) is not None
        ]
        if not candidate_health_labels:
            title = next((
                token for token in info_titles
                if token.cy < affiliation.cy
                and 0.5 * affiliation.height <= affiliation.cy - token.cy <= 8.0 * affiliation.height
                and abs(token.cx - affiliation.cx) <= 12.0 * affiliation.height
            ), None)
            country = next((
                token for token in affiliation_values
                if token.x0 > affiliation.x1
                and abs(token.cy - affiliation.cy) <= 1.2 * max(token.height, affiliation.height)
                and token.cx - affiliation.cx <= 20.0 * affiliation.height
            ), None)
            inferred_steps = []
            if title is not None and country is not None:
                for token, text in normalized:
                    field = INFO_LABEL_FIELDS.get(text)
                    if field is None or field in FLEXIBLE_INFO_FIELDS:
                        continue
                    row = INFO_FIELD_ROW_INDEX[field]
                    if row < 1 or token.cy <= affiliation.cy:
                        continue
                    step = (token.cy - affiliation.cy) / (row + 1)
                    if 0.65 * affiliation.height <= step <= 5.0 * affiliation.height:
                        inferred_steps.append(step)
            if len(inferred_steps) >= 2:
                inferred_steps.sort()
                middle = len(inferred_steps) // 2
                inferred_step = inferred_steps[middle] if len(inferred_steps) % 2 else (
                    inferred_steps[middle - 1] + inferred_steps[middle]
                ) / 2
                consistent_steps = [
                    step for step in inferred_steps
                    if 0.75 * inferred_step <= step <= 1.35 * inferred_step
                ]
                if len(consistent_steps) >= 2:
                    inference_quality = _relative_consistency(
                        consistent_steps, inferred_step, 0.35,
                    )
                    half_height = affiliation.height / 2
                    health_cy = affiliation.cy + inferred_step
                    candidate_health_labels.append((
                        Token(
                            "체력",
                            min(affiliation.confidence, title.confidence, country.confidence),
                            affiliation.x0,
                            health_cy - half_height,
                            affiliation.x1,
                            health_cy + half_height,
                        ),
                        inference_quality,
                    ))

        for health_label, health_geometry_quality in candidate_health_labels:
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
            health_value_geometry_quality = 1.0 - min(
                1.0,
                abs(health_value_token.cy - health_label.cy) / row_tolerance,
            )

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
            value_geometry_qualities = [health_value_geometry_quality]
            for field, row, kind in INFO_FIELD_ROWS[1:]:
                row = field_rows[field]
                target_y = health_label.cy + row * refined_step
                row_candidates: list[tuple[float, Token, Any, float]] = []
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
                        parsed_confidence = token.confidence
                        if parsed is None or token.confidence < 0.95:
                            consensus = _information_percentage_consensus(
                                image, token, line_reader,
                            )
                            if consensus is not None:
                                parsed, parsed_confidence = consensus
                    else:
                        parsed = _active_general_value(token.text)
                    if parsed is None:
                        continue
                    distance = y_distance + right_distance * 0.20 - token.confidence * 0.01
                    y_quality = 1.0 - min(1.0, y_distance / row_tolerance)
                    right_quality = 1.0 - min(1.0, right_distance / (3.0 * refined_step))
                    geometry_quality = 0.75 * y_quality + 0.25 * right_quality
                    candidate_token = token
                    if kind == "percent":
                        candidate_token = Token(
                            token.text, parsed_confidence,
                            token.x0, token.y0, token.x1, token.y1,
                        )
                    row_candidates.append((distance, candidate_token, parsed, geometry_quality))
                if row_candidates:
                    _, value_token, value, geometry_quality = min(
                        row_candidates, key=lambda item: item[0],
                    )
                    value_confidence = value_token.confidence
                    if field == "activeGeneral":
                        value, value_confidence = _active_general_consensus(
                            image, value_token, value, line_reader,
                        )
                    values[field] = (value, value_confidence)
                    value_geometry_qualities.append(geometry_quality)

            percent_count = sum(
                field in values for field, _row, kind in INFO_FIELD_ROWS if kind == "percent"
            )
            numeric_count = sum(
                field in values for field, _row, kind in INFO_FIELD_ROWS if kind in ("number", "percent")
            )
            if len(anchor_fields) < 2 or percent_count < 4 or numeric_count < 6:
                continue

            structural_confidence = _information_structure_confidence(
                health_geometry_quality,
                anchor_steps,
                refined_step,
                value_geometry_qualities,
                len(anchor_fields),
            )
            results = [
                {
                    "field": field,
                    "value": values[field][0],
                    "confidence": min(values[field][1], structural_confidence),
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


def _quantity_value(text: str) -> Optional[tuple[int, Optional[int | float]]]:
    match = QUANTITY_VALUE_RE.fullmatch(compact_text(text))
    if not match:
        return None
    base = int(match.group(1).replace(",", ""))
    bonus: Optional[int | float] = None
    if match.group(2) is not None:
        parsed = float(match.group(2))
        if parsed >= 0:
            bonus = int(parsed) if parsed.is_integer() else parsed
    return base, bonus


def _neighbor_parsed_value(
    label: Token,
    tokens: Sequence[Token],
    parser: Callable[[str], Any],
    max_below_factor: float = 3.2,
) -> Optional[tuple[Any, float]]:
    candidates = []
    for value_token in tokens:
        value = parser(value_token.text)
        if value is None or value_token is label:
            continue
        below = (
            value_token.y0 >= label.y0
            and value_token.y0 - label.y1 <= max_below_factor * label.height
        )
        aligned = abs(value_token.cx - label.cx) <= max(3.0 * label.height, label.width)
        right = value_token.x0 >= label.x1 - label.height and value_token.x0 - label.x1 <= 12 * label.height
        same_line = abs(value_token.cy - label.cy) <= 1.1 * max(label.height, value_token.height)
        if below and aligned:
            distance = max(0.0, value_token.y0 - label.y1) + abs(value_token.cx - label.cx) * 0.25
        elif right and same_line:
            distance = max(0.0, value_token.x0 - label.x1) + abs(value_token.cy - label.cy)
        else:
            continue
        candidates.append((distance, value, min(label.confidence, value_token.confidence)))
    if not candidates:
        return None
    _, value, confidence = min(candidates)
    return value, confidence


def _enhancement_stage_value(text: str) -> Optional[tuple[int, int]]:
    match = ENHANCEMENT_STAGE_RE.search(compact_text(text))
    if not match:
        return None
    current, target = int(match.group(1)), int(match.group(2))
    if not (0 <= current <= 15 and target == current + 1 and target <= 15):
        return None
    return current, target


def _enhancement_stage_consensus(
    image: Any,
    header: Token,
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> Optional[int]:
    height, width = image.shape[:2]
    unit = header.height
    x0 = max(0, int(header.cx - 3.5 * unit))
    x1 = min(width, int(header.cx + 3.5 * unit))
    y0 = max(0, int(header.y1 + 2.0 * unit))
    y1 = min(height, int(header.y1 + 4.0 * unit))
    if x1 <= x0 or y1 <= y0:
        return None
    crop = image[y0:y1, x0:x1]
    votes = []
    for scale in (1, 2, 4):
        text, score = line_reader(crop, scale)
        value = _enhancement_stage_value(text)
        if value is None or not 0 <= score <= 1:
            return None
        votes.append(value)
    return votes[0][0] if len(set(votes)) == 1 else None


def _shoes_icon_similarity(image: Any, header: Token) -> float:
    return _gear_icon_similarities(image, header).get("shoes", 0.0)


def _gear_icon_similarities(image: Any, header: Token) -> dict[str, float]:
    try:
        import cv2
        import numpy as np
        height, width = image.shape[:2]
        templates = {
            field: tuple(values) for field, values in GEAR_ICON_TEMPLATES_B64.items()
        }
        templates["shoes"] = (SHOES_ICON_TEMPLATE_B64,)
        scores = {field: -1.0 for field in templates}
        for unit_scale in (0.97, 1.0, 1.03):
            unit = header.height * unit_scale
            for x_shift in (-0.05, 0.0, 0.05):
                for y_shift in (-0.08, 0.0, 0.08):
                    x0 = max(0, int(header.cx + x_shift * unit - 0.64 * unit))
                    x1 = min(width, int(header.cx + x_shift * unit + 0.89 * unit))
                    y0 = max(0, int(header.y0 + y_shift * unit + 6.36 * unit))
                    y1 = min(height, int(header.y0 + y_shift * unit + 8.56 * unit))
                    if x1 <= x0 or y1 <= y0:
                        continue
                    crop = image[y0:y1, x0:x1]
                    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
                    resized = cv2.resize(
                        gray,
                        (SHOES_ICON_TEMPLATE_WIDTH, SHOES_ICON_TEMPLATE_HEIGHT),
                        interpolation=cv2.INTER_AREA,
                    ).astype(np.float64)
                    resized -= resized.mean()
                    resized_norm = float(np.linalg.norm(resized))
                    if resized_norm <= 1e-9:
                        continue
                    for field, encoded_templates in templates.items():
                        for encoded in encoded_templates:
                            template = np.frombuffer(
                                base64.b64decode(encoded, validate=True), dtype=np.uint8,
                            ).reshape(
                                SHOES_ICON_TEMPLATE_HEIGHT, SHOES_ICON_TEMPLATE_WIDTH,
                            ).astype(np.float64)
                            template -= template.mean()
                            denominator = resized_norm * float(np.linalg.norm(template))
                            if denominator > 1e-9:
                                similarity = float(np.sum(resized * template) / denominator)
                                scores[field] = max(scores[field], similarity)
        return scores
    except Exception:
        return {}


def _enhancement_anchor(
    normalized: Sequence[tuple[Token, str]],
) -> Optional[Token]:
    headers = [token for token, text in normalized if text == "장비강화"]
    if headers:
        return max(headers, key=lambda token: token.confidence)
    stages = [
        token for token, text in normalized
        if _enhancement_stage_value(text) is not None and token.confidence >= 0.80
    ]
    if stages:
        stage = max(stages, key=lambda token: token.confidence)
        unit = 1.30 * stage.height
        top = stage.cy - 4.0 * unit
        return Token(
            "장비강화",
            stage.confidence,
            stage.cx - 1.5 * unit,
            top,
            stage.cx + 1.5 * unit,
            top + unit,
        )
    buttons = [token for token, text in normalized if text == "강화하기"]
    if not buttons:
        return None
    button = max(buttons, key=lambda token: token.confidence)
    unit = 0.97 * button.height
    top = button.cy - 16.0 * unit
    return Token(
        "장비강화",
        button.confidence,
        button.cx - 1.5 * unit,
        top,
        button.cx + 1.5 * unit,
        top + unit,
    )


def _detected_enhancement_stage(
    normalized: Sequence[tuple[Token, str]],
) -> Optional[tuple[int, float]]:
    matches = []
    for token, text in normalized:
        value = _enhancement_stage_value(text)
        if value is not None and token.confidence >= 0.80:
            matches.append((token.confidence, value[0]))
    if not matches:
        return None
    confidence, value = max(matches)
    return value, confidence


def _enhancement_stage_from_anchor(
    image: Any,
    anchor: Token,
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> Optional[tuple[int, float]]:
    height, width = image.shape[:2]
    unit = anchor.height
    x0 = max(0, int(anchor.cx - 2.0 * unit))
    x1 = min(width, int(anchor.cx + 2.0 * unit))
    y0 = max(0, int(anchor.y1 + 2.25 * unit))
    y1 = min(height, int(anchor.y1 + 3.75 * unit))
    if x1 <= x0 or y1 <= y0:
        return None
    crop = image[y0:y1, x0:x1]
    values = []
    scores = []
    for scale in (1, 2, 4):
        text, score = line_reader(crop, scale)
        value = _enhancement_stage_value(text)
        if value is None or not 0 <= score <= 1:
            return None
        values.append(value[0])
        scores.append(score)
    if len(set(values)) != 1:
        return None
    return values[0], min(scores)


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


def _skill_name_value(text: str) -> Optional[str]:
    compact = re.sub(r"[^A-Za-z0-9가-힣]", "", compact_text(text))
    matches = {
        canonical
        for alias, canonical in SKILL_NAME_ALIASES.items()
        if compact == alias or (alias not in SKILL_EXACT_NAME_ALIASES and alias in compact)
    }
    return next(iter(matches)) if len(matches) == 1 else None


def _generic_skill_name_value(text: str) -> Optional[str]:
    """직업 catalog 없이 절기명 한 줄만 보수적으로 정규화한다."""
    compact = re.sub(r"[^A-Za-z0-9가-힣]", "", compact_text(text))
    if not 2 <= len(compact) <= 20 or not re.search(r"[가-힣]", compact):
        return None
    if compact in {"장수", "일반", "영웅", "필요포인트", "소유중인포인트"}:
        return None
    return compact


def _skill_point_value(text: str) -> Optional[int]:
    compact = compact_text(text).strip(".,·:;→>-_()[]{}※*+")
    aliases = {
        "O": "0", "o": "0", "D": "0", "d": "0", "ㅇ": "0", "ᄋ": "0",
        "〇": "0", "○": "0", "ö": "0", "Ö": "0",
        "I": "1", "i": "1", "l": "1", "|": "1", "ㅣ": "1", "ᅵ": "1",
        "Z": "2", "z": "2",
    }
    compact = aliases.get(compact, compact)
    if not re.fullmatch(r"\d{1,3}", compact):
        return None
    return int(compact)


def _skill_recrop_consensus(
    image: Any,
    bounds: tuple[float, float, float, float],
    parser: Callable[[str], Any],
    line_reader: Callable[[Any, int], tuple[str, float]],
    min_score: float = 0.30,
) -> Optional[tuple[Any, float]]:
    height, width = image.shape[:2]
    x0 = max(0, int(math.floor(bounds[0])))
    y0 = max(0, int(math.floor(bounds[1])))
    x1 = min(width, int(math.ceil(bounds[2])))
    y1 = min(height, int(math.ceil(bounds[3])))
    if x1 <= x0 or y1 <= y0:
        return None
    crop = image[y0:y1, x0:x1]
    votes: list[Any] = []
    scores: list[float] = []
    for scale in (1, 2, 4):
        text, score = line_reader(crop, scale)
        value = parser(text)
        if value is None or not min_score <= score <= 1:
            return None
        votes.append(value)
        scores.append(score)
    if len(set(votes)) != 1:
        return None
    return votes[0], min(scores)


def _skill_fallback_row(token: Token, image: Any) -> Optional[int]:
    height, width = image.shape[:2]
    if not 0.19 <= token.cy / height <= 0.61:
        return None
    row = round((token.cy / height - 0.226) / SKILL_FALLBACK_ROW_STEP)
    if not 0 <= row < len(SKILL_BUILD_ROWS):
        return None
    expected_y = 0.226 + row * SKILL_FALLBACK_ROW_STEP
    return row if abs(token.cy / height - expected_y) <= 0.028 else None


def _skill_need_hint(text: str) -> bool:
    return any(marker in text for marker in (
        "필요", "포인", "인트", "왕요", "월요", "있요", "링은",
    )) or bool(re.fullmatch(r"인[012]", text))


def _skill_fallback_title(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
) -> Optional[Token]:
    """960x540 보관 frame에서 절기창의 고정 6행 구조를 확인한다.

    값은 이 단계에서 추정하지 않는다. 정확한 제목·footer와 서로 다른 여러 행의
    이름/필요포인트 흔적을 모두 요구한 뒤 각 값은 별도 3배율 recrop으로 읽는다.
    """
    height, width = image.shape[:2]
    titles = [
        token for token, text in normalized
        if text == "절기" and token.confidence >= 0.95
        and 0.46 <= token.cx / width <= 0.54
        and 0.10 <= token.cy / height <= 0.20
    ]
    reset = any(
        text in ("초기화", "조기화") and token.confidence >= 0.80
        and 0.34 <= token.cx / width <= 0.43
        and 0.79 <= token.cy / height <= 0.90
        for token, text in normalized
    )
    owned_footer = any(
        text.startswith("소") and "포인" in text
        and 0.43 <= token.cx / width <= 0.54
        and 0.77 <= token.cy / height <= 0.90
        for token, text in normalized
    )
    if not reset or not owned_footer:
        return None

    name_rows: set[int] = set()
    need_rows: set[int] = set()
    for token, text in normalized:
        row = _skill_fallback_row(token, image)
        if row is None:
            continue
        normalized_x = token.cx / width
        if 0.35 <= normalized_x <= 0.46:
            name = _skill_name_value(text)
            if name == SKILL_BUILD_ROWS[row][0]:
                name_rows.add(row)
        if 0.47 <= normalized_x <= 0.58 and _skill_need_hint(text):
            need_rows.add(row)
    if len(name_rows) < 2 or len(need_rows) < 3 or len(name_rows | need_rows) < 5:
        return None
    if len(name_rows) + len(need_rows) < 7:
        return None
    return max(titles, key=lambda token: token.confidence) if titles else None


def _skill_scaled_bounds(
    image: Any,
    normalized_bounds: tuple[float, float, float, float],
    row: int = 0,
    row_step: float = SKILL_FALLBACK_ROW_STEP,
) -> tuple[float, float, float, float]:
    height, width = image.shape[:2]
    x0, y0, x1, y1 = normalized_bounds
    row_offset = row * row_step
    return x0 * width, (y0 + row_offset) * height, x1 * width, (y1 + row_offset) * height


def _skill_detected_owned_point(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
) -> Optional[tuple[int, float]]:
    height, width = image.shape[:2]
    candidates = []
    for token, _text in normalized:
        point = _skill_point_value(token.text)
        if point is None:
            continue
        normalized_x = token.cx / width
        normalized_y = token.cy / height
        if 0.475 <= normalized_x <= 0.515 and 0.83 <= normalized_y <= 0.88:
            candidates.append((abs(normalized_x - 0.493) + abs(normalized_y - 0.853), point, token.confidence))
    if not candidates:
        return None
    _distance, point, confidence = min(candidates)
    return point, confidence


def _skill_build_result(
    title: Token,
    skills: list[dict[str, Any]],
    owned_points: int,
    scores: Sequence[float],
) -> dict[str, Any]:
    value = json.dumps(
        {
            "version": 1,
            "preset": None,
            "ownedPoints": owned_points,
            "skills": skills,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    confidence = min(title.confidence, 0.99, max(0.95, min(scores)))
    return {"field": "skillBuild", "value": value, "confidence": confidence}


def _skill_panel_fallback(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> tuple[bool, Optional[dict[str, Any]]]:
    title = _skill_fallback_title(image, normalized)
    if title is None:
        return False, None

    skills = []
    recrop_scores: list[float] = []
    for row, (expected_name, expected_required) in enumerate(SKILL_BUILD_ROWS):
        name_match = _skill_recrop_consensus(
            image,
            _skill_scaled_bounds(image, SKILL_FALLBACK_NAME_BOUNDS, row),
            _skill_name_value,
            line_reader,
        )
        required_match = _skill_recrop_consensus(
            image,
            _skill_scaled_bounds(image, SKILL_FALLBACK_REQUIRED_BOUNDS, row),
            _skill_point_value,
            line_reader,
        )
        allocated_match = _skill_recrop_consensus(
            image,
            _skill_scaled_bounds(image, SKILL_FALLBACK_ALLOCATED_BOUNDS, row),
            _skill_point_value,
            line_reader,
        )
        if name_match is None or required_match is None or allocated_match is None:
            return True, None
        name, name_score = name_match
        required, required_score = required_match
        allocated, allocated_score = allocated_match
        if name != expected_name or required != expected_required or not 0 <= allocated <= 99:
            return True, None
        skills.append({
            "name": name,
            "requiredPoints": required,
            "allocatedPoints": allocated,
        })
        recrop_scores.extend((name_score, required_score, allocated_score))

    owned_match = _skill_detected_owned_point(image, normalized)
    if owned_match is None:
        owned_match = _skill_recrop_consensus(
            image,
            _skill_scaled_bounds(image, SKILL_FALLBACK_OWNED_BOUNDS),
            _skill_point_value,
            line_reader,
            min_score=0.20,
        )
    if owned_match is None or not 0 <= owned_match[0] <= 99:
        return True, None
    owned_points, owned_score = owned_match
    recrop_scores.append(owned_score)
    return True, _skill_build_result(title, skills, owned_points, recrop_scores)


def _skill_nine_row_title(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
) -> Optional[Token]:
    height, width = image.shape[:2]
    titles = [
        token for token, text in normalized
        if text == "절기" and token.confidence >= 0.95
        and 0.46 <= token.cx / width <= 0.54
        and 0.10 <= token.cy / height <= 0.20
    ]
    reset = any(
        text in ("초기화", "조기화") and token.confidence >= 0.80
        and 0.34 <= token.cx / width <= 0.43
        and 0.79 <= token.cy / height <= 0.90
        for token, text in normalized
    )
    owned = any(
        text.startswith("소") and "포인" in text
        and 0.43 <= token.cx / width <= 0.54
        and 0.79 <= token.cy / height <= 0.90
        for token, text in normalized
    )
    need_rows = {
        round((token.cy / height - 0.223) / SKILL_NINE_ROW_STEP)
        for token, text in normalized
        if 0.47 <= token.cx / width <= 0.58 and _skill_need_hint(text)
        and 0.19 <= token.cy / height <= 0.79
    }
    need_rows = {row for row in need_rows if 0 <= row < SKILL_NINE_ROW_COUNT}
    if not titles or not reset or not owned or len(need_rows) < 5 or max(need_rows, default=-1) < 7:
        return None
    return max(titles, key=lambda token: token.confidence)


def _skill_panel_nine_row_fallback(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> tuple[bool, Optional[dict[str, Any]]]:
    title = _skill_nine_row_title(image, normalized)
    if title is None:
        return False, None

    skills = []
    scores: list[float] = []
    names: set[str] = set()
    for row in range(SKILL_NINE_ROW_COUNT):
        name_match = _skill_recrop_consensus(
            image,
            _skill_scaled_bounds(image, SKILL_NINE_NAME_BOUNDS, row, SKILL_NINE_ROW_STEP),
            _generic_skill_name_value,
            line_reader,
        )
        required_match = _skill_recrop_consensus(
            image,
            _skill_scaled_bounds(image, SKILL_FALLBACK_REQUIRED_BOUNDS, row, SKILL_NINE_ROW_STEP),
            _skill_point_value,
            line_reader,
        )
        allocated_match = _skill_recrop_consensus(
            image,
            _skill_scaled_bounds(image, SKILL_FALLBACK_ALLOCATED_BOUNDS, row, SKILL_NINE_ROW_STEP),
            _skill_point_value,
            line_reader,
        )
        if name_match is None or required_match is None or allocated_match is None:
            return True, None
        name, name_score = name_match
        required, required_score = required_match
        allocated, allocated_score = allocated_match
        if name in names or not 0 <= required <= 99 or not 0 <= allocated <= 99:
            return True, None
        names.add(name)
        skills.append({
            "name": name,
            "requiredPoints": required,
            "allocatedPoints": allocated,
        })
        scores.extend((name_score, required_score, allocated_score))

    owned_match = _skill_detected_owned_point(image, normalized)
    if owned_match is None or not 0 <= owned_match[0] <= 99:
        return True, None
    owned_points, owned_score = owned_match
    scores.append(owned_score)
    return True, _skill_build_result(title, skills, owned_points, scores)


def _skill_panel_structure(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
) -> Optional[tuple[Token, list[tuple[Token, Token]], Token]]:
    height, width = image.shape[:2]
    titles = [
        token for token, text in normalized
        if text == "절기" and token.confidence >= 0.95
        and 0.35 <= token.cx / width <= 0.65
        and token.cy / height <= 0.25
    ]
    for title in sorted(titles, key=lambda token: token.confidence, reverse=True):
        generals = sorted(
            (
                token for token, text in normalized
                if text == "장수" and token.confidence >= 0.90
                and 0.30 <= token.cx / width <= 0.48
                and title.cy < token.cy < 0.68 * height
            ),
            key=lambda token: token.cy,
        )
        for start in range(max(0, len(generals) - 5)):
            row_tokens = generals[start:start + len(SKILL_BUILD_ROWS)]
            if len(row_tokens) != len(SKILL_BUILD_ROWS):
                continue
            row_heights = sorted(token.height for token in row_tokens)
            row_height = row_heights[len(row_heights) // 2]
            deltas = [
                row_tokens[index + 1].cy - row_tokens[index].cy
                for index in range(len(row_tokens) - 1)
            ]
            step = sorted(deltas)[len(deltas) // 2]
            if not 2.2 * row_height <= step <= 6.0 * row_height:
                continue
            if any(abs(delta - step) > max(4.0, 0.18 * step) for delta in deltas):
                continue
            if max(token.cx for token in row_tokens) - min(token.cx for token in row_tokens) > 1.5 * row_height:
                continue
            if not 0.55 * step <= row_tokens[0].cy - title.cy <= 1.55 * step:
                continue

            needed = [
                token for token, text in normalized
                if text.startswith("필요포인트") and token.confidence >= 0.85
                and row_tokens[0].cy - 0.5 * step <= token.cy <= row_tokens[-1].cy + 0.5 * step
                and token.cx > row_tokens[0].cx + 2.0 * row_height
                and token.cx - row_tokens[0].cx < 0.25 * width
            ]
            matches: list[tuple[Token, Token]] = []
            unused = set(range(len(needed)))
            for general in row_tokens:
                candidates = sorted(
                    (
                        (abs(needed[index].cy - general.cy), index)
                        for index in unused
                        if abs(needed[index].cy - general.cy) <= 0.40 * step
                    ),
                )
                if not candidates:
                    matches = []
                    break
                _, index = candidates[0]
                unused.remove(index)
                matches.append((general, needed[index]))
            if len(matches) != len(SKILL_BUILD_ROWS):
                continue
            need_heights = sorted(need.height for _general, need in matches)
            need_height = need_heights[len(need_heights) // 2]
            if max(need.cx for _general, need in matches) - min(
                need.cx for _general, need in matches
            ) > 2.0 * need_height:
                continue

            owned = [
                token for token, text in normalized
                if text == "소유중인포인트" and token.confidence >= 0.90
                and 0.40 <= token.cx / width <= 0.60
                and token.cy >= row_tokens[-1].cy + 2.0 * step
                and token.cy <= 0.95 * height
            ]
            if owned:
                return title, matches, max(owned, key=lambda token: token.confidence)
    return None


def _skill_panel(
    image: Any,
    normalized: Sequence[tuple[Token, str]],
    line_reader: Callable[[Any, int], tuple[str, float]],
) -> tuple[bool, Optional[dict[str, Any]]]:
    structure = _skill_panel_structure(image, normalized)
    if structure is None:
        return False, None
    title, rows, owned_label = structure
    skills = []
    recrop_scores: list[float] = []
    for (expected_name, expected_required), (general, needed) in zip(SKILL_BUILD_ROWS, rows):
        general_unit = general.height
        name_match = _skill_recrop_consensus(
            image,
            (
                general.x0 - 0.15 * general_unit,
                general.y1 - 0.15 * general_unit,
                general.x0 + 3.70 * general_unit,
                general.y1 + 1.50 * general_unit,
            ),
            _skill_name_value,
            line_reader,
        )
        if name_match is None:
            return True, None
        needed_unit = needed.height
        required_match = _skill_recrop_consensus(
            image,
            (
                needed.x0 + 3.55 * needed_unit,
                needed.y0 - 0.25 * needed_unit,
                needed.x0 + 5.35 * needed_unit,
                needed.y1 + 0.25 * needed_unit,
            ),
            _skill_point_value,
            line_reader,
        )
        if required_match is None:
            return True, None
        allocated_match = _skill_recrop_consensus(
            image,
            (
                needed.x0 + 8.65 * needed_unit,
                needed.y0 - 0.25 * needed_unit,
                needed.x0 + 10.45 * needed_unit,
                needed.y1 + 0.25 * needed_unit,
            ),
            _skill_point_value,
            line_reader,
        )
        if allocated_match is None:
            return True, None
        name, name_score = name_match
        required, required_score = required_match
        allocated, allocated_score = allocated_match
        if name != expected_name or required != expected_required:
            return True, None
        skills.append({
            "name": name,
            "requiredPoints": required,
            "allocatedPoints": allocated,
        })
        recrop_scores.extend((name_score, required_score, allocated_score))

    owned_unit = owned_label.height
    owned_match = _skill_recrop_consensus(
        image,
        (
            owned_label.cx - 0.75 * owned_unit,
            owned_label.y1 + 0.10 * owned_unit,
            owned_label.cx + 0.75 * owned_unit,
            owned_label.y1 + 1.50 * owned_unit,
        ),
        _skill_point_value,
        line_reader,
    )
    if owned_match is None:
        return True, None
    owned_points, owned_score = owned_match
    recrop_scores.append(owned_score)
    return True, _skill_build_result(title, skills, owned_points, recrop_scores)


def parse_panel(
    image: Any,
    tokens: Sequence[Token],
    line_reader: Callable[[Any, int], tuple[str, float]],
    profile: str = DEFAULT_PROFILE,
) -> tuple[bool, list[dict[str, Any]]]:
    normalized = [(token, compact_text(token.text)) for token in tokens if token.confidence >= 0.30]
    skill_panel = False
    skill_result = None
    if profile == HUD_COMBAT_PROFILE:
        skill_panel, skill_result = _skill_panel_nine_row_fallback(image, normalized, line_reader)
        if not skill_panel:
            skill_panel, skill_result = _skill_panel(image, normalized, line_reader)
        if not skill_panel:
            skill_panel, skill_result = _skill_panel_fallback(image, normalized, line_reader)
    info_panel, info_results = _information_panel(image, normalized, line_reader)
    stat_labels = [(token, STAT_FIELDS[text]) for token, text in normalized if text in STAT_FIELDS]
    quantity_titles = [token for token, text in normalized if text == "기량"]
    stat_panel = bool(quantity_titles) and len({field for _, field in stat_labels}) >= 3

    results: list[dict[str, Any]] = list(info_results)
    if skill_result is not None:
        results.append(skill_result)
    if stat_panel:
        for label, field in stat_labels:
            match = _neighbor_parsed_value(label, tokens, _quantity_value, max_below_factor=1.8)
            if match is not None and field not in {item["field"] for item in results}:
                (value, bonus), confidence = match
                results.append({"field": field, "value": value, "confidence": confidence})
                bonus_field = STAT_BONUS_FIELDS[field]
                if bonus is not None and bonus_field not in {item["field"] for item in results}:
                    results.append({"field": bonus_field, "value": bonus, "confidence": confidence})
        # title + exact label/value 구조는 panel 판별에만 사용한다.
        # 숫자 confidence는 잘못 읽은 값도 반복될 수 있어 절대 상향하지 않는다.

        derived_labels = [
            (label, QUANTITY_DERIVED_FIELDS[text])
            for label, text in normalized if text in QUANTITY_DERIVED_FIELDS
        ]
        full_derived_structure = len({field for _label, field in derived_labels}) == 4
        for label, field in derived_labels:
            match = _neighbor_parsed_value(label, tokens, _decimal_value)
            if match is None or field in {item["field"] for item in results}:
                continue
            value, confidence = match
            if full_derived_structure and confidence >= 0.85:
                # 네 사분면의 exact label/value 구조는 작은 글자 raw score와 독립된
                # 위치 근거다. 상향은 자동쓰기 최소치 부근(0.96)으로만 제한한다.
                confidence = max(confidence, min(0.96, max(title.confidence for title in quantity_titles)))
            results.append({"field": field, "value": value, "confidence": confidence})

    for title, text in normalized:
        combined = COMBINED_GEAR_TITLE_RE.fullmatch(text)
        if combined:
            field = GEAR_FIELDS[combined.group(1)]
            value = int(combined.group(2))
            if 0 <= value <= 15 and field not in {item["field"] for item in results}:
                results.append({"field": field, "value": value, "confidence": title.confidence})

        item_title = ITEM_ENHANCEMENT_TITLE_RE.fullmatch(text)
        if item_title:
            field = KNOWN_GEAR_ITEM_NAMES.get(item_title.group(1))
            value = int(item_title.group(2))
            stage = _detected_enhancement_stage(normalized)
            if (
                field is not None and 0 <= value <= 15
                and stage is not None and stage[0] == value
                and field not in {item["field"] for item in results}
            ):
                results.append({
                    "field": field,
                    "value": value,
                    "confidence": min(title.confidence, stage[1]),
                })

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
    anchor = _enhancement_anchor(normalized)
    stage_match = _detected_enhancement_stage(normalized)
    if stage_match is None and anchor is not None:
        stage_match = _enhancement_stage_from_anchor(image, anchor, line_reader)
    has_button = any(text == "강화하기" for _token, text in normalized)
    structured_enhancement_panel = bool(
        anchor is not None and stage_match is not None and has_button
        and (marker_count >= 2 or has_stage)
    )
    enhancement_panel = (
        marker_count >= 3 and (has_stage or marker_count >= 4)
    ) or structured_enhancement_panel
    if enhancement_panel and anchor is not None and stage_match is not None:
        similarities = _gear_icon_similarities(image, anchor)
        ranked = sorted(similarities.items(), key=lambda item: item[1], reverse=True)
        if ranked:
            field, icon_similarity = ranked[0]
            runner_up = ranked[1][1] if len(ranked) > 1 else -1.0
            if (
                icon_similarity >= 0.90 and icon_similarity - runner_up >= 0.08
                and field not in {item["field"] for item in results}
            ):
                current_stage, _stage_confidence = stage_match
                structural_confidence = 0.96 + 0.03 * min(
                    1.0, (icon_similarity - 0.90) / 0.10,
                )
                results.append({
                    "field": field,
                    "value": current_stage,
                    "confidence": structural_confidence,
                })
    panel_visible = (
        skill_panel or info_panel or stat_panel or enhancement_panel
        or horse_panel or hud_visible or bool(results)
    )
    order = {name: index for index, name in enumerate(
        (
            "skillBuild", "maxHealth", "healthStat", "activeGeneral", "attackPower", "defense",
            "attackPowerBonusPct", "damageReductionPct", "criticalChancePct",
            "criticalDamagePct", "skillCooldownReductionPct", "skillDamageBonusPct",
            "moveSpeedBonusPct", "horseMaxHealth", "horse", "horseLevel",
            "weapon", "helmet", "armor", "shoes",
            "strength", "agility", "vitality", "intelligence",
            "strengthBonus", "agilityBonus", "vitalityBonus", "intelligenceBonus",
            "attackPowerIncrease", "moveSpeedIncrease", "healthIncrease", "skillHasteIncrease",
        )
    )}
    results.sort(key=lambda item: order.get(item["field"], len(order)))
    return panel_visible, results


def make_batch(profile: str, panel_visible: bool, results: Iterable[dict[str, Any]]) -> dict[str, Any]:
    return {
        "version": VERSION,
        "profileId": profile,
        "seasonId": CURRENT_SEASON_ID,
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
