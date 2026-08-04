"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inflateRawSync } = require("node:zlib");
const {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  FRAME_BYTES,
  SamgukUiGateError,
  analyzeGrayFrame,
  createGrayFrameParser,
  createSamgukUiGate,
} = require("../lib/samguk-ui-gate");

function solid(value) {
  return Buffer.alloc(FRAME_BYTES, value);
}

function fillRect(frame, x, y, width, height, value) {
  for (let row = y; row < y + height; row += 1) {
    frame.fill(value, row * FRAME_WIDTH + x, row * FRAME_WIDTH + x + width);
  }
}

function titleFrame({ x = 5, y = 4, width = 20, height = 5 } = {}) {
  const frame = solid(120);
  fillRect(frame, x, y, width, height, 35);
  return frame;
}

function panelFrame({ x = 17, y = 4, width = 13, height = 12, background = 70 } = {}) {
  const frame = solid(background);
  fillRect(frame, x, y, width, height, 30);
  // 실제 inventory/tooltip처럼 어두운 패널 안에 희소한 글자·아이콘 edge를 만든다.
  for (let row = y + 1; row < y + height - 1; row += 2) {
    for (let column = x + 2; column < x + width - 1; column += 3) {
      frame[row * FRAME_WIDTH + column] = 90;
    }
  }
  return frame;
}

function deathOverlayFrame() {
  const frame = solid(28);
  for (let x = 18; x < 30; x += 2) frame[12 * FRAME_WIDTH + x] = 88;
  for (let y = 15; y < FRAME_HEIGHT; y += 1) {
    const start = 37 - Math.floor((y - 15) / 2);
    for (let x = start; x < FRAME_WIDTH; x += 1) frame[y * FRAME_WIDTH + x] = 115;
  }
  return frame;
}

function loadingFrame() {
  const frame = solid(30);
  for (let y = 3; y < 24; y += 1) {
    const center = 24 + Math.floor(5 * Math.sin(y));
    for (let x = center - 2; x <= center + 2; x += 1) frame[y * FRAME_WIDTH + x] = 105;
  }
  return frame;
}

function loadingSplashFrame() {
  const frame = solid(25);
  fillRect(frame, 7, 8, 28, 12, 30);
  for (let y = 8; y < 20; y += 1) {
    frame[y * FRAME_WIDTH + 6] = 70;
    frame[y * FRAME_WIDTH + 35] = 70;
  }
  for (let y = 9; y < 19; y += 2) {
    for (let x = 9; x < 33; x += 3) frame[y * FRAME_WIDTH + x] = 90;
  }
  for (let y = 16; y < FRAME_HEIGHT; y += 1) {
    const start = 42 - Math.floor((y - 16) / 2);
    for (let x = start; x < FRAME_WIDTH; x += 1) frame[y * FRAME_WIDTH + x] = 210;
  }
  return frame;
}

function gameplayObjectFrame() {
  const frame = Buffer.alloc(FRAME_BYTES);
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      frame[y * FRAME_WIDTH + x] = 75 + ((x * 17 + y * 29) % 70);
    }
  }
  for (let y = 5; y < 22; y += 1) {
    const left = 15 + (y % 4);
    const right = 31 - ((y * 3) % 5);
    fillRect(frame, left, y, right - left, 1, 32);
  }
  return frame;
}

function grayFixture(base64) {
  const frame = Buffer.from(base64.replace(/\s+/g, ""), "base64");
  assert.equal(frame.byteLength, FRAME_BYTES);
  return frame;
}

function compressedGrayFixture(base64) {
  const frame = inflateRawSync(Buffer.from(base64.replace(/\s+/g, ""), "base64"));
  assert.equal(frame.byteLength, FRAME_BYTES);
  return frame;
}

// 실제 캡처를 production과 같은 ffmpeg fast_bilinear + gray 변환으로 48x27 축소했다.
// fixture를 내장해 테스트 실행 시 Downloads나 원본 PNG에 의존하지 않는다.
const DARK_OVERLAY_FIXTURES = Object.freeze([
  Object.freeze({
    name: "정보/장비 상세 화면",
    frame: grayFixture(`
ICIdERERERAREhISExMUFBUVFRYXFxgYFxYWFRUUFBQUEhIREBEQEBAQIhcVExMTMC4bFBQUFBYXGBobHB4gISQlJygtLi8u
LSkmJCQhIB4dGxkXFhQTExMRLB8cGhwcIzInFhgXFhYVFhcaGBcXGBYXFhcWFxYWFRQUFRQUFRUVFRUVFBQUFBQUIxweGx0d
IScnGCA9PhkYFxgYGRgZHBkdGxcXGRYWHhZGaBQUFBUVFRUVFRReChQTHR0fHhsbHx0dGxscGxsbHBgYGB/Ix8dEGRgYGBcY
HBgZFRUUFBQUFRUWFRMVFBQRHx0dHR0dGhoaHR4ZGBcdGhoaGszHx8fHWx0YGBcXFRYVFBYUFBQUFhQUFBQUFBQRGhwVGBcX
VSQKHiI7OxoaGxoaiFhZVldU8vMbGhgYFhUUFBIUFBQUFBQUFBQUFBQTGBkZFxAQBwQEHh4eHR0dHBwbkY9gYGRggIMnKRwc
GBoUEAwTEwoUFBQUFBQUExQSDg0TEhMTEBAQJyJVMhsfHh0bkYlkYWRjLINiJRoeGhlmInFtYFwUFBQUFBQUJxESDA0RFRUV
EBAQJyccHR0gJR4bGxwaDQ0UFR0bHRwYHBgXFRUUFBQUFBQUFBQUFBUSGRsTFA8PIg8PHSAhHBseHCUmJSUZKikZJxwbGhse
GBhPQSwmFXYmUhQUFBQVDxQSLSkyMjIySB0NGyAcHBgkHCIeKiaJioqKIiIhIB8eGxkwHxYVKTETLBQUFBUUFBQSMS02MTIy
MjINHhwbGx4fISQiJCQhICMjJh4dHRsZHRsYFxUVFBQUFBQUFRUVFRQTMjkyKTc3OjIyHhcZGhcWFxwYLBoZGR94OTk2Nzc3
ODc3ODk3Nzc3ODk6Ojc3Nzc1NjY5LS8vSCs3HRsdHhkZHR4bLB1NkhoaGB0dHR0dGxvGUUgkGxscHBwcHBwcHBwcHBwpMjk5
JjQ2GBkcHBgZHBsYKxwcGxwXFxwaHx0dGBkQVxkZGRoaGxobGxscGxsbGxsyLi0tNkg6FxscIhkYGywYKxsbGxgVExoaGhoY
FRcXFxYWFxcXFxgYGBgZGRkZGRkyMjk5NkI/FRscHBcZHR0ZKxwcGxkUFBQUFBUVFRUVFBQUFBQUFRUVFRUXFxcXFRYvLTY2
KzY2FRcaGhcXGRkXKRkYGBcUFC8RFBQUFBQUFBQUFBQUFBQUFRUVNxUxFBQvMjExKis2FRkcGxkZHBwYKhwdGxgUFBUVFBQU
FBQUFBQUFBQUFBQUFBQUFBQUFBQyMjIySDUmFBkaGhcXGk4YKhsbGhgUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQvLDIy
SB4fFBIUFBQUFRQVFRQUFBQUFBwyGxQ9GBIUGSsULhQUFBQUFBQUFBQUFBRIOiYmJiQ0NDRFRT8pJDQ0P0VFKSkTExgaGBMU
FR8jJRMTExMTExMTExMTExMTExM0Pz8/MCYmOi8wOgwiBCYCLw4+HyURER4eHREREREREREREREREREREREREREREREuTKmp
Hh4iISoaExUWFhcWGBgYGBgPDxefFBAULhYeIQ8PDw8PDw8PDw8PDw8PDw8eKRgYGBgYFBQYDgYGBgYFBQYFBQUNDQ0NDQ0N
DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0bHi4uEx8MCQcFBwUNBQYFGA4JCgUJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkRBiEh
    `),
  }),
  Object.freeze({
    name: "장비 강화 화면",
    expectedKind: "enhancement_panel",
    frame: grayFixture(`
Ekc0E2oYFhQXFxoZGxMSEBQREAsQIQwPDRQXIxETFREeHBIYFBQcERAQFQ0WC///CgkJCQoRFRQXFxcZGBslIycjEwwUXGYM
C1YODg4SEBseEiEXExQUFh8hIiEcCP//CgkJCQoJCRQXFxcWGBsrIiUXFBUUBVhnBwoyDggOEQ4NIBwMDxUcDiQoJB82Hv//
CgkJCQkKDAoXFxcZGBknJCEWNREsBQUJAwYICwoODhkNHRINEx8MKyMkHiIlKf//CQkJCQkKCgoKFhYWGBkcGx5FKRguBgUT
CQoICAYNFhETDw0JFhQUJiYrKiwoLv//CQkJCQkJCjExMTAwMDAwMDAwMDAwMDAFBQUFGA0MGxUMDQ0SEhQTDzssLjYeJv//
CgkJCQkJCRMYHB4gJCoxLygiHiEWFBQFBQUFBRwiKiglFRgSFBESFCElKkIsFf//CgoKCgoKChQZHBUTEx0cICETFCAbExQR
BAUFBQMDGBseFBYVFhUWGhQaDxIPEv//GBYKCgsKCxMfGxgVGyUuKR8fFSYWFBQRBQUREQMEGw8SFRYXERgREQ8bHh0fHf//
ERoUICAgHhQsHRsVFiAoJiwYGzEfFRMXExIVGR0gJYyPIh4aFxUTJRshIB8fD///GhgfFyAgIBQeKRsfHjFPWR07FTMxFhQX
EikoKSgtKCkSKCguKSgpDSAgGxQSIf//HhwYFR4UGRQdKxwWExseTx0cfTMhFxUXEhsZGhUsWiASGxwjGxoZGhwGFkYHCP//
GiAWFR8ZGRQaGh0bHRscIS0eFTIlFxMXEhwYGxstGxsSGxsiGxoZDg8NChASEP//Fh4YFRUeExQgGBwcIiIlJB0dISsbGhYX
EhcWFhcsFhcSFxcgFxUWDwsJRgw4Fv//JCQlJRUVHRUdHxwbHB0nHB0cHBwZIhkXEhsYGRstGxsSGxwjGxoaURJVCDwwGv//
JCQkJCQkJBQdHGYdHBsqIBkcHDEYFRQHEhISEhISExISEhISEhISEhERDRUOFP//JSQkJCUkJBQVFhgUFSUkJBUcFSQUFBQH
Ez8ZGjMtGxwSHBuk2sgZGBgVGx4fLv//JSQkJCUkJBMUFhgWF7GsrhccFSEVFRQSEz9EExIUExQUFBOSncgTFRkUFhUcEf//
JCQkJCQkJBMXFRYUGGlueBgUFR8UFBMFBRcXExERJiMYcXBDPXJnGxgXFxQwMP//ICAgICAgIB0dHR4gJistLCslICAeHhsF
BTQXFhEROjoqMzXEXDRW2xYXGBQoLf//Hx8fHx8fIBscHBsbGxsbGxsbGxsaGhcoBTEVFjEwODg5MDa+T0ozEBQVExMTJv//
HhoaHh4eHjEwMC80NDQ0MzMvLzMzMzMvLy8VFS4uMzVQm5RsQp9CIxQRFRUTEv//G3t7GxsbGxgYGC4uLTEtKysRESwsLCws
LSATEysvLy9VjtrGQ5k5GA8WExYUFv//GRUVGBkXFhQUFCkpKSwpJygQDw8QEikuFxERECYqJStBbr2/vLlFqxgaHRAQHv//
FRISEhISERERIyMjJSYoISETEhISEhERERESER0hHRATRnEweC4yOhY2DhEHFf//DlkO5w94Dr6RiBxKhSAaGhsNBgYGBgUF
GQYGBg8TIFQuEiIn8SDqLzUODAQfD///CQkJCQkJCQkKEhMTFBQHBQgEBAQEBAMDCQQEBAMFBwcgJyguIBAiOgsMDBQTDP//
    `),
  }),
  Object.freeze({
    name: "수량 선택 화면",
    frame: grayFixture(`
e1FkQIkkIyAfFRcUFx4cAw4LFBUVFhMSEhAPDwkKCQkICwsLCgcICwogSFMLC///EQ8SDxEXGRMaFxEcW0sZJ8CaPxQUFB8W
HhUcFQ8ODwwKDBESDg4LDAwPHQ8MDP//CB1wCgkMBBwWExgQOkcgIUw9LykrLzM0MSspJyUiISAgIBASDQ0JCywiKSIhDv//
CuryDBEJBhMNGRMRHBscHB8kKC4xNj4/OTEuKiYhHRwdHxEQCwkLDlAfGhsZKv//CrVlEGENFhgYFBYSFRUUFRMWGBcaHBYa
EhIVFRQVLy8vFwwMERQYMGk0MhMRFv//ExkRDBUUDi0MIB0PERUTFBYaHBwbGxgcGBkUFhYWWVZZDQkPFRkYN1FOVCElGf//
M0QcJjRTIzQjGh4YERQWFx0dHjAlLzEoKSgZHBsaGhYTDQoUGxwRFxlVIR0ZG///mrf68gwL8TsyNTocDxYZHyMgKWc0JC4q
JjtuMx8dHBoUFBsYHRsYFBwhJRsqFv//OzxESEpJTlBQV0IjFRwdICEuUaloKDo5Y1GWV10fIBwXFRgXGxcXFCEiIiElEv//
HanHLkc3UFJZXCcYGEI+LiZpUlxHSz5GNIzyXiwdK29AFxcYEhASExIPEhMTDv//REdNT1JXV1pdJyAmFyYnQCoxtM15MDAz
RLrbnTIlJygmGxcRDgsPFRUSDxASEf//R0tPUVZWW11HIisZFh2FjyMqSUY0ejxSeDtRNTolXSMiHA8TEAsPEg8LCw8RDf//
RklOS1NHUTolKCgoGB0iJB8xMk81bL6ucC1lKy0cLSQgHwoLEBAOHBMKDAsNEP//RkhKTEpFLyYkKCckGiEmHSw1MDBcMI6T
bkEqJR0aJSQhHhAMCwwLFBIdFA8LDP//SExMQi4vIyIkIyMqHSMmJyksSTNIeUhOYUEzMSwkMyYiHxwcFhEKDBAPGxkVC///
PzodIiMfJCYmJSQnHzQuKyhcY2+gKzAwQ4I/gDYYKC4zHw0hHiAYDBAQFBAaGf//GyEfHx4hISUkJCkpHycnJDWJe6mTUyYt
LzyQPD8oJSYnHg0RHiAeFRANDx5fEf//HxwcHSAfISQlIiMgHiwvLiU+q1GUXioqEl62UxknKzAtHBAVHRMQGRcSGSQNIv//
GRscHB4eIyEhJSgpGiGVNBwjIzJCMTEwKSMzKCAbLYcgGxsWEAsLDR0aFj2QaP//FxsbHB4eHyEkJzIwHiMnNzwiIh8XJykn
KxceJCk4MiUgGx0dGRIMDhEWMJZ6N///ERcaGx4dHCAkLS0sLC4pMzs8GyMlJyojPDIfGjs7MCcjKx0eGRQRDhEbO8jnm///
FRgXGxsbJSsoKSImKi0yMjI2Nx8Zq6yziRscOjs6LywvMScfHyIUGA8STbPEq///Qz0zEQ8VGBgYGR8cISkuNDU2Nzc3NRUZ
MTo3HTk2NTcyMQ8eHh0fFBAOfmx+jf//HRQUEyEdHh0mJBsXGzI2Li4zJCwuMDU6NzIsKy0yNTIvMxEYGhwjFq2FOmWBgP//
ExEUGx0cHyEiIhwiFBobGiYqLSkrKy0uLy8sLTMzNDI1NRARGB3IppmMPEZRaf//EGsWHBodHyQkHSIdHBkXKUA5SycnHR4e
Hx8mHis2PiMgFR0TERGhicdjbT5ZUf//DBQYHhgbJxkZIxgaIS8sMy0qMB4eHhweHh0eHSImLy48IBwVFhDKq4JpbE9aYf//
    `),
  }),
]);

