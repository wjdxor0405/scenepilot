"""The Android app runs the first steps (start, consent, safety questions, emergency notice) on the phone.

These tests hold it to the server: the same answers must give the same screens, and replaying what the phone recorded
must leave the server in the same state, so the server can take over from there."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from scenepilot.app import app
from scenepilot.emergency import parse_alternatives, parse_answer

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import export_local_rules  # noqa: E402

import test_emergency  # noqa: E402  (its parse_answer cases are reused here)

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

PHRASES = [tuple(case[:2]) for case in test_emergency.test_parse_answer.pytestmark[0].args[1]] + [
    ("know", "danger"), ("nah", "movable"), ("now", "danger"), ("there's smoke but nobody is hurt", "danger"),
    ("No, it won't move", "movable"), ("a kid on a bike", "danger"), ("I think so", "movable"),
]
ALTERNATIVES = [
    (["node", "gnome", "no", "nope"], "danger"), (["node", "gnome"], "danger"), (["no", "yes"], "danger"),
    (["nobody is hurt", "somebody is hurt"], "danger"), (["yes I can move it", "yes"], "movable"),
]


def ans(text, alternatives=None):
    return {"path": "/safety-answer", "body": {"answer": text, **({"alternatives": alternatives} if alternatives else {})}}


CONSENT = {"path": "/consent", "body": {}}
ACK = {"path": "/ack-emergency", "body": {}}
SCENARIOS = [
    [CONSENT, ans("No"), ans("Yes")],                                         # standard
    [CONSENT, ans("nobody is hurt"), ans("I can't move it")],                 # caution
    [CONSENT, ans("no"), ans("maybe")],                                       # unsure about moving
    [CONSENT, ans("yes"), ACK],                                               # emergency
    [CONSENT, ans("I'm not sure")],                                           # unsure counts as danger
    [CONSENT, ans("whatever"), ans("banana")],                                # not understood twice: unsure
    [CONSENT, ans("whatever"), ans("no"), ans("purple"), ans("yes")],         # one retry on each question
    [CONSENT, ans("node", ["gnome", "no"]), ans("yes", ["no"])],              # the recognizer's other guesses
    [CONSENT, ACK, ans("no"), CONSENT],                                       # steps in the wrong stage are refused
    [],                                                                       # consent not given yet
]


def without_ids(view: dict) -> dict:
    view = json.loads(json.dumps(view))
    if "session" in view:
        view["session"].pop("id", None)
        view["session"].pop("created_at", None)
    return view


@pytest.fixture(scope="module")
def phone():
    payload = json.dumps({"phrases": PHRASES, "alternatives": ALTERNATIVES, "scenarios": SCENARIOS})
    run = subprocess.run(["node", str(Path(__file__).parent / "local_first_check.js")], input=payload,
                         capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert run.returncode == 0, run.stderr + run.stdout
    return json.loads(run.stdout)


def test_exported_rules_are_up_to_date():
    # Line endings may change on checkout (core.autocrlf on Windows); the content may not.
    current = (ROOT / "android-app" / "native" / "local-rules.js").read_text(encoding="utf-8").replace("\r\n", "\n")
    assert current == export_local_rules.render(export_local_rules.build()), "run: uv run python tools/export_local_rules.py"


def test_phone_understands_answers_like_the_server(phone):
    for (text, qid), got in zip(PHRASES, phone["phrases"]):
        expected = parse_answer(text, qid)
        assert got == (expected.value if expected else None), (text, qid)
    for (texts, qid), got in zip(ALTERNATIVES, phone["alternatives"]):
        expected = parse_alternatives(texts, qid)
        assert got == (expected.value if expected else None), (texts, qid)


@pytest.mark.parametrize("index", range(len(SCENARIOS)))
def test_phone_gives_the_same_screens_as_the_server(phone, index):
    client = TestClient(app)
    server = [client.post("/api/sessions", json={"country": "US"})]
    sid = server[0].json()["session"]["id"]
    for step in SCENARIOS[index]:
        server.append(client.post(f"/api/sessions/{sid}{step['path']}", json=step["body"]))
    server.append(client.get(f"/api/sessions/{sid}"))

    local = phone["scenarios"][index]["responses"][: len(server)]
    for i, (s, p) in enumerate(zip(server, local)):
        assert p["status"] == s.status_code, (i, p["body"], s.json())
        assert without_ids(p["body"]) == without_ids(s.json()), i


@pytest.mark.parametrize("index", range(len(SCENARIOS)))
def test_replaying_the_phone_leaves_the_server_in_the_same_state(phone, index):
    result = phone["scenarios"][index]
    assert result["offline_status"] == 503, "a server-only step without a connection is refused, not lost"
    replay = result["replay"]
    assert replay[0]["method"] == "POST" and replay[0]["path"] == "/api/sessions"

    client = TestClient(app)
    sid = client.post("/api/sessions", json=replay[0]["body"]).json()["session"]["id"]
    for request in replay[1:]:
        assert request["path"].startswith("/api/sessions/srv1/")
        res = client.post(request["path"].replace("srv1", sid), json=request["body"])
        assert res.status_code == 200, request
    local_final = result["responses"][len(SCENARIOS[index]) + 1]["body"]   # the phone's own view before the hand-over
    assert without_ids(client.get(f"/api/sessions/{sid}").json()) == without_ids(local_final)
    assert result["forwarded"] == "/api/sessions/srv1/goto", "after the hand-over, requests use the server's session"
