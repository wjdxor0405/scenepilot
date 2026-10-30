"""The Android wrapper: its web copy is built from the unchanged web UI, and the server's CORS switch works."""
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scenepilot.app import add_cors

ROOT = Path(__file__).parent.parent
APP = ROOT / "android-app"
WEB = ROOT / "src" / "scenepilot" / "static"
needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def build_www(*args: str, api_base: str | None = None) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "SCENEPILOT_API_BASE"}
    if api_base is not None:
        env["SCENEPILOT_API_BASE"] = api_base
    return subprocess.run(["node", "build-www.mjs", *args], cwd=APP, capture_output=True, text=True, encoding="utf-8", timeout=60, env=env)


def app_config() -> dict:
    """capacitor.config.js as the Capacitor CLI would read it after the last build."""
    run = subprocess.run(["node", "-e", "console.log(JSON.stringify(require('./capacitor.config.js')))"],
                         cwd=APP, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


@needs_node
def test_www_is_built_from_the_web_ui_with_only_app_additions():
    run = build_www(api_base="https://example.test/")
    assert run.returncode == 0, run.stderr + run.stdout
    www = APP / "www"
    loaded = re.findall(r'(?:src|href)="/static/([^"]+)"', (WEB / "index.html").read_text(encoding="utf-8"))
    assert {"app.js", "speech.js", "watch.js", "style.css"} <= set(loaded)
    for name in loaded:
        assert (www / name).read_bytes() == (WEB / name).read_bytes(), f"{name} must be copied unchanged"
    html = (www / "index.html").read_text(encoding="utf-8")
    assert "/static/" not in html and 'src="./app.js"' in html
    for name in re.findall(r'(?:src|href)="\./([^"]+)"', html):
        assert (www / name).is_file(), f"the app's index.html loads {name}, which is missing from www/"
    assert html.index("app-config.js") < html.index("api-shim.js") < html.index("geo.js")
    assert html.index("speech.js") < html.index("native-speech.js") < html.index("native-tts.js") < html.index("app.js")
    assert html.index("app.js") < html.index("native-back.js")
    assert (www / "app-config.js").read_text(encoding="utf-8").strip() == 'window.SCENEPILOT_API_BASE = "https://example.test";'
    assert app_config()["android"]["allowMixedContent"] is False, "an https server needs no mixed content"


@needs_node
def test_http_server_builds_allow_mixed_content_and_release_builds_need_https():
    assert build_www(api_base="http://192.168.0.20:8000").returncode == 0
    assert app_config()["android"]["allowMixedContent"] is True

    for api_base in (None, "", "http://192.168.0.20:8000"):
        run = build_www("--release", api_base=api_base)
        assert run.returncode != 0 and "https://" in run.stderr, api_base
    run = build_www("--release", api_base="https://demo.example.test")
    assert run.returncode == 0, run.stderr
    assert json.loads((APP / "www" / "build.json").read_text(encoding="utf-8")) == {"apiBase": "https://demo.example.test", "release": True}
    assert app_config()["android"]["allowMixedContent"] is False


def test_android_manifest_declares_the_permissions_the_app_uses():
    manifest = (APP / "android" / "app" / "src" / "main" / "AndroidManifest.xml").read_text(encoding="utf-8")
    assert "android.intent.action.TTS_SERVICE" in manifest, "without it Android 11+ hides the speech engines and the app is silent"
    for permission in ("INTERNET", "RECORD_AUDIO", "ACCESS_FINE_LOCATION", "CAMERA"):
        assert f"android.permission.{permission}" in manifest
    assert "android.speech.RecognitionService" in manifest
    assert 'android:allowBackup="false"' in manifest


def test_cleartext_http_is_allowed_in_debug_builds_only():
    main = (APP / "android" / "app" / "src" / "main" / "AndroidManifest.xml").read_text(encoding="utf-8")
    debug = (APP / "android" / "app" / "src" / "debug" / "AndroidManifest.xml").read_text(encoding="utf-8")
    assert "usesCleartextTraffic" not in main
    assert 'android:usesCleartextTraffic="true"' in debug


def test_screen_stays_on_and_the_back_button_plugin_is_wired_in():
    activity = (APP / "android" / "app" / "src" / "main" / "java" / "com" / "scenepilot" / "app" / "MainActivity.java").read_text(encoding="utf-8")
    assert "FLAG_KEEP_SCREEN_ON" in activity
    assert "@capacitor/app" in json.loads((APP / "package.json").read_text(encoding="utf-8"))["dependencies"]
    assert "capacitor-app" in (APP / "android" / "capacitor.settings.gradle").read_text(encoding="utf-8")


@needs_node
def test_back_button_closes_what_is_open_and_never_ends_the_app():
    run = subprocess.run(["node", str(Path(__file__).parent / "native_back_check.js")], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert run.returncode == 0, run.stderr + run.stdout
    assert "native back checks passed" in run.stdout


def test_cors_is_off_by_default_and_opt_in_per_origin():
    plain = FastAPI()
    add_cors(plain, ())
    plain.get("/x")(lambda: {"ok": True})
    assert "access-control-allow-origin" not in TestClient(plain).get("/x", headers={"Origin": "https://localhost"}).headers

    open_for_app = FastAPI()
    add_cors(open_for_app, ("https://localhost",))
    open_for_app.get("/x")(lambda: {"ok": True})
    client = TestClient(open_for_app)
    assert client.get("/x", headers={"Origin": "https://localhost"}).headers["access-control-allow-origin"] == "https://localhost"
    assert "access-control-allow-origin" not in client.get("/x", headers={"Origin": "https://evil.test"}).headers


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_native_speech_adapter_with_a_fake_android_plugin():
    run = subprocess.run(["node", str(Path(__file__).parent / "native_speech_check.js")], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert run.returncode == 0, run.stderr + run.stdout
    assert "native speech checks passed" in run.stdout


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_native_tts_shim_reports_the_end_and_stays_quiet_when_cancelled():
    run = subprocess.run(["node", str(Path(__file__).parent / "native_tts_check.js")], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert run.returncode == 0, run.stderr + run.stdout
    assert "native tts checks passed" in run.stdout