// 첨부 원본(sha256 7820f852...)을 production과 같은 방식으로 축소한 fixture다.
const ATTACHED_SKILL_PANEL_FIXTURE = grayFixture(`
DCkpKSoqKikpKiopKSkqKiwuKioqKioqKioqKispKSoqKioqKSkpKSkpKikpCf//GSkpKSkpKSkpKioqKSkpKSkpKSkp
KSkqKikpKSkpKSoqKioqKSkpKSorKioqCf//RjwRE3VrdnMLERcYFBASExERERAQEREUFg8MDQsREBARDxAPDQ8MDg8S
ExAWEf//V1Jpi4oQDQ4QFRsdGBUUFBQVFhgZGx0eGxkXFxUUFBMSEhQSEhMQFxkVGC8VFP//EhAUEBIUFRIUFRQYFhUc
GBseICMnKS0tKSYkIB0aGBYXFhcUFRUVHxgkKSobF///iB6Vi5bR2hPYGRUWGBgbHA4kJCMkJCQpKS0jJCQjHB4cGxkZ
FxkXGCYrIx4kI///FBYVFxcWGB0ZFBocHBwgHyUlJSUlJSUlJSUlJSUlHyAdHR8dHh8hHCsiKCQkHP//HRcXGBsbGxgV
GBwfHCYcIG4qKioqKigoKDRpKiopICEYHh0YHh0bGhoiKCobG///IRkcHRwdHxwUFhUkHx0mICsrKysrKysrKysrKysr
IB8jHSIfISEjKSYjKiMjH///LDUmJCUiGh0gHxweICYoIIsqKioqKilSRz5OKiopICQeGiIgHx4iISIhIyQiIf//VTc8
JisoLzAuMC8sNyc/ICsrKysrKysrKysrKysrIB4nHyozNi4tISAgHyQqKf//YjEsJyciISEnIyo/QSY9ICAqRyoqKilH
Pz1NKiopIC8rIicqKi4qKSs3LiQhKf//NiYkIigrIS4uMj1CNDMwICgnJycnJycnJycnJycoIDUyMzEmIiomJygx
JSgoHf//LjccKi4xMjJBRERGRkdGIJUqhyoqKiknKDJYKiopIDAxMjgxMCsjJSgdHCU3Nf//MC8sMSs7QUJDREZGRkZH
ICcnJycnJycnJycnJycnICMrKSEvMjAxMTAoMi8uMv//Ly0rKS8yND9CQUNEQ0ZHIB4qLioqKik4ODIpKiopICIlHxwl
JygwLy0vKyYnJ///JTg+RTU8KyU8PkA7QkJEICsrKysrKysrKysrKysrICocGhkhIycmHyElICgvK///WjcqKDNBQUQy
Kio0TENEICsrKysrKysrKysrKysrIC4wLCUeHCAdHBgiICIkIf//PT1APT46Qj0/QUQ1NENDICsrKysrKysrKysrKysr
IDE1NjMvKRsZFhkeHSUhI///Li8wLDM+P0FBPUI9QDc7ICsrKywrKysrKysrKysrIDQ8MTEvLTAjIiEbGiAmI///Oj05
Q0M9Q0Q7P0M7MDksICsrKywrKysrKysrKysrIC4zNDAzLjIrKiwnIRseHf//OjgvLS0rLilBR0c+MSYmICsrKysrKysr
KysrKysrIDM3Z6AycDMoKikzJiYkGf//ODg1LzY0Njs+P0IvJCgoH0RYVB8fHyEgHx9fgKNYHzEtSUFbVlgkKy0qJisn
If//MzE2NDYzNicnNy4uKjY4HBwcHBwdHB0cHBwcHBwcHDVLQ3ohHjAlHyUnHyMvIv//KyssLS4kLCwnLC4nLCktKC4n
JjMqJzE1KCoxLyImJxgHcm5ZCxggHx4iLCYqHf//JSYkJSEZHhodJCUpKSwsKSgoIh8iIiMjIyMiIR0aHUVFYndCVU8c
IBweIBwhGP//FxkYGBgTFhQcHRscGRUZGxQSEA8QDw8PDw8PDxMZJx4fFEQpKSgQExMRDxAZEf//
`);

