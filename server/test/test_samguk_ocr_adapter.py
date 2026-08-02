import importlib.util
import struct
from pathlib import Path
import subprocess
import sys
import unittest
import zlib

import numpy as np


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "samguk_ocr_adapter.py"
SPEC = importlib.util.spec_from_file_location("samguk_ocr_adapter", MODULE_PATH)
adapter = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = adapter
SPEC.loader.exec_module(adapter)


def token(text, score, x0, y0, x1, y1):
    return adapter.Token(text, score, x0, y0, x1, y1)


def png_chunk(kind, payload):
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def minimal_png(width=1, height=1):
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    scanline = b"\x00" + b"\x00\x00\x00" * width
    return adapter.PNG_SIGNATURE + png_chunk(b"IHDR", header) + png_chunk(b"IDAT", zlib.compress(scanline * height)) + png_chunk(b"IEND", b"")


class AdapterParserTest(unittest.TestCase):
    def setUp(self):
        self.image = np.zeros((540, 960, 3), dtype=np.uint8)

    def test_quantity_panel_uses_base_values_not_parenthesized_adjustments(self):
        tokens = [
            token("기량", 1, 440, 50, 490, 72),
            token("무력", .89, 300, 170, 330, 190), token("40 (+18)", .99, 295, 195, 345, 215),
            token("기민", .99, 600, 170, 630, 190), token("85 (-21.2)", .90, 590, 195, 650, 215),
            token("기력", .98, 300, 290, 330, 310), token("100 (+35)", .99, 290, 315, 350, 335),
            token("지모", .98, 600, 290, 630, 310), token("65 (-6.5)", .99, 590, 315, 650, 335),
        ]
        visible, results = adapter.parse_panel(self.image, tokens, lambda _crop, _scale: ("", 0))
        self.assertTrue(visible)
        self.assertEqual({item["field"]: item["value"] for item in results}, {
            "strength": 40, "agility": 85, "vitality": 100, "intelligence": 65,
        })
        self.assertEqual(next(item for item in results if item["field"] == "strength")["confidence"], .89)

    def test_quantity_confidence_floor_requires_all_four_pairs(self):
        tokens = [
            token("기량", 1, 440, 50, 490, 72),
            token("무력", .70, 300, 170, 330, 190), token("40", .80, 295, 195, 345, 215),
            token("기민", .71, 600, 170, 630, 190), token("85", .81, 590, 195, 650, 215),
            token("기력", .72, 300, 290, 330, 310), token("100", .82, 290, 315, 350, 335),
        ]
        visible, results = adapter.parse_panel(self.image, tokens, lambda _crop, _scale: ("", 0))
        self.assertTrue(visible)
        self.assertEqual([item["confidence"] for item in results], [.70, .71, .72])

    def test_movable_weapon_tooltip_uses_category_and_three_scale_title_consensus(self):
        calls = []
        def reader(crop, scale):
            calls.append((crop.shape, scale))
            return {1: ("자웅일대검(+5)", .70), 2: ("자웅일대검+5", .73), 4: ("자웅일대검 (+5)", .77)}[scale]
        visible, results = adapter.parse_panel(
            self.image,
            [token("무기", .992, 420, 220, 448, 238), token("힘", .99, 420, 350, 440, 370), token("10", 1, 550, 350, 570, 370)],
            reader,
        )
        self.assertTrue(visible)
        self.assertEqual(results, [{"field": "weapon", "value": 5, "confidence": .70}])
        self.assertEqual([scale for _, scale in calls], [1, 2, 4])

    def test_three_scale_consensus_allows_only_terminal_parenthesis_plus_stroke_miss(self):
        visible, results = adapter.parse_panel(
            self.image,
            [token("무기", .99, 420, 220, 448, 238)],
            lambda _crop, _scale: ("자웅일대검(5)", .56),
        )
        self.assertTrue(visible)
        self.assertEqual(results, [{"field": "weapon", "value": 5, "confidence": .56}])

    def test_three_scale_disagreement_does_not_receive_structural_confidence(self):
        visible, results = adapter.parse_panel(
            self.image,
            [token("무기", .99, 420, 220, 448, 238)],
            lambda _crop, scale: ({1: "+5", 2: "+6", 4: "+7"}[scale], .99),
        )
        self.assertTrue(visible)
        self.assertEqual(results, [{"field": "weapon", "value": 5, "confidence": .94}])

    def test_item_strength_and_unknown_enhancement_kind_are_not_emitted(self):
        visible, results = adapter.parse_panel(
            self.image,
            [token("정보", 1, 400, 60, 450, 80), token("힘", .99, 420, 350, 440, 370), token("10", 1, 550, 350, 570, 370)],
            lambda _crop, _scale: ("+10", 1),
        )
        self.assertFalse(visible)
        self.assertEqual(results, [])

    def test_enhancement_screen_without_item_kind_is_visible_but_empty(self):
        tokens = [
            token("장비 강화", 1, 400, 40, 480, 60), token("0단계 → 1단계", .94, 420, 100, 520, 120),
            token("강화 성공 확률", .98, 390, 200, 480, 220), token("단계 하락 확률", .95, 520, 200, 610, 220),
            token("강화 비용", .99, 520, 300, 580, 320), token("10,000", 1, 520, 325, 580, 345),
        ]
        visible, results = adapter.parse_panel(self.image, tokens, lambda _crop, _scale: ("", 0))
        self.assertTrue(visible)
        self.assertEqual(results, [])

        without_stage = [item for item in tokens if "단계 →" not in item.text]
        visible, results = adapter.parse_panel(self.image, without_stage, lambda _crop, _scale: ("", 0))
        self.assertTrue(visible)
        self.assertEqual(results, [])

    def test_horse_stable_panel_emits_current_stage_not_target_stage(self):
        tokens = [
            token("군마영", .99, 330, 36, 395, 69),
            token("장착", .98, 186, 90, 231, 120),
            token("강화", .97, 341, 90, 387, 120),
            token("합성", .98, 498, 90, 543, 120),
            token("금표마 5단계", .96, 401, 255, 495, 279),
            token("0단계 → 1단계", .99, 400, 300, 520, 325),
            token("강화하기", .99, 325, 687, 405, 721),
        ]
        visible, results = adapter.parse_panel(self.image, tokens, lambda _crop, _scale: ("", 0))
        self.assertTrue(visible)
        self.assertEqual(results, [{"field": "horseLevel", "value": 5, "confidence": .96}])

    def test_horse_header_alone_is_not_a_panel(self):
        visible, results = adapter.parse_panel(
            self.image,
            [token("군마영", .99, 100, 100, 160, 120), token("5단계", .99, 200, 200, 260, 220)],
            lambda _crop, _scale: ("", 0),
        )
        self.assertFalse(visible)
        self.assertEqual(results, [])

    def test_hud_profile_extracts_player_max_health_from_bottom_center_ratio(self):
        tokens = [
            token("1167/1239", .992, 370, 500, 430, 516),
            token("(860/950HP)", .997, 820, 500, 900, 516),
        ]
        visible, results = adapter.parse_panel(
            self.image,
            tokens,
            lambda _crop, _scale: ("", 0),
            profile=adapter.HUD_COMBAT_PROFILE,
        )
        self.assertTrue(visible)
        self.assertEqual(results, [{"field": "maxHealth", "value": 1239, "confidence": .992}])

    def test_default_profile_ignores_hud_and_invalid_ratios(self):
        tokens = [
            token("1167/1239", .99, 370, 500, 430, 516),
            token("1500/1239", .99, 370, 475, 430, 491),
            token("860/950", .99, 820, 500, 900, 516),
        ]
        visible, results = adapter.parse_panel(
            self.image, tokens, lambda _crop, _scale: ("", 0),
        )
        self.assertFalse(visible)
        self.assertEqual(results, [])

        visible, results = adapter.parse_panel(
            self.image,
            tokens[1:],
            lambda _crop, _scale: ("", 0),
            profile=adapter.HUD_COMBAT_PROFILE,
        )
        self.assertFalse(visible)
        self.assertEqual(results, [])

    def test_hard_negative_words_do_not_match_fields(self):
        tokens = [token("군마영", .99, 100, 100, 160, 120), token("강화 확률 10배 주문서", .99, 200, 200, 400, 220)]
        visible, results = adapter.parse_panel(self.image, tokens, lambda _crop, _scale: ("+10", 1))
        self.assertFalse(visible)
        self.assertEqual(results, [])

    def test_new_and_legacy_outputs_are_normalized_without_extra_fields(self):
        class NewOutput:
            boxes = [[(1, 2), (3, 2), (3, 4), (1, 4)]]
            txts = ["무력"]
            scores = [.9]
        new = adapter.normalize_engine_output(NewOutput())
        legacy = adapter.normalize_engine_output(([[[(1, 2), (3, 2), (3, 4), (1, 4)], "무력", .9]], .01))
        self.assertEqual(new, legacy)

    def test_batch_has_exact_v2_keys(self):
        batch = adapter.make_batch("stats-panel-v1", False, [])
        self.assertEqual(batch, {"version": 2, "profileId": "stats-panel-v1", "panelVisible": False, "results": []})

    def test_png_validator_rejects_crc_trailing_iend_and_dimension_cap(self):
        valid = minimal_png()
        self.assertEqual(adapter.validate_png(valid), (1, 1))
        corrupt = bytearray(valid)
        corrupt[-5] ^= 1
        for value in (bytes(corrupt), valid + b"secret-trailer", minimal_png(4097, 1)):
            with self.assertRaisesRegex(adapter.AdapterError, "invalid_png"):
                adapter.validate_png(value)

    def test_invalid_stdin_has_empty_stdout_and_fixed_stderr(self):
        result = subprocess.run(
            [sys.executable, str(MODULE_PATH)], input=b"raw-secret-not-png", capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"samguk_ocr_adapter:invalid_png\n")


if __name__ == "__main__":
    unittest.main()
