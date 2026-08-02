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

    def test_gear_enhancement_above_sheet_contract_is_not_emitted(self):
        for title in ("+16", "최강흉갑(+16)"):
            with self.subTest(title=title):
                tokens = [token("무기", .99, 420, 220, 448, 238)] if title == "+16" else [
                    token("흉갑 (+16)", .99, 420, 160, 540, 188),
                ]
                visible, results = adapter.parse_panel(
                    self.image,
                    tokens,
                    lambda _crop, _scale: (title, .99),
                )
                self.assertFalse(visible)
                self.assertEqual(results, [])

    def test_item_strength_and_unknown_enhancement_kind_are_not_emitted(self):
        visible, results = adapter.parse_panel(
            self.image,
            [token("정보", 1, 400, 60, 450, 80), token("힘", .99, 420, 350, 440, 370), token("10", 1, 550, 350, 570, 370)],
            lambda _crop, _scale: ("+10", 1),
        )
        self.assertFalse(visible)
        self.assertEqual(results, [])

    def test_information_panel_extracts_aligned_rows_despite_broken_small_labels(self):
        image = np.zeros((720, 960, 3), dtype=np.uint8)

        def row(text, score, row_index, x0=800, x1=880):
            # 첫 소속→체력 간격(40px)보다 본문 행 간격(42px)이 조금 넓다.
            cy = 120 + row_index * 42
            return token(text, score, x0, cy - 9, x1, cy + 9)

        def label(text, score, row_index, x1):
            cy = 120 + row_index * 42
            return token(text, score, 500, cy - 9, x1, cy + 9)

        tokens = [
            token("소속", .99, 500, 71, 540, 89),
            token("체력", .98, 500, 111, 540, 129),
            row("176.9", .999, 0, 825),
            label("현재 영군", .97, 1, 575),
            row("영객 (하후돈)", .94, 1, 760),
            label("뉴운", .48, 3, 540),
            row("55.3", .999, 3, 840),
            label("뉴어", .34, 4, 540),
            row("4", 1, 4, 865),
            label("공격력 증가량", .97, 5, 640),
            row("+5%", .99, 5, 842),
            label("받는 피해 감소", .98, 6, 640),
            row("0%", .99, 6, 855),
            label("치명타 확률", .98, 7, 620),
            row("15%", .99, 7, 845),
            label("치명타 데미지", .98, 8, 640),
            row("120%", .99, 8, 835),
            label("절기 대기시간 감소", .97, 9, 680),
            row("8%", .99, 9, 855),
            label("절기 피해량 증가량", .97, 10, 680),
            row("0%", .99, 10, 855),
            label("이동속도 증가량", .97, 11, 650),
            row("0%", .99, 11, 855),
            # 아래 tooltip의 개별 장비 수치는 총스탯 열에 섞이면 안 된다.
            token("체력", .999, 500, 631, 540, 649),
            token("153.9", .999, 825, 631, 880, 649),
            token("방어력", .999, 500, 671, 560, 689),
            token("7", .999, 865, 671, 880, 689),
        ]
        recrop_scores = {1: .989, 2: .987, 4: .985}
        visible, results = adapter.parse_panel(
            image,
            tokens,
            lambda _crop, scale: ("(하후돈)", recrop_scores[scale]),
        )
        self.assertTrue(visible)
        self.assertEqual({item["field"]: item["value"] for item in results}, {
            "healthStat": 176.9,
            "activeGeneral": "하후돈",
            "attackPower": 55.3,
            "defense": 4,
            "attackPowerBonusPct": 5,
            "damageReductionPct": 0,
            "criticalChancePct": 15,
            "criticalDamagePct": 120,
            "skillCooldownReductionPct": 8,
            "skillDamageBonusPct": 0,
            "moveSpeedBonusPct": 0,
        })
        active_general = next(item for item in results if item["field"] == "activeGeneral")
        self.assertEqual(active_general["confidence"], .98)

    def test_legacy_information_panel_allows_missing_general_and_rejects_tooltip_attack(self):
        image = np.zeros((1520, 1032, 3), dtype=np.uint8)
        tokens = [
            token("소속", .99955, 590, 166, 649, 204),
            token("촉나라", .90427, 868, 165, 951, 205),
            # 중심 간격 40px, bbox 높이 42px로 두 라벨 bbox가 살짝 겹친다.
            token("체력", .95480, 588, 204, 651, 246),
            token("120", .99934, 895, 207, 950, 244),
            token("()", .73822, 794, 246, 949, 287),
            token("공격력", .99382, 590, 327, 672, 366),
            token("10.1", .99111, 891, 328, 951, 365),
            token("o", .67853, 589, 367, 672, 406),
            token("0", .84919, 923, 371, 948, 403),
            token("원을하는운", .36373, 591, 412, 748, 449),
            token("0%", .95046, 897, 411, 949, 449),
            token("받는 피해 감소", .94883, 591, 452, 753, 489),
            token("0%", .93096, 897, 450, 949, 489),
            token("32", .62991, 591, 492, 747, 528),
            token("15%", .99803, 888, 492, 949, 529),
            token("Ixlolale", .71599, 592, 533, 771, 567),
            token("120%", .99917, 872, 532, 948, 568),
            token("무B", .47894, 591, 573, 746, 610),
            token("0%", .95448, 899, 573, 948, 610),
            token("이동속도 증가율", .99704, 590, 613, 770, 649),
            token("0%", .97908, 899, 614, 948, 649),
            token("0%", .95723, 899, 657, 948, 694),
            # 하단 장비 tooltip의 공격력은 총공격력 행과 멀리 떨어져 있다.
            token("공격력", .999, 225, 1130, 315, 1168),
            token("10", .999, 735, 1130, 780, 1168),
        ]
        visible, results = adapter.parse_panel(image, tokens, lambda _crop, _scale: ("", 0))
        self.assertTrue(visible)
        self.assertEqual({item["field"]: item["value"] for item in results}, {
            "healthStat": 120,
            "attackPower": 10.1,
            "defense": 0,
            "attackPowerBonusPct": 0,
            "damageReductionPct": 0,
            "criticalChancePct": 15,
            "criticalDamagePct": 120,
            "skillCooldownReductionPct": 0,
            "skillDamageBonusPct": 0,
            "moveSpeedBonusPct": 0,
        })
        self.assertNotIn("activeGeneral", {item["field"] for item in results})

    def test_tooltip_only_does_not_impersonate_information_panel(self):
        tokens = [
            token("체력", .99, 500, 200, 540, 220), token("153.9", .99, 800, 200, 870, 220),
            token("방어력", .99, 500, 240, 560, 260), token("7", .99, 850, 240, 870, 260),
            token("치명타 피해 감소 +2.3%", .99, 500, 280, 730, 300),
        ]
        visible, results = adapter.parse_panel(self.image, tokens, lambda _crop, _scale: ("", 0))
        self.assertFalse(visible)
        self.assertEqual(results, [])

    def test_active_general_prefers_parenthesized_name_and_keeps_plain_name(self):
        self.assertEqual(adapter._active_general_value("영객 (하후돈)"), "하후돈")
        self.assertEqual(adapter._active_general_value("관우"), "관우")

        detected = token("영객 (하후돈)", .936, 600, 200, 800, 240)
        scores = {1: .97, 2: .96, 4: .98}
        value, confidence = adapter._active_general_consensus(
            self.image,
            detected,
            "하후돈",
            lambda _crop, scale: ("(하후돈)", scores[scale]),
        )
        self.assertEqual((value, confidence), ("하후돈", .96))

        value, confidence = adapter._active_general_consensus(
            self.image,
            detected,
            "하후돈",
            lambda _crop, scale: (("(관우)" if scale == 4 else "(하후돈)"), .99),
        )
        self.assertEqual((value, confidence), ("하후돈", .936))

    def test_combined_armor_title_emits_enhancement_without_recrop(self):
        visible, results = adapter.parse_panel(
            self.image,
            [token("흉갑 (+4)", .997, 420, 160, 520, 188), token("방어구", .99, 420, 205, 480, 225)],
            lambda _crop, _scale: ("", 0),
        )
        self.assertTrue(visible)
        self.assertEqual(results, [{"field": "armor", "value": 4, "confidence": .997}])

        visible, results = adapter.parse_panel(
            self.image,
            [token("최강 흉갑(+4)", .997, 420, 160, 560, 188)],
            lambda _crop, _scale: ("", 0),
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

    def test_horse_stage_above_sheet_contract_keeps_panel_without_value(self):
        tokens = [
            token("군마영", .99, 330, 36, 395, 69),
            token("장착", .98, 186, 90, 231, 120),
            token("강화", .97, 341, 90, 387, 120),
            token("합성", .98, 498, 90, 543, 120),
            token("적토마 81단계", .99, 401, 255, 510, 279),
            token("강화하기", .99, 325, 687, 405, 721),
        ]
        visible, results = adapter.parse_panel(self.image, tokens, lambda _crop, _scale: ("", 0))
        self.assertTrue(visible)
        self.assertEqual(results, [])

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
        self.assertEqual(results, [
            {"field": "maxHealth", "value": 1239, "confidence": .992},
            {"field": "horseMaxHealth", "value": 950, "confidence": .997},
        ])

    def test_horse_health_recrop_requires_exact_multiscale_ratio_consensus(self):
        horse = token("(860/950HP)", .94378, 810, 500, 910, 518)
        scores = {1: .95489, 2: .96609, 4: .96139}
        visible, results = adapter.parse_panel(
            self.image,
            [horse],
            lambda _crop, scale: ("(880/950HP)", scores[scale]),
            profile=adapter.HUD_COMBAT_PROFILE,
        )
        self.assertTrue(visible)
        self.assertEqual(results, [
            {"field": "horseMaxHealth", "value": 950, "confidence": .95489},
        ])

        for recrop in (
            lambda scale: "(880/951HP)" if scale == 4 else "(880/950HP)",
            lambda _scale: "(1800/1900HP)",
        ):
            with self.subTest(recrop=recrop(4)):
                _visible, fallback_results = adapter.parse_panel(
                    self.image,
                    [horse],
                    lambda _crop, scale: (recrop(scale), .999),
                    profile=adapter.HUD_COMBAT_PROFILE,
                )
                self.assertEqual(fallback_results, [
                    {"field": "horseMaxHealth", "value": 950, "confidence": .94378},
                ])

    def test_exact_red_hare_max_health_mapping_does_not_interpolate(self):
        cases = ((1700, 0), (1900, 1), (1800, None))
        for maximum, expected_level in cases:
            with self.subTest(maximum=maximum):
                tokens = [token(f"({maximum - 100}/{maximum}HP)", .987, 810, 500, 910, 518)]
                visible, results = adapter.parse_panel(
                    self.image,
                    tokens,
                    lambda _crop, _scale: ("", 0),
                    profile=adapter.HUD_COMBAT_PROFILE,
                )
                self.assertTrue(visible)
                values = {item["field"]: item["value"] for item in results}
                self.assertEqual(values["horseMaxHealth"], maximum)
                if expected_level is None:
                    self.assertNotIn("horse", values)
                    self.assertNotIn("horseLevel", values)
                else:
                    self.assertEqual(values["horse"], "적토마")
                    self.assertEqual(values["horseLevel"], expected_level)

    def test_default_profile_ignores_hud_and_invalid_ratios(self):
        tokens = [
            token("1167/1239", .99, 370, 500, 430, 516),
            token("1500/1239", .99, 370, 475, 430, 491),
            token("860/950", .99, 820, 500, 900, 516),
            token("(1,700/1,700HP)", .99, 800, 500, 910, 516),
        ]
        visible, results = adapter.parse_panel(
            self.image, tokens, lambda _crop, _scale: ("", 0),
        )
        self.assertFalse(visible)
        self.assertEqual(results, [])

        visible, results = adapter.parse_panel(
            self.image,
            tokens[1:3],
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