// P031 보관 frame s4(sha256 ed5ca60b...)의 실제 48x27 gray fixture다.
const P031_SKILL_PANEL_FIXTURE = grayFixture(`
Ix8aIikhIR0dGBcVFxofSUQZGRUWFRQSFRMXHR4eLx8hHh0hHiEZGRwdMiIZGhoaGRcaHyEZFhcZGRcbGRwdL0QeHBYTFxsU
ExQeHiEkLCofHhsZHxsfJh0nJSMqHB4ehYQX9/vzJBgYGxkbHB0cITshGhgVFxYaFhQgICMlLSAeIxwcHBweHh4gJB0fKx4e
HhwYGRocGyEZGSQlJCQhHx8gIyQkJikpJyUlIyEfHyQeJCEdIB4fIiojI08eISQk8YgWtwsT9BYZGhkZMyIeHyAgJSgqKzQ2
MSwrKCIgHyAeIiAhIyorLiUrOyU7JS4u5P9mHxoYHBkbGhYaHEYfHxonJSYkJCcmJiclJiYnIB0hIB0gISgnJy0sISwmHx0d
GxoeHh0hGhoWFx0XGBodIA4mKCgoKCsoKCgnKCgnIB8iHiAnKygpJS4iKCQnGhgYGRsZHB8fGRcWFiYdFyQsHxYlJyknJycr
KSswKCY0ISEfKywrKystKyorIikcGhoaGBkZGhgeGhoWFyMjFyogH01IQkhISEhNTU1NT0pKIS0rLjIyOjk5OTovJCIZGBgY
FxkaIxocGRogGB0eGSUfH1csKCcnJyYqKylSKChCITYzMTMwMS0pKCgfHSAkIiIiUi4pJSgxIiAiGh8ZFyUgHyssJycpKSkr
KyknKCkmIkFDQkI8OCwsLBsZGh0cHBwcQi0pKSkvJS00ISAiJSUmIJgsQykoKCVGTT9rKCo5IS0/QkJDQ0A8OjYuIRkZGBgY
MDItO0A+LCgoKSQjJScxHyooKCgoKCgoJygoKCgnIUEwKzo/QD86MS0wKCUiHh4eNEIwJSUkJiwyLy8uKzg+H3MmdigpKSgl
MSpLKCY8ITZBPy0wLzAvNS0yJyUtMCcnHiEnJykuLi8xMTQ5QUNDHzw0Mjs3Nzc3ODg5Njk5IT1BPzU2Li4pKicsMjg6OCYm
Jy0vMywwOz9CQ0RER0FDH2AtJyoqKyotKywqKiotITA5MTQyMS0pKSYlISAeGRoaNzI2PTU8P0JCQkFBRUREHyoqKioqKioq
KioqKioqITguMzUtODIxMCciIx4cGBgYIyc8OzxAQUJCQkBAQkREHyoqKioqKioqKioqKioqITIqJSwsMjUqKi4sKBoaGBsb
OTs8QEBAQD5CQkFBRENEHyoqKioqKioqKioqKioqIS0uKCgtKjY1NTolJCUZGRkZOjw9PT09PD1AQUFBQkNDHyoqKioqKioq
KioqKioqIS8nJCMqISMvMiwnKCUkHx0dPDw8PDw5PDxAQjY1QUJCICoqKioqKioqKioqKioqISsrJyssLyYlJi0rJSclIBwc
Ozs5PDw5PEAxNDIxLTAxICgoKSopKSkpKSkpKCkoISQmXcxabSQfHysmKiwhIB4eOzY8Ozg7PDktNi0oMik4IChTWCAfICEe
IB94lrBsHyKePz1hTlkuICYpKCszIB8fOTg6Njg7LSonMzIsLyYwHyAfHx8fISAgIB8fHh4eHx6Rc51BKC4gHiAfHiIZLiEh
Nz0tLTkrJygtMyozJjArMyclKjA1NDtENDQ0JiYnHBssn5S6EzgdHB0lKh40GhoaPC4rLyYmKycvLyoyJS0rIyYpKywtLy8v
MC8qJyggH19dTUZXfIYpOicrLywxHBwcLDEzJiQoJSsuJSwmHyMyNS8rIyUhISEhIiIiICE7bSs6KYFKTlVFGxkYFxoXGBgY
`);

// P030 실제 기량 화면(sha256 12e350d9...)은 기존 gate에서 false negative였다.
const APTITUDE_PANEL_FIXTURE = compressedGrayFixture(`
Hc/fixR1AADwlzK93dvbnZ2Zm9kfMzs7M7uzM7Pza7+/Z/bX7a5n6x1312Uqnp4hWfRQ0k/UUsHwoQyjTCSCoLeeksjoh/SQ
RuVDRNCLUUTRQ4KeEFRy/oj6/AeffJbnBL7szcyP9uHuaKC3u73R0v5WHG0gOMSQYPTaqSYIzZIfNZRi8YkXjxx94ejhw/v2
PLwfz8wPHxksDgbD9x7tzO4im59pIQBLwoFeKS9KcaJbtVqjE929u2vn7tXVbY/3ezPjXq/f61OWIDcmJMYAtqSVBx/b0ep2
tw66RY6Ltqys/zy/bXXvnsVnl3leEERJkmVFKRULkiiKAp8kyWA2CKI2Gm8dzs3t+Hv57df33lp9eM/SAwOO4/JisaJbjt/Q
K8q0kOd5FseM+bSbLKxs7gbB6Vvr62t37v4zGPYTlJ5Ib5jM/m/TRDqdykxOTjHGYhYvDwFgYOQ4M7Nnz7z5RsxoPMvoxolU
Kp3N5bKlXCaTTqftmnsvZXTMmv0xQzCpalrCPjn/4XlGSQd32H2pzBTPa9OqrimFWpbLTk7cg7GrO4Zt+oAqkiwzymJMEkYR
YfHGqZw4ndFMta4rMOJ4Pp/ZhGJY13RDtX0bNTWtkzBGaSemmDGcyguiuPVYrPt0eHUZ5KZFLjV/f4+Ui/mG23RhQmmbUEYp
IW2GKUoVCnLRH5Ew9KNza4lYLBSyfRt1fcfza6qja5qGKWKEYUQYpjCdF4Wive9S5LnkwFtQKUtSFjYcM7GrZU3TlBoAMSUQ
tSmmCDOUyZ8sTxtGZDJ4iLpqXj4kcL5mzIziRqkwrUSk22WQonaCKMa0vZATig55Z/ve7e++tPupCx2sSkJe1VxvdsxcvShL
5TBEMaIUAUoZHs3l5aJasjpISkAjiJyKXBLz1RB4gZXAZj0IXUIIJQgwggnG27fw1pZSaeb9JUVV/VvJXLYQNngXNCFstbpt
2O1BhBCkFGGM2fL4oREv2bIUD7f51UK4cnBVkpUC7zoRrIPIB1D3ylEUQ4xwRJLh0nwwx8vNesX96kTftI2nl49LO5/k8kHr
4O/rd+zQcf0mhRAjQhKagEXmW8MpXrEFyfFKtbpCa0LOKAs54F85dfumZTiwFbQACJMYExQj4PfbUK4otsfJ2bIg5nNyxjWL
ggw///KPK3/dpkHNdwOMWYIIQxiDaDAYq1XT0JysxM6d+0Ce9j2jXKnWL3137eZP30QI4Bg0m+S/LGEUhrN9X1SMmtWw7Whh
cbcrO45Vr5veZz9cPn3x251hizTdIGgDAhEgLGzjqMmZVqVqZqvVhtswKxXdqleN8OLXa9c//vH7wPY9y3EY6mDCAEGwHYKJ
qVyuXC6pakXTKpVazTAs/eWPjjx/svFKv2nDRPM8hjADFLAEEgoYbiXIbBr1mQXLjscMJpiwo68e/+LYjSCKmtQzzYgiQnCH
EsYAQwCrgVrRdaNmmppmJZDiE7/8euH6jbWSXFOfUy0L4xjHhOC4E/dJ0vL0slStSALPcRxXCmFy+Lc/z3569drlM0MvrJqO
8y8=
`);

// P006 실제 밝은 절기 배분 화면은 어두운 방송 fixture와 명암 분포가 다르다.
const BRIGHT_SKILL_PANEL_FIXTURE = grayFixture(`
inqYa7EcJDhfiYFvYTZSFRQxLy85PY6Ojo6OjlFgUI6Ojo6Ojo6Ojo6OR42QkJCQSEpGR2iMjIuNkIxwWTROUx8xMS8vQY6O
jo55XktPW46Ojo6Ojo6OjpBWW3ZZkJCQWVdVT0dHFBYkJS5KUDEaGx4gIyYpLDc9MCknJSIfHR6Ojo6Ojo6QkFZeYmBgYJCQ
RURHY1FHFRUQEBs5TEMcGx8iJSovMjw3NDEsKSMgHR6Ojo6OjpCQiXBaKlZoXoyMNEBDRUlMUxAQEBtfX0IcEhMlJSUlJSQl
JSQlJyUlJBxYW1mQiZCQe21cI1dcdIaGPjk4Rk9PThAQEBVZYD0cAQAtKSkoKS0lJCUqKSkoJxxcTkyPU5CQkFd4YFFhVZOT
9/b34MIrT09QEREzFjYdFh4lJiUjIyQiISIlJSYlJRwwLk5gR0dHUU9benZmVUxM9/f2I0KcHjdPURM5RCQcAQC/oigoKCwn
JycqJygoJh1FOkhKSFdQVzs6Qj06Pzw83vXtoY8sHB4ePpORI5wdIykkJCQkJCQlJSQjJCQkJBxHkFFgPEI9QUI+NDlNR1BQ
9kISbV8RHRwcOjpAH5ogLABPKCgoKCwlJCcsKGopKBxHkko8Rkw7PiZAIjYli1pauRIRDwsRGhoeNTs5kTocKCgoKykoKCor
KykoKSgpKRxHQ0xZSkROQCsOFxMBF1BQhExUIzFcIRo1NTw6FDsbAQKJZikoKColKSUqKDcnJxxPUGZQR0ZRbkMqLzU2M1NT
ODo/QEA4NTY7Ozw7JTobLCwrKysrKyssLCwsLy8vLhxfT05YT0pSNy8xVkNJREVFyjlARkpGRD88OEU9PjwcEiyfIygoKCxN
PTgoKEspJxxLfIOEcFJHOTFbZHR2VDs7s0ojajM5ikhEPjM+NCwcLCwqKysrKyssKioqKissLB5TUUiBgoKCeFVWXFlcRz09
Ljs9Ojk/YnV1c3QvN1IcIg+HJigoKC1RNzsrKEoqJx5wdWt1eoFybXJmbF9eYWhoEV0BDwYPiYKHcG9sdWYbKysrKysrKysr
KysrKysrKx5zg/GBpoJvbXh/cnFtanBwTQQElAIFcIdsgYt+iGkbKysrKysrKysrKysrKysrKyCDmIR3hHeCfImJdYWDiYmJ
DiapDxAIioaCeoaJimodKysrKysrKysrLCwsKywsLCFR3v7/aGJTW3NJSUlSZ3R0UgoMCwkIi4OAdE9IcGUdKyssKywrKysr
LCwrLCwrLB9V8OPW6FS3T0hLSUlKSEdHh4KLWEpKc2VHSEhKV2EeKysrKysrKysrKysrLCssLB/f7OHq6vTHSUlITEtISExM
TEhKTEtISElHT2NlURcaKysrKysrKysrKysrKysrLCDb7u6e4Oz4SEtJS0lLSEpKSUxJSExGSk5lhVNmShcbKyspLCsrKysr
KyorKyoqLCLrxd7Y5tuzSUdTfFdJSEpKSkdHSUpFcYVjckNYbE8aGlGLGRocJChHHB4dhp6BJv3c7uzuqay4S0t1Unxvb29v
RklJTnaKiYiLaklBZmYcHBsaGxsbGhsbGxocHh4fIC9/psfH0tpfV1BERj8ebVhYREt9gZCKhYaBaGhGSm9bVTscHR4vIB4g
Hx0cGxx2c3n796dLtXJxHx4/QleVd3BwgIqQhI+Ii4SBcV5HOk1LNTQeHh4cHh4fHx8fHx8xMVHVmJySmWC5vD9raolbWIWF
`);

