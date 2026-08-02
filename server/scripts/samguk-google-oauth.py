#!/usr/bin/env python3
"""Issue a dedicated, least-scope OAuth refresh token for the Samguk Sheet writer."""

import argparse
import http.server
import json
import os
import pathlib
import stat
import subprocess
import tempfile
import time
import webbrowser

from google_auth_oauthlib.flow import InstalledAppFlow


SCOPE = "https://www.googleapis.com/auth/spreadsheets"


def private_regular_file(path: pathlib.Path, *, must_exist: bool) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        if must_exist:
            raise ValueError(f"파일이 없습니다: {path}")
        return
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise ValueError(f"일반 파일만 사용할 수 있습니다: {path}")
    if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        raise ValueError(f"현재 사용자 소유의 0600 파일이어야 합니다: {path}")


class ChromeProfileBrowser(webbrowser.BaseBrowser):
    def __init__(self, executable: str, profile: str):
        self.executable = executable
        self.profile = profile

    def open(self, url: str, new: int = 0, autoraise: bool = True) -> bool:
        del new, autoraise
        subprocess.Popen(
            [self.executable, f"--profile-directory={self.profile}", url],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True


def write_private_json(path: pathlib.Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def receive_credentials(flow: InstalledAppFlow, timeout_seconds: int, login_hint: str):
    callback = {}

    class CallbackHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, _format: str, *args) -> None:
            del args

        def do_GET(self) -> None:
            query = self.path.partition("?")[2]
            if "code=" in query or "error=" in query:
                callback["url"] = f"http://127.0.0.1:{server.server_port}{self.path}"
                message = "SOOPNOTICE 삼국지 Google 권한 응답을 받았습니다. 이 창을 닫아도 됩니다."
            else:
                message = "Google 권한 응답을 기다리고 있습니다."
            body = message.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.HTTPServer(("127.0.0.1", 0), CallbackHandler)
    server.timeout = 1
    try:
        flow.redirect_uri = f"http://127.0.0.1:{server.server_port}/"
        auth_url, _ = flow.authorization_url(
            access_type="offline",
            prompt="consent",
            include_granted_scopes="false",
            login_hint=login_hint,
        )
        webbrowser.open(auth_url, new=1, autoraise=True)
        deadline = time.monotonic() + timeout_seconds
        while "url" not in callback and time.monotonic() < deadline:
            server.handle_request()
        if "url" not in callback:
            raise TimeoutError("Google OAuth 승인을 기다리다 시간이 초과되었습니다.")
        flow.fetch_token(authorization_response=callback["url"].replace("http://", "https://", 1))
        return flow.credentials
    finally:
        server.server_close()


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="SOOPNOTICE 삼국지 Google Sheets OAuth 연결")
    parser.add_argument("--client-secret", required=True, type=pathlib.Path)
    parser.add_argument("--token", required=True, type=pathlib.Path)
    parser.add_argument("--browser", default="/opt/google/chrome/google-chrome")
    parser.add_argument("--profile", default="Profile 2")
    parser.add_argument("--account-index", type=int, default=0)
    parser.add_argument("--timeout-seconds", type=int, default=240)
    return parser.parse_args()


def chrome_profile_login_hint(profile: str, account_index: int = 0) -> str:
    preferences = pathlib.Path.home() / ".config" / "google-chrome" / profile / "Preferences"
    try:
        payload = json.loads(preferences.read_text(encoding="utf-8"))
        accounts = payload.get("account_info") or []
        email = accounts[account_index].get("email") if 0 <= account_index < len(accounts) else None
    except (OSError, ValueError, TypeError, AttributeError):
        email = None
    if not isinstance(email, str) or not email or len(email) > 254 or any(ord(char) < 33 for char in email):
        raise ValueError("선택한 Chrome profile의 Google 계정을 확인하지 못했습니다.")
    return email


def main() -> None:
    args = parse_arguments()
    client_secret = args.client_secret.expanduser().resolve()
    token_path = args.token.expanduser().resolve()
    private_regular_file(client_secret, must_exist=True)
    private_regular_file(token_path, must_exist=False)
    if token_path.exists():
        raise ValueError(f"기존 token 파일을 덮어쓰지 않습니다: {token_path}")
    if not os.path.isfile(args.browser) or not os.access(args.browser, os.X_OK):
        raise ValueError("Chrome 실행 파일을 확인할 수 없습니다.")
    if not 60 <= args.timeout_seconds <= 600:
        raise ValueError("timeout은 60~600초여야 합니다.")
    if not 0 <= args.account_index <= 9:
        raise ValueError("account-index는 0~9여야 합니다.")

    webbrowser.register(
        "samguk-google-chrome",
        None,
        ChromeProfileBrowser(args.browser, args.profile),
        preferred=True,
    )
    flow = InstalledAppFlow.from_client_secrets_file(
        str(client_secret),
        scopes=[SCOPE],
        autogenerate_code_verifier=True,
    )
    credentials = receive_credentials(
        flow,
        args.timeout_seconds,
        chrome_profile_login_hint(args.profile, args.account_index),
    )
    if not credentials.refresh_token:
        raise RuntimeError("Google이 refresh token을 반환하지 않았습니다.")
    granted_scopes = set(credentials.granted_scopes or credentials.scopes or [])
    if granted_scopes != {SCOPE}:
        raise RuntimeError("요청하지 않은 Google OAuth scope가 포함되어 발급을 중단했습니다.")
    write_private_json(token_path, {
        "version": 1,
        "client_id": credentials.client_id,
        "client_secret": credentials.client_secret,
        "refresh_token": credentials.refresh_token,
        "scope": SCOPE,
        "token_uri": "https://oauth2.googleapis.com/token",
    })
    print(json.dumps({"ok": True, "tokenPath": str(token_path), "scope": SCOPE}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        safe_message = str(error) if isinstance(error, (ValueError, RuntimeError, TimeoutError)) else "Google OAuth 연결에 실패했습니다."
        print(json.dumps({"ok": False, "error": type(error).__name__, "message": safe_message}, ensure_ascii=False))
        raise SystemExit(1)