// 현재 후국지 실물 중 기존 gate가 놓친 왼쪽 장비 강화창과 9행 절기창이다.
const OFFSET_ENHANCEMENT_PANEL_FIXTURE = compressedGrayFixture(`
LZPbixxFFMYlJmSzm0l6Znfn0t116bpXX2a6e2ZnZnenp+ee3ZCNuXmJMa6GXJSEGIxggggh+KDigyCoRDAYfBAhCAriPyBI
ngIKCl7YBIMkL3nwxbyobfBXL8WhTp3v1HfqnYsfXPhijLDyAykpYVgQ7fpCLMSS2VEjX5q1LBNVTEgKpsaeV7Yo1qLqe67U
xPMDSl0qCfe0qtWww5FTZKBUKlXK9agVKJ0Baeh7CyLbKU1UoIMAVRAUjOlGfQljSSEmlhVH9TQOlDK15K5X9X1XC6myFM3l
0X3py1xQR2ILYxtSUozNeMmp1tulkmkh7tu2TQnhXGlGHGyjLOj+lwoQQvO8LJnweylpjSIpwbxNqxbEmY6omXQaoa84AfbI
pq6OPRfjcoBkRYOw67fCVQCeff6Zw+uPYeraFVsy3jQtSBzLpCRWSnsaO5bWzFae327rCPv+k+ePOWydsBoKEJXYsQlCCpjS
x1AHYYAQqZgU1KUKAy2dev34yf1vHXccuWRJUm3tlpJA1bNtp2yZABMms2cgjgMtm7tSYCmfOgzfeNPgSReFsWrW/KwjEkGw
LbSAI7ywuZw2a55w0JapXG7726PRN2g2N5XnYULqNHAVCAhRCxCAkFMBhWRU8IZoCoJnHnl0Wz6KKBRFG/JWW6sFLjimJvJc
SEiVUgdSTjOPY9okWbyQny+Z5jpB4dlzImh5vkMbgkccqaFj2z6nFDLJGeNxdj9lyKDz3mTyy6VywlFaXdR+VdZ1XBWQhQ7q
DrFDAVEMMxqRJmUkSNd21xgDZ8sWRFzWozCMG1EcBlU/dvAyEUxYwpW1ls6WFKwJ964tjsdxFQIbaiE8wWQ7GyEh/BrCts70
W8wlsvrgL9USlCwhbCbDoXFk0/SWKSwjBuuLTV7HMYJViPJbKQaAKa51+8prLVfQzkKnG3c6k81T727aTLBHLOwHRHKEMAVW
IBilQCihL++9duJGX5PhYDBK2+0ZfX3W2AodhR3w6e0f3xcA2BhYc0XHzT4WAO89+O7L7/+Javak2h4kSbJvevt0bpoxL2uD
UiaoZXGmrLlSqVAo5M2kt3Hn7q37o/4w0UG9n6aykpnIeIaOG3G9EenMNQ5LpWI+I01v3v3j3s+/TYb9YWewnPi+xBQX5UOE
/B+XkGJptmAYhX7y+cavG19/tZYm/V3dTidJKJqjHSxNgmwMEUYOygaasPx8PjveG6cnf7rzw+/Xbu0ZjrrdleWVFXN5mPai
TnPY2LN+oNPvFeB80dzZCgBdmvSWukdvnr5x//rVy8PBejQZtldXv/1sTe0/tWuxMbrw4qDT6Bkwq4IJVblcbmczffzPS7c+
OZP4XiZzdseg223v3X92cOLQc8uNznnv9MmDO2ZyD9k6s31mptvqv7px8KOrr5wrGW7oHxuPx/deX2yvXjrMnzjVfmHp4pmV
OWOuYhg7DcPIFw5Z9t+3jzz94cenDrzU7Q6Gk95g8C8=
`);

const MIXED_SKILL_PANEL_FIXTURE = compressedGrayFixture(`
RZNLbBNHHMYLNbG9cRzvjNe7O/vyY22vEz9ZO36uH+tHYifEhBCUB8SJHEigCRTi0PAMbaKEZ0GoB4QQL6mqWqlVxQFV6qmt
xKnHHnqjVVvaoqZce0Jdl0O/GWkuM//55vv/hrYAnIPIISRRqL50dHxyckqbU9GUKiXdLtGn2AWOIiJek7mHMGFG4/brUCgc
U4p2mqKrhxcPHmo0ZmZnZwpCfyXr5T1Ob2BUnLc0zCZgwoBer9cZYESOeaxkXo6Hhk7Njc5pmjoyIyUrvJO3+yi2tcHtJ3Dc
iOn1mMHQoYO4BUKvDfkoxj6FA2gjKMRxDEUSAOB8wx2eObqwJmLmBw/uaX4cTodVBN20q2BzZZIHASBo1u7uCbjtHGOF0BXd
M337xMd9VNfdla37GbNZcEi9kJDGMnGSDTgVQDJIE0XTdHsF+/1FD4lokiTPfdhqNDHMG+zttpCMWM+KfmcwDQMsgRiGdrlE
hBgE9hZEF5lJO63GuxduXDPq9VLA5/Mjml0+NjGpdlTgCGIZbT+DHATDsKAQ4EXag5DFrBwb7sI6O93eEIMT4mJr9czcnIXH
Wa4tlmV5nuc4UM6Vsy4mLIecJLRpCekziq+XtdiQ/8jSvrGIA+zQ3DAsrWU1yTA88A4oYQdrg12mTgzD9AZDVs2Hw2EbHY3G
Xe5SDLIC366sDUHgBZCMK6rPjaxmkwnT0jeZlGRS8oW9Cb9L7pWwBGARx7AM6i+0zrEsAtlEPOH3OlhosXSbTUYMi5UyPZFg
IBb0S063LoQLxg69QbtXs6rv0INEXPb69vxGdeNdBqsVNxim9w7UarUjAwF/UOtEHCxiuZ27goa0oEtGDQb45POHt1/f+nTy
PdxosIluDBsq5NPzDaWW8zk4hxCEgqGmC+7Sdeg62sIHKqNb169ce3z8zghtxjsBcA3V8jV1dGC4uP7JdVWFE9wEqzWKou3a
Kxi8v1J+8t2NW1evfHSsP+W3U9RocuLU/uqehcuXBh88fHQS7kQ0RVFaoIiiaARK5fLGpRs3H3/1bWZhel+1UIiGi+P5/slG
IZdaaY0cgjvaGCBEEowGEA3S+dylxdWnX6805ueWFmbHx+Uebri1WRsMXrh+dV/2IBxFb4BAjiKLeCClN2dmXnzz8tkir6yc
WGg0ehLn19YvX7t55nCzoCbTcLg+/L/qwJOKn/qxZ3v7p62+0O7kiWbzeGv17Nr6mWppsKimd5fhXq5dnvHLjjzL0GCk3ny+
+curlz+8rS431Uhvb/VA6+zJ/lJu6Vwlk9Z44N/oP9xYDu8rPZ9f+evV9mc7E7lU31i9nigNjRWywyvTRTVViOeBr1wHwAIg
AKefbjSApK4+XkuR1vi9+6l4JBaJ2KJKJfPOyawig0R5MIXj2qeFePsIjltwqKhDs+++lRd3PPt5TJQ1MglCiGVqqQTTna9U
8zlfwKOGJXd+0CMlsvGwL7P2z/vnN5tNafvvP6rRSCgkOJzIIcsWkFHzRaVPlmW7XXR6RI/b5ZQkUX508YONO1vfN7588Se7
PCCKNk5wOkU3ULOZTLwvGhQYZoC0ElYaQsiEo2H14vnlo19MHDj96+9SIZ3N/gs=
`);

// P014의 어두운 gameplay 바닥이 강화창 title/button 위치와 우연히 겹친 production 오탐이다.
const ENHANCEMENT_GAMEPLAY_FALSE_POSITIVE_FIXTURES = Object.freeze([
  compressedGrayFixture(`
FVRLqBtVGN7VeptMMnNmzpzHnHnPnHlmMskkuUlubnJzc9u8WqkVtQu1Bd+iQgWpQgulUFxd3KgIunFhK+Km0pWICopgXehC
3BRbpIsKIrYIunR6Fv/mfP/j+/6P/9yZt5/7CGAoCbV6rVI5VFNlBSpiXUL1SqWmiqokntqnN78GNV0Qq9VqRajWSmRdqtfr
NaFSFRUFKUpFhKQu1BVSfoJLv6KqBH6++dRBQRCqglArS1NJtRFFhxRJIghhQZYgqEMqybKs7P9WeVG6+PKFr7YX1aooa7pc
FxVRQ5ZlAAZkTKiqIq/MLGdBQAYbB0FVuH71/K0bBzY2ZIBkCGWIzVHOLGjICtWYpmINC0A1gKrIElHhg9LVX/746c4DtRqG
GlNVbIdEs5CvWVBlukEU1WOiTKiMVaIQBAH64ruzd7+8IElRYkehTdzDfuZ1Yt3BmJmGIasBEiHVECZIgVBU5Me/f+Xi56Io
NiMehLEWREW/u8g4JJrruAa1uA2ooRGMSzIlZ1mGg40yyr0oCvxe2hudfuaNE9sZYcxyfVenqSNSpmmaRRGmBJcpQIL31dIt
RBw9PHvtv3+/Ode3HSf0AkelbQ6YTlxEMNEIQSpWoQzKR9FA0309PHHpvU9ee37gRdzmEbf8JFIM3yrVKEeCKil1+vAtIEkS
FQGAkMSDyXx1ZNrkjczlaWiRvo9sS8c+Q9TUStJAAfL9BkTP0zxvB3GcRlHIscWcMPAss2sjx9NdYjKC6epYfwVkJN7Hl/bC
yC5Fca1G0el2M57GMUIjR+P26YiZhKjN5bq3WH+anS71ZISWdgyTvNsrtrJWZ3szb8SJlHuqEVrsANMpzRZ7y0myWl7/sayP
PT9IwqKZdjeLdncwGK5b7XYqIh9DZvo17NBwMlssZ+vlsSdRiY/jVrMXFUUx29kc97d60WbRSN0qIpKMvOX7liYER1ar5XwR
rGfHK5YVJGY/T+KilY7bzeGxxSLPAo8C4qcWJfETplm270wXs93lUSeCAKTjZmLyNBg7PT7PGslgGJqpl+XepFVSPewyHFiT
bLY8vOxmytOMZWE4KqKk2G3mk24rmDrJtNMatndbfq5U5IFmmf639cmNlzo7/lqQFWVz7I+iJPJai2DUGY7G7Xbe6bG9vW7D
7SE4NZkWvvv7nX/u3R5yXy5XZm+nQZBY/mCm93btfMfr6p3u0Bn1d0Jsqo/qmsnDW3/eu3f7A7730GMQ2taoF/Rx29tqD5Nm
Ovc7J7JRlDWHcdMyCWXU59z/6+7fd4JgkoQAeNw1jUbHaW23vOa224jOHPjBc948OV00EsMp11viOb/8WcCTLDivqp5TxDiK
fHPICmOk49Zmt7M1nS7mi+OPYF1nlAecO1euuHwdcNF1HWMvbHjmrpXyeSPL/KS8JBAqKpIURSmtT4NBlHuXTx3lq4Q7Yeik
Tc3Hvu2nR7zx6y+4/OTDH0dM0zXGDL3rPbt6dWd39s6p9vH5zBn6+/v/Aw==
  `),
  compressedGrayFixture(`
FZLLixxFHMcPUVeS3enp7qrqenX1a7q7unv6Nc+e2dnd7GZfM7uJGoNE0EMgSsDXKSwGD6IIwYPowZsXLxpY8KDHiJ7UiwcP
apQgRDyIBNQE/wBrC4qiii/f3+/7qd/1l9995RMTI13TtLa2vKy1ILRA29QIOLOsGRDoxpUP4L3bRpu0tFarpQQt9Wa09bam
qduZNsQYQR0ycEYHUEeGefMXe0Uzf7p7dVnpV9RuaUptgADRltXWGSbUME0Klg1l1ALm+78uvaC/c/WtL3fnytegFLbbbbNt
IuwSnZiYcGpA3SMapCaGuvHokrnSunN89Nvdx06dMk0TArWgZ9u2KwwKic1syDSKNIghQIZBAXpc//zuHz/cX1paAggQiBAR
HRNz3wEcKjlnlgrRpoRQCwOKLWh99c31B9++YRg8SqLA95h7OYgI8S0bc+F5yCY+hozblBJkIaRbl7+79vbXigutqjjqdrnv
BpUYBMgj3FVlLOZYiHFKsIUtAAwA0PQ0UDmJE0ZRmKcyL5M8DpnLWNgJgM1igoRrc5sTpIhZAJ1gBoBQ32XYIyyzZX89cgIi
gk6H2CJFTHgO5oyoOBgBZCooADBKG5d6lNqMC9GJge2FYYh9L4A8dBnnhFLLspT1RzcVS5Mxhi31knbzou4VoeV3pIzsrptD
x+c8VKRcRrHyVv5KLzhL0jQJVFHGTpJiTybSIZ0E+wHn1BUM052jwwMMsA4NAxFoQCEYOeFWlIP+sMyyEJMsIEEu4pO/YPne
QbV/eFxeMQxDZYDQdPKirHvVcDSaTmd5NzHqKHCCRDziCm5vHizmZXGw/vP3qh8vTtK8lN16XDebo+H65MJqkXc1Hoi2F4nl
9zya7C72F4sL+089byl9lCTduKz7zWwwbrbHO+ONcVXGLYubuuWcykP+qNzZO1jsz+XBuaEuRFJUeW81n0z6/fHaaCzPTgau
YxtxlAeQyI7rpLKarc135HyevaoKJFmvLEYyi/tFf2dvq9evd3thro7VYcdF3I6ZLD7c2N7bXYxSeA2htEyyJEvLZnt/MJ5U
G6uTetov13bzzZLo4LTtut0fZ3e+mG+sy0MOIZR5VPX8rBgMB6vTcpbPmrqu18NoY5hJZPmuw9Pje3/99/D3o2G2gxByNxKn
6SRVlk7H1VCcl2XTyMn5ZtZ4QnBsCx7Le/cfPvxzT24/sYVQR6RuWXeDs1lVVd09eZYOxmu94XQ2GSeeGinmx3Hy94N//5Hp
uRpYVu6V9bSWq0kTxv16MHFfX7pd+DcuHSzSPHS4y8I4juXxZzLOB8lLKyv2KAwTMfAmVVM3g7zKm9FotrU1358/eQmrUVbt
xHFw61ZHHsoYTCZyLUjLjSL1O91FkY/LfWioVNDCalIgE5zEW3E//PTKYXqYxl3fz2Jyzht7o6Ko9vyj12L57MWPU5t73LYd
MZUvXry0mG+9+Vz99OYzeRTduPE/
  `),
]);

// P029 방송은 상단 광고띠·흰 sheet·우측 inset을 함께 합성해 일반 panel 경계를 만든다.
const BROADCAST_COMPOSITE_FALSE_POSITIVE_FIXTURES = Object.freeze([
  compressedGrayFixture(`
LdBbbFIHHAZwKQd641Y4cDgcOJTTwqFwKJfTQgu0QEvLpRcKvWntSqVaHfZCKbcCcuvFbVo1W5wxLjNZlpi57mHObA/uxUs2
a6pOsxmTJYvzyZlt2R4246VmNdnv+Uv+3/fftet/lIk7V1196tGr46uMYPisn3LnxsRZTnYo6aZQ6DRaNUADBAIKBS5KWAgk
4jCYVGY1o5Jawa6mUigAFSxj0igVMIcP0CsVax/d+/bSqcnOayAoY1ZACKaQcTiQUkGq1TIABpculgHuEYEKQ2s1cqjWIK+F
6yUQm8PksFivXjx7vrm5ee3W1v37f714+erVs21U3wJ09ZSjCrlCUY/AIuEOgQDisWpAEHy9vb29efPmzbsPH/64/+XL58/+
fU2hlFF2tOKKRg2Bc0EYkUrloASBEREE7SzhMGhldZXMKioVhuswRTX3DX4roSUMOrXcpJbVylEchdVigdjrpdHplVVV5QC9
giflUXEBBeCzargctqi9ATcrCb2FyxMIRSK9QARCMCwUAgCdTmcjdHo5IuGBAogBgkwWm8VTmlVaLaH0tnN5IMgFSaEYFhJC
Nht4gwsK6HQhnw9DEJfLZjA4TAkmUzc2NqzbLTtxkMszaLVFkpCKxbQ3eUSK0svZfC535w0gi8lgMziYrJs8pXzPYeGY9R0m
PJ7P3S39hGJYJX2nETZsqKysEaKwrFnAh0gZUS2WD9h7jsrXuomGyWmP2fL3n78/+JVQqdVAORXg19ULmEweRqgbcaJB02yS
1NX7ux2uLsLv1OmCoYmRznBwb2BOrcRxAZ8BACqVvAYS4m2kgmjXNZMGg0HrdHtcJl+fxTng6/A63P98d+wHJaHDcT7MowE1
agMCi2u9NoPe2N5qaW6dO2zzu/u6fP62wV6P29lPSnkD3WyhSqWSiLloRXVFFa8jNjWRzK1kV168u+yYCc0H47sdXl+gt9fr
cXuaFDIZJJertVopXtvhGpk+PHtoMVYo5Bpio6qZggiWLhaWcxmntdM36nP1e4wqRIzKMIVONz7mPxAOv/19fDEejeXW9Ee6
JGSqACkK2aUZe5PJ1tLpdgXGHcbRIbnGRGo048Oh8cmD0eJMJJFO5yPWLkQoaXI8KhUnM8l8Lje/z6g7Z5/yBw/vPtDR3Gw2
T4ZCQX/L2bbGD0KWPVvJeHpUGMpksmvL8VJhpZAtJNLdj0cKZ7iPihdcHrPVOjYxEdx/4PTxY0v74jc2kkvfbImNdqPJ1G62
dU8uhucTc9NfRz+/eGKw/kqUtNntY8FgMFywDR6KDZ46v7qyFS2VlvP5nQuFfKG4WkyNDbhOz9y+krhH2rxdAb9/tD/k9B5p
y5xcTVx+P3p9Jnkku5BbSS1Of5jOLyczqVS679zt61c+/XLDou+xWq2DQ8Ou2N53jiUi7uPrm+FsspiPrBQSyWRqNpFeyCZy
84ELF9Y/+ap0edjeZ25p6Q+QwfHJ3MSezi9K7ecX4mfSlz5+cDK5no7EZhP5hblY1Hci98utO38MOrVkk8vVqHFGZpcGbc7h
uYzM1TkXsxqIVhzDGhS6emxxKhLeH5h7/OTpo583SBxWKpXWz6LFo8NGtcbnxJCWBmUdVCMU80WoBBTDaN9bgfHM0MGR3548
ZVn32FJmgvCMBTrtriGfLzBDkL0pslkixlEUrUdRRILq9T19EYcFQzaaupR8r7FNqfwP
  `),
  compressedGrayFixture(`
LdJfTBoHAMdxtcCBiB53wHEcd8gBd/xHOT0EKqL4X9v6BwWlokO6oU4LIqj8p/bfmnZt12Rtl7Rr02VpH9b0Yd2SLWuzbm99
mNvDkm5Jl2zL1jRNli1m66pNZpN9nz+/t19Fxf9VTn31uS/M7n8wdEY4sXHVV/Hwy6kPEf/wRm9FhbS2uoYvqpHAlZXyqAFF
EYVCSdWAYoAjrgLF4ioup1paya3i8flgLQRygcnZG599dMc7+UFVFSKDwToBwldL8HqlWllPa52q3HsCITOI4hpUjQrReqNe
JVPjyK4DQXDnxc72o0ePvrv3xebmnzs7O8+3/1VRg1UdgxyVrk4MyYWITIJhCrlMCtVCsESys729/c1u9zc3N+dfvnj5/J8X
lMnRJ0dIkjTW1oEQiqIylKiHFbgSQ2AY4PBVBKnWkDRNkQxt1rtJndnchYMijZbGawGgTU3qSUpHYhYII4aGOFwuh7eH1Gp0
6gZPyaVhG3aHFptbhupMShIEuDCKYRjUhKIqiRwhCL6Ay+HwOKjG2lU6yTRr3DaTscFFO2xIIy0VwzUghEhgySuvkPcJeTy9
DuECr2rxRq5d3GtqMtM2Vm/2OBVWHSmtEQjF4vclEGRlGog+glAoeDUAn7fLbezSsStX9hpYvUlns9mtdo9Fr5Tx+FUaFhbj
0o3iiezt72EY5uG40QwARjloOXbpqk/X0nzR0Wg2WqxOMyF3OwQcQMThUvVbf/3x91Y1CEEAUM0DBHxchzd73r7uo1zMzVaX
0+lukhv0llYLny+q5vAp/YR/+MAwCBFEC9bsdgvljK7B3r5xzUe7bIftzoa29h4aa7GaCEFdnZDDGzBs3T3zUy0EyWR8QMM0
CZyOJivFNrKhZqe9kbGbMgWqEVQ4TTIxqAC5XEqGKYJhGOnv7tbzGN9gj6vB3dra6Bnw+NraG1mPL5NZWsnkFlEbIqXEXB4M
Y3JETiNiBGFtlnqXLhCJ9fU3WzydbHu/n+nbeoLmUsX1ki17MPNmbAqRiWARKIclu38LBNsi/kOxudn4wkpyODIUWc7N5m9o
NcVybrlU7CivrubygfmIa9Zps/qmJycDwdAbM4uH45HJZDaXz+fGoynvTKvhzUy5XC4UiyOFbDRbnBm5PJaYC7Z2er3h2UOx
QCgW7zjKdK9FI6VCcWivR5q4VTpypFhIpUPJjbs/HDt3qbuFjI5PRv3+4X0z8d7e2FJ3W4BZOpHPr2edVto6Vy4t97xTyK9k
7MnSyVPHby2Vzz5xjE2Fw1PT0ZnVWGyuzWbVl9lEOpvNN3uH47n8wNFUYT2/FvO89u6D+99+ctXw8fSYxWoNTE3PBL3efQNG
gzGRiudyh7OoNtCdni2uRdYyqWTKGzz36b07Bzcs4XBwdHR0fGKBHe/sZykHYEoWEvH59EQPRbpTp4+nT6STocT65f25y7nr
Dy+EQpOjI0NDTJDRWCma0uwxt2QX51LJ8Zu3NttPX1iNLp2NJhcX5zY618o///Ljs/nO4dEDfn/HGFOvVOJKLaHVvB7JLntY
h4HS6TGVSm1SxxPT89MT5x///vTX2xcxQjTY1eU9n8i/NQDWSVUYbu7r7XJCUgwF0WoRhMqJhUMrC+kDmVPPnj7+zT7Su6L1
ets7BykFWqMmaYMs7Y5Z7EpkyY0TOpzACILS9o2EAyELffzrscF9Dmf3wMB/
  `),
  compressedGrayFixture(`
LZJdTBMHAMcBEdry1d61vV6vvY9+X1va67XXK9SuUKhUoVq0WAq0IhShQgtioZZ+HsVtaFzispnFJbpFZrJlyVzmsof5EeeW
LNmDZEtMeJlbsvigD8s2E51gMh72e/7ln3/++dfU/E9t7MG3PXHnoe9CF5ui1as9NT/dj92AwoPVQE2NpFXQzGtpFoO1tbIE
CcMQgil1bUKgoR6oE4pEtYI9Aknt3joBjydsBtr21EQT12/e+qprZKOuDpKCwja+AtGoFYRSp9MbdB1Y4QpeSw+IeAKhpLEJ
IowGTEoooV1PKBTuvNrZ3tra+vnunc3Nv3Z2dl5u/yvR+RS+gXq4jd+mqudBUjGCyGVSCdAKgGLxzvb29sNd7m5ubp56/er1
yxevIFaP7oY1NfF5DXt5MAJLYRQH5UoFAoEgjsnVWoO2/TJlcRoNpE2v1XlIIyZqbW5pwtr2Nja/gRFalU6rQtoBBA2FSEKJ
aowGK5dg3RY1YTSZ9ZReLQXq+Xw+z8JvBECpWAyCDhjGxDIIRdvVGKKhTVbmmquzi7XbKLPBaZbTvkacxwNlgsZWQCIWi4Bd
Xy4LtDU00Ca1UmsxmXLTns5u1mFjOymbmVT31DsETYR1D08qEl0TA4DFTqHvoqhcbmeMKtxsM5E6hu62M+2s029HKZJuZPgt
ehVPDGAmUCYGq+X1c188QkHQ47LrMbOTZV0MRVltFGlsN0iserbZI+IZIEDBeFib2eR4/vefL55b9ASx39tBklbW2WGhzA6b
u7+XMHsiw8eGpIiSZ+RU9/o6A3aWtkcT0dmkmdRq3S6W8TPtvX3efbYOc2+wz/v4n0dXsueGHEsL3L2ZF7PJE2GHxvD864uP
vUazwdBBWpiugW62P9g33B5z+5YjxdJaeeOTtcrxCvLDIJvPpeZSqTGddDgOyvtpus9Cm8zug2909B88xPinl7nyYW7V9vF6
f6VanS1qq+XcXGYpE6NUMEwyNMO4LGq9iqQ7GfeR4OnMSGm1VC6V9h+gq9wa52Yobj5byp8NxDw2QkNSNptNR6sMPr/XP8Nl
uaFThYq/VK4Uy+9p1voqIruTcWVK8aHs4sJvbqdV3qpCEIfz+CQTXVrKFXIDqUo1kC1zqxwnT6+u0Q5Cv7vYVC4THe6hdDeT
IxSB4+NRXzqdWjydDY6urFTeLk+VKsXi5FSsVKZIOazAQvMbqfw7Y9dLVyZwgwZBYmOJqeRserorvXI2V8oX1or5Si58tJxf
00vlcgQ6uf7L+NXPPnT8+M0oAWtRNJKYSEyPewLTs6sXCvnlaqlQyGdikcT8MoTKZTikoc8lb92+f8d1fkKllkmlkdHReNgX
H12YSxeyK+lcsVBYyY+Gz2SKKKrBUAgKdM+/f+PB7TcreCgrxfFjx4IOX/zE1Mx0ZWFuuZA+cyYylpw8MbK4eBqXQ5IFW3Jg
+YNL12OzZrXJNHPhQthFDg6ePD5xpHCYi8+nuMzDy59ujp2/tBCOIxis60ga2Y9Wv3+y9fsRZzc+EApRnnBvODI+6egarBzN
pEazB3avrTUgGKbWUZ4Yqu5c3vj12dM/ohxJiHfbeN5aLKxHHFad2u71TyxMzYESBBbCghYAViiGDvu73MEvnz19+uTzweC+
JQzH2UDvwIFhPWkMB6Njk3MUrYDSbiWqVaIIiuo0g9GQb3EIthTzJY1K7fV6/wM=
  `),
  compressedGrayFixture(`
LZJ5aFsFAMabNldz9fUl7+V4fU3TpM2dNFfTpF16pceW3teaNG2T9EiTnrmb95L3mt7bqhOmf4gKingwFRkMRP9wXitzQ/zH
oiATlcEYwwNlw21a7cAffP998H18fEVF/0MJfXb19ILB/3HogN2Xe3Gg6Jtr/e+ixPCOh0JhcgEA4J2IShUWJJAQhgFWMbWY
yqQzaHR+WRG3jF5JoxRTiooZTCbK0Yc2L3z49s667yME4ZeiQhSCAFY5jcZg0jhsrkqSvlLM6BktpVAMjiaNuMpYK4NrKiCw
7GnC8cPHTw4PD2/dunnz5qO/n5zwGGyso50apHIoiMvWXgOLxRKBBIYhgAOUl5cfH/97/O3R0dHX168f+p88/OfRgwdlEMCX
OinFdd0NOqVSKEIQMSITIyIpelKcxqRSqQwen0+nUukMJptdxuHyAbm0utLc0qLV2+qtUmmtSquvqjCIxMK2tpKSEgaDRecL
QDqdxmSVMjk8LljtlCnPOLXaHoPFwIeFIgloFYnlElQqlZ74S1hshtwGMuh0HofDq7fz2JUyHaLWNRmMCw16kP8UKyoSIWXl
1dXFJSVsNottVGkZDJ5ADFYANaBCKxRolFZ0OrXSaALAV0CQrzeYlWmpFEVPBmdz2WykVqZgcVQaHQKBBkt1jUbmqhlrXh86
1dSgaVSr4At7B1s7RzCK0mhUFoNXhmpkBoBb1WE1aew6ndGkN3o6Oxr7PPbOHo/Nbqr789dffnsoqZXL6WxeKVAOCtVmPSqQ
Wuq1CoPTbmswWazmlkFvT39Hu9vtHm2OzYfDPquztRXmixiAABIoFXxAOhxJbSfx9eUu28rQaF6hMRWsEa3NNeY4/den+9+7
608PDvIgEcwXSARiDVEY3slhWKS/eW7qfIEskCqVeLJe242vDzj6zLCtl8Pv7uycGW70zGcz2QxBkASRX3aRZCHr2MplsQZ7
bC8P4/kcjiV9jQqdyuKenp4OhUbX1lKr8cLWBoanU2fM9sT2FiqW7p3bIHNbZJLI480dmYlmm1pn6vJPTU3MhfwjDWbHUiqL
k+QWiRUKhZ39CpEX393YIFzkBr6bTZML7XcsSqmm0+mMhKOLyykins1mc8TuDoZjGGFyQFBsb/cikcM2ycRb3qlx97333hke
mIiurgZno6vx1djuXHY/eNBkIwub0T382dWFfB7Lz4RTyYWuiy9jByN1PnNoJhicnAzMz85H42uJIZ3ZcZ7YWc+8RhCJXcwf
WQ/Gzqnr9QrlV7P75z3Oy7dnQ6HlmZnAxGxkce/sSmINW5o/h+XJS9H44lp+Je6yGGvb+4cymee9V29cfUnzRjAU8nq9I2PB
YHhgZS2XTMS3I9HUTGwi3eGwGLQydySJp2Pxjp7RD25c/uGZP2YCk36/f3w8GJhfnFsbGcmFYwvzaaNZr1HL7f2LMZyIpQNz
8YQn/Cr5Qlf488lJ3+Dw8OjIRHdrwBsKjC/2NRkN6ppb73/yeiZ/KTqWxpOJpczSuPW7567d+f3HdXzzbF9vb29Xf+foUKi3
zqBSymXVLV3O2hqVCpVXopVy9UogsjS5/ebt+/d+cn/RoYK6h4bMyV6xRAJBleKTd3p8/jmRBOZKQCHAq0BE46tTp9xnf757
9/7dK57Q9peenh5ZFYKgKNze6Ovzef0JhVOD5FxolbICPUFp6m536A9ckL65QWMZdLe1tf0H
  `),
]);

// 최근 archive에서 gate를 잘못 연 실제 gameplay와 로딩 화면이다.
const GAMEPLAY_HUD_FALSE_POSITIVE_FIXTURE = compressedGrayFixture(`
ddJRb9tEAMBx8cQmgWDZRoLbJXYcp87SlU7L2qRpk6xrazvxNWk7qJqNskkbUxkLaxzajqTXFIbi1LOby7J485iQ4AEJ2AdA
e2EvvPDCCxISDKQygSqBVO1hCDEJdLabhSL+D/ZJ9zv7ZN+uZz3dR9XkF16WYRgmGAwGGYahjywumc3Pl8urrFXEvA4Hd9/+
+E7k3p5/eZr2+WYtDwMWH/98Ft+e3v2Cx18U4X6WJElfm8fLmQvzgv30AaFy5izLsl32chZ70m+qJ96c8O0972DB3lMfnPok
EBhOHfDTXxaPW97G9sj2tItwJKHnzuvvpWWZdx2qVM/NPRcwPdXyNE0zTJfpGbfb7b/Uf/mCOFGtymb4WyyWvDu9vdOXle9l
EHi3fNbWsnwZLygUCgVd15t6uZNq8x6LzJVfa3EZtvntmgsLg11MZRtFBwfxEEK4am9oh9cLhaUleWfQqoYQEjiOT85Udf16
03z+E1+VK1fenjs5PT093eaTHMcBAK4hnAgEQSiW4P+EyVXLr7f8aLFoTy//8GnZGq0McSf8EC7X6/U6PzYmiuKrmENRFPjF
0oqFJtMgPhxPtb+A4zhOVdWZbHam0dBv3JjJaqogmG9+fyqTEuPhdFr4r1/IZrO2V7f99Ul+HAwMgGMTEEKlzWuqqr1RLOr6
LcNYXjYMAEx/PsUnetij/f2DlbW1mu3fAgDcNAyjVCqZvoS9COEVhOLJkYOZscOh0IiGUKZ/6HY4EomEQ6FQJPpmyzebjQZC
NVhHCHGjsXSsN9w7clfTDlAkhU8mSRBEp9eLGo2GrhvGLezr6wjVELoP+L674SOJY31I02ia9OIFtNesbvsPgQgAALXZladY
YTwl//TjxtBAt6Gqbsp33I2Pr+WvNfEvEAFILuXz+Yu53K4eeTMDHjzY+HkzFkcITRzmz03SOAIHAODXFRyUJEnK5YA2+tLB
tYcPt+Y3YxGE0En6EIU1RRBEB+UpFBTlqqK8c0ZRsM/n8kCIfvXtxit//NromEUIxahuivZ6PXb5NUUZ7us9nY1GT+QlSbp0
EYz9nVjd+u3R7/dJVw0h0k2SHZ5WkqJEE2J6KgO4RDiMd5R87HT+eW/rl6+f8e/7DCHHvuetHLg9p0NUB/Gip5PYTxDOHm5q
Svrrscv1nfPRNx8RhMPpcv0D
`);

const LOADING_FALSE_POSITIVE_FIXTURE = compressedGrayFixture(`
JZNJj9t0HIbH/8XL33bi7HHiJHa8O4mXLPYkzuZBBYnPwJdA4sIRcUAqB04gjrQH4FAJpAohsd6QiopGhaqlgk6ZlnZURGfS
sEnAAWV4pN/t0U/v4X2Vfr1kynW5KTebzVa7o3V1XdPUrmWaju15zsAfJ34YjKMoDMNQ00ocYTgi8Pxb7Zba1R3HtmzbHgS1
QTQaj4f7i9koisbD4XA8StZLw6hcvEgI+fCbF3dvNdN2nF4wHE/iIB6NJ3EcT5Nkkuzvp2ma7qcLy6rXd0HaHV3v6o7b6/mD
YDSMSCxNRtMkTna3ny7mq9V8la0z02wpiqK0u4Zh2LZXC6IdQwhgPS8Np+l8Pk/TdLZcZ6vFKssyTeu0Wy1Vo40gjHxYFoJz
VM8vE7Xk2PvT+XI5nWfZMl0szn2tq+m6TguaNxh0Yt73gzAM1SitiXylXQjiyTiWl7M0XWcHBweZYXR12zQMhqELg0DzxlEU
jUbjdmPYFHOSmx8n0WTeJnkreybLsvWBaZqW67h9VhSlPtc0k1GtXDWDQrkoFbVcWapEY9xISLE0Tebz1WqtqpZpe16fEfMC
N9RrBXtUC0U+3+DbQqXIC+WxJIcJKdRzaW+xXCzbbct2+75PWJHwhsGTphcRpVrx2iWg+jIpjQx9EPNVWQzj5SI70HXPdfp9
P8/yIqvKIs/0QLWMUV5mtYlUIZ0qbv514aUrN8lzvy2ezdaq6rhePwiqZTEvVAkmnFZleZGiKOTuoUYxxwkXjm5cvXd8594n
83m6aLctx3EHfiBIeV2jMUOxCO5BDBBFUZDTsVQSLz84Pvrp/mEynaWpoli2ZTuux7EFCbMYUVCEVEVir/TgCsUEIxoePzi+
/+DeyeeNzmwmy7rpOG5vwDA5sVDhEIUZQHEMTdF5wAwJR8OLjx+dnjx8dPfWbDYbNBqu5XvJoM8NUKHJ0BTFSDQihM8zfLMu
MAQh8vrR8dEP33/w2mQ26SmKHji64/SqCsSUwAFcplkGsYTrwqI0zfEYL7/ePD47u/vZtWHkmIrScBzPcW2bohHmBSTVq1ig
eUzJAJBqINKAXP7p9pNfv/tqEtrWzlc6/qDXL4AcRoQgCEUW0oQVZQgA17EEdP2FN04+PTt5/pbt2GGn09F0y+m5CBBMGA5B
JEt7NEcKNY4GELeY3MvvcYX3r8J33mWZ/VRVJ0kcTQAFGBFhzCIIcsIeR1iMJQECGnL8R9cvPb5/69VXvvibmcTdbquuKggA
wLAYYBoCQEsUS3Ae7bIhwIj/bN8+vHG4PTu9ZOwWLjdbEAAAKAggwAwGmKdYRMNCUYQVmubz24df3vnz9unml0O9p9brbhec
Q9EYY/h/E9gchohDFCC8+OPPf7z59Olm+2T7e11RymUfAggBoCh4DoYQUqwgciwpshjT3sN/n55+e3q2/XizKdSUajUUEIQA
oZ1L7XzMQUQ4ntA8wxPSPNxe29zcbrfXNhuWrjQa/wE=
`);

// 천리문 alert는 절기와 비슷한 중앙 stripe를 만들지만 하단 확인행이 없다.
const SKILL_MODAL_LOOKALIKE_FIXTURE = compressedGrayFixture(`
bdTNax5FHMBxUJvd2Z19dmb2fWbf52Vn9nkSnuSJbYovBEXwFhQ9iCfx5tk/IU+LYP8Aj4LnXLwIgsSDJYptHtNKqB6sSDFg
a7R4V/ZJRa35Xuby4ccPZhgSDIUkZOV5FfmyoiiQG/gIIUwIOcJxTNW5tbENgLWiOG+aNEgxPrp6ZT6/Ot/dvXL3PF+nBcvz
QjZ1o0XlQcjng92d785tAABw4AgT7HkOADawAYAOhJCksszKpuVBVfHBLrOdIeD86xiFoTtK65RWvKo1533b8qHijRd4h4cQ
TpAfYIQRwhhD3x95Pqwb3WjZ1OOLcTx98z3OV8tcqJxRxnjDadVIWkvK8txzkY8w0l1RsrJuJuMsEz3nvCoVV1JKKdYmY7WW
xyHTYiLkKPEjHydK8UleNVzQIKh6XwjexVxpraczk6YxjRMaj2eMM8dxHWBDpXjBOG/rBKFWCiEEF0IZM5nRKkvrppZ1qSll
Yy+IaalKpThLo5GTkTxPX46bRoiaK2NMnlERxnGSZGmaJlEIL1iORxyluOu4zihyk+T5z9e2/6SXD4TSem2dPl2ShNa8H8uK
JcRdsYHrAaVq7FuAEDdN8+N3xbLOdNN1lnfoUYQQDK0V23FA10GQZn6FHEJ49Ox8ux18bzY20pwuseMsbwBatmW7n3SdEIhg
n7sISdkpeTbfrI8LpgOCEcYIER9j17Js1zvpB29bQniuy3nLH/nNjSJnEiPy/tsY7+x4GFv2UyeL67981glBXLpcOxwaRa8/
EaYJ9Gq5dvYShpeBPvxi7+DOt/e+ut4JAZ9cThVBGEborddWI5ZAl61vbXeN2GgvbbVbdab3fzr4+s7hYqGF56yI/ybNZlZX
YnVazkx/+VIpM6qddnF8+5vFYSfxCnjMKz2VaZWVlVFal6xsXzLa/vLmd4dHx4uxJJZ8zAs9LpLcFMzMpjMpjNFa2+/c3vvj
++OFac7xvemr9pmOPSeYrrOBG3vrh/sPf//oRh8iS/zfGyo384KxvuVGa2MMBObax3ufXtMEJOf5QbG8u7gxGbQxHr534+aD
/VcFseS06gdVZXlNqySO4/SstskyWrVFEFCmfjy59crJ6f028BllGVRK5UnKWBxFUZScBaHrug6ELgBW9/Nif+fw9PTu9IId
Jc2Lbdv+89V0XccLhEhgIxvYy/xbD3774PT04a8W/3vrvwA=
`);

test("48x27 gray frame 크기를 고정한다", () => {
  assert.equal(FRAME_WIDTH, 48);
  assert.equal(FRAME_HEIGHT, 27);
  assert.equal(FRAME_BYTES, 1_296);
});

test("어두운 가로 UI title은 화면 좌우 어느 위치에서도 찾는다", () => {
  for (const frame of [titleFrame({ x: 2 }), titleFrame({ x: 26, y: 18 })]) {
    const result = analyzeGrayFrame(frame);
    assert.equal(result.uiCandidate, true);
    assert.equal(result.reason, "candidate");
    assert.equal(result.features.candidateKind, "text_panel");
    assert.ok(result.features.titleContrast >= 42);
    assert.equal(Object.hasOwn(result, "frame"), false);
    assert.equal(Object.hasOwn(result.features, "raw"), false);
  }
});

test("밝은 gameplay와 전체 암전은 거부한다", () => {
  const bright = analyzeGrayFrame(solid(200));
  assert.equal(bright.uiCandidate, false);
  assert.equal(bright.reason, "frame_too_flat");

  const black = analyzeGrayFrame(solid(0));
  assert.equal(black.uiCandidate, false);
  assert.equal(black.reason, "frame_too_dark");
  assert.equal(black.features.overallDarkRatio, 1);
});

test("inventory와 강화형 패널은 위치와 폭이 달라도 찾는다", () => {
  const narrow = analyzeGrayFrame(panelFrame({ x: 3, y: 2 }));
  assert.equal(narrow.uiCandidate, true);
  assert.equal(narrow.features.candidateKind, "panel");
  assert.ok(narrow.features.panelRect.width < 19);

  const wide = analyzeGrayFrame(panelFrame({ x: 18, y: 10, width: 25, height: 12 }));
  assert.equal(wide.uiCandidate, true);
  assert.equal(wide.features.candidateKind, "panel");
  assert.ok(wide.features.panelRect.width >= 19);
});

test("실제 정보·강화·수량 dark overlay는 OCR 후보로 통과한다", () => {
  for (const fixture of DARK_OVERLAY_FIXTURES) {
    const result = analyzeGrayFrame(fixture.frame);
    assert.equal(result.uiCandidate, true, fixture.name);
    assert.equal(result.reason, "candidate", fixture.name);
    assert.equal(
      result.features.candidateKind,
      fixture.expectedKind || "dark_overlay",
      fixture.name,
    );
  }
});

test("첨부 절기 배분창의 6행 stripe는 OCR 후보로 통과한다", () => {
  const result = analyzeGrayFrame(ATTACHED_SKILL_PANEL_FIXTURE);
  assert.equal(result.uiCandidate, true);
  assert.equal(result.reason, "candidate");
  assert.equal(result.features.candidateKind, "skill_panel");
});

test("P031 보관 절기 frame도 OCR 후보로 통과한다", () => {
  const result = analyzeGrayFrame(P031_SKILL_PANEL_FIXTURE);
  assert.equal(result.uiCandidate, true);
  assert.equal(result.reason, "candidate");
  assert.equal(result.features.candidateKind, "skill_panel");
});

test("밝은 방송의 절기 배분창도 전용 OCR 후보로 통과한다", () => {
  const result = analyzeGrayFrame(BRIGHT_SKILL_PANEL_FIXTURE);
  assert.equal(result.uiCandidate, true);
  assert.equal(result.reason, "candidate");
  assert.equal(result.features.candidateKind, "skill_panel");
});

test("9행 절기창에 tooltip과 방송 overlay가 겹쳐도 전용 OCR 후보로 통과한다", () => {
  const result = analyzeGrayFrame(MIXED_SKILL_PANEL_FIXTURE);
  assert.equal(result.uiCandidate, true);
  assert.equal(result.reason, "candidate");
  assert.equal(result.features.candidateKind, "skill_panel");
});

test("왼쪽으로 밀린 장비 강화창의 하단 title도 OCR 후보로 통과한다", () => {
  const result = analyzeGrayFrame(OFFSET_ENHANCEMENT_PANEL_FIXTURE);
  assert.equal(result.uiCandidate, true);
  assert.equal(result.reason, "candidate");
  assert.equal(result.features.candidateKind, "enhancement_panel");
});

test("실제 기량 사분면과 중앙 십자 구조는 전용 OCR 후보로 통과한다", () => {
  const result = analyzeGrayFrame(APTITUDE_PANEL_FIXTURE);
  assert.equal(result.uiCandidate, true);
  assert.equal(result.reason, "candidate");
  assert.equal(result.features.candidateKind, "aptitude_panel");
});

test("천리문 alert의 가짜 stripe는 절기 후보로 승격하지 않는다", () => {
  const result = analyzeGrayFrame(SKILL_MODAL_LOOKALIKE_FIXTURE);
  assert.notEqual(result.features.candidateKind, "skill_panel");
});

test("P014 gameplay의 균일한 바닥은 강화 버튼으로 오인하지 않는다", () => {
  for (const fixture of ENHANCEMENT_GAMEPLAY_FALSE_POSITIVE_FIXTURES) {
    const result = analyzeGrayFrame(fixture);
    assert.equal(result.uiCandidate, false);
    assert.equal(result.reason, "no_local_ui_pattern");
    assert.equal(result.features.candidateKind, null);
  }
});

test("P029 상단 sheet·광고·inset 합성 방송은 game panel로 오인하지 않는다", () => {
  for (const fixture of BROADCAST_COMPOSITE_FALSE_POSITIVE_FIXTURES) {
    const result = analyzeGrayFrame(fixture);
    assert.equal(result.uiCandidate, false);
    assert.equal(result.reason, "no_local_ui_pattern");
    assert.equal(result.features.candidateKind, null);
  }
});

test("실제 gameplay HUD와 로딩 화면은 burst 후보에서 제외한다", () => {
  for (const fixture of [GAMEPLAY_HUD_FALSE_POSITIVE_FIXTURE, LOADING_FALSE_POSITIVE_FIXTURE]) {
    const result = analyzeGrayFrame(fixture);
    assert.equal(result.uiCandidate, false);
    assert.equal(result.reason, "no_local_ui_pattern");
    assert.equal(result.features.candidateKind, null);
  }
});

test("사망 dim, 로딩, 불규칙 gameplay object는 패널로 오인하지 않는다", () => {
  for (const frame of [deathOverlayFrame(), loadingFrame(), loadingSplashFrame(), gameplayObjectFrame()]) {
    const result = analyzeGrayFrame(frame);
    assert.equal(result.uiCandidate, false);
    assert.notEqual(result.reason, "candidate");
    assert.equal(result.features.candidateKind, null);
  }

  const flatDark = analyzeGrayFrame(solid(50), { maxOverallDarkRatio: 1 });
  assert.equal(flatDark.uiCandidate, false);
  assert.equal(flatDark.reason, "frame_too_flat");
});

test("고분산 저조도 loading splash guard는 실제 panel 조건과 별도로 작동한다", () => {
  const splash = loadingSplashFrame();
  const guarded = analyzeGrayFrame(splash);
  assert.equal(guarded.uiCandidate, false);
  assert.ok(guarded.features.overallMean < 48);
  assert.ok(guarded.features.lumaStdDev > 30);

  const unguarded = analyzeGrayFrame(splash, { minHighVariancePanelMean: 0 });
  assert.equal(unguarded.uiCandidate, true);
  assert.equal(unguarded.features.candidateKind, "panel");
});

test("짧거나 여러 프레임이 섞인 입력은 단일 frame 분석에서 거부한다", () => {
  const short = analyzeGrayFrame(solid(10).subarray(0, FRAME_BYTES - 1));
  assert.equal(short.uiCandidate, false);
  assert.equal(short.reason, "short_frame");
  assert.equal(short.features.receivedBytes, FRAME_BYTES - 1);
  assert.equal(short.features.titleContrast, null);

  const oversized = analyzeGrayFrame(Buffer.alloc(FRAME_BYTES + 1));
  assert.equal(oversized.uiCandidate, false);
  assert.equal(oversized.reason, "invalid_frame_size");
});

test("threshold를 조정할 수 있고 잘못된 값과 오타는 즉시 거부한다", () => {
  const frame = titleFrame();
  assert.equal(analyzeGrayFrame(frame).uiCandidate, true);
  const strict = analyzeGrayFrame(frame, { minTitleContrast: 100 });
  assert.equal(strict.uiCandidate, false);
  assert.equal(strict.reason, "no_local_ui_pattern");

  for (const thresholds of [
    { minTitleDarkRatio: 1.1 },
    { darkPixelMax: 64.5 },
    { edgeDelta: 256 },
    { minLumaStdDev: 256 },
    { minBrightRowColumnRatio: 17 },
    { smoothDelta: 21, edgeDelta: 20 },
    { minBrightMean: 150, maxBrightMean: 100 },
    { minTitleContrst: 10 },
  ]) {
    assert.throws(
      () => analyzeGrayFrame(frame, thresholds),
      error => error instanceof SamgukUiGateError && error.code === "invalid_config",
    );
  }

  assert.equal(createSamgukUiGate({ minTitleContrast: 50 }).getState()
    .thresholds.minTitleContrast, 50);
  assert.throws(
    () => createSamgukUiGate({ thresholds: {}, minTitleContrast: 50 }),
    error => error.code === "invalid_config",
  );
  assert.throws(
    () => createGrayFrameParser({ maxBufferdBytes: FRAME_BYTES }),
    error => error.code === "invalid_config",
  );
});

test("parser는 임의 chunk 경계에서도 frame 순서를 정확히 복원한다", () => {
  const sums = [];
  const parser = createGrayFrameParser({
    onFrame: frame => sums.push(frame.reduce((sum, pixel) => sum + pixel, 0)),
  });
  const stream = Buffer.concat([solid(3), solid(7), solid(11)]);
  const cuts = [1, 17, FRAME_BYTES - 5, FRAME_BYTES + 33, stream.length];
  let start = 0;
  let parsed = 0;
  for (const end of cuts) {
    parsed += parser.push(stream.subarray(start, end)).framesParsed;
    start = end;
  }

  assert.equal(parsed, 3);
  assert.deepEqual(sums, [3, 7, 11].map(value => value * FRAME_BYTES));
  assert.equal(parser.getState().bufferedBytes, 0);
  assert.equal(parser.getState().totalBytes, stream.length);
});

test("큰 chunk도 한 frame 크기 buffer 상한 안에서 처리한다", () => {
  let count = 0;
  const parser = createGrayFrameParser({
    maxBufferedBytes: FRAME_BYTES,
    onFrame: () => { count += 1; },
  });
  const state = parser.push(Buffer.alloc(FRAME_BYTES * 100, 90));
  assert.equal(count, 100);
  assert.equal(state.totalFrames, 100);
  assert.ok(state.bufferedBytes <= state.maxBufferedBytes);
  assert.equal(state.maxBufferedBytes, FRAME_BYTES);

  assert.throws(
    () => createGrayFrameParser({ maxBufferedBytes: FRAME_BYTES - 1 }),
    error => error.code === "invalid_config",
  );
});

test("통합 gate는 완성 frame의 feature 결과만 내고 partial은 end에서 거부한다", () => {
  const observed = [];
  const gate = createSamgukUiGate({ onResult: result => observed.push(result) });
  const candidate = titleFrame();
  assert.deepEqual(gate.push(candidate.subarray(0, 333)), []);
  const completed = gate.push(candidate.subarray(333));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].uiCandidate, true);
  assert.equal(gate.getState().bufferedBytes, 0);

  assert.deepEqual(gate.push(Buffer.alloc(23, 200)), []);
  const final = gate.end();
  assert.equal(final.length, 1);
  assert.equal(final[0].reason, "short_frame");
  assert.equal(final[0].features.receivedBytes, 23);
  assert.deepEqual(observed, [completed[0], final[0]]);

  const visible = JSON.stringify({ completed, final, state: gate.getState() });
  assert.equal(visible.includes(candidate.toString("hex")), false);
});

test("parser는 byte가 아닌 chunk와 종료 뒤 입력을 거부하며 reset 후 재사용된다", () => {
  const parser = createGrayFrameParser();
  assert.throws(
    () => parser.push("not-bytes"),
    error => error.code === "invalid_chunk",
  );
  parser.push(Buffer.alloc(10));
  assert.equal(parser.end().discardedBytes, 10);
  assert.throws(
    () => parser.push(Buffer.alloc(1)),
    error => error.code === "parser_ended",
  );
  assert.equal(parser.reset().ended, false);
  assert.equal(parser.push(solid(1)).framesParsed, 1);
});
