import pytest

from hub.envelope import build_request, error_envelope, parse_envelope


def test_roundtrip_plain():
    raw = build_request("md-stats", {"source_path": "inbox/a.md"}, dry_run=True)
    assert '"md-stats"' in raw


def test_action_mirrored_from_inputs():
    import json as _json

    raw = _json.loads(
        build_request("md-stats", {"action": "dedupe", "source_path": "a.md"})
    )
    assert raw["action"] == "dedupe"          # mirrored into the envelope
    assert raw["inputs"]["action"] == "dedupe"  # and still visible in inputs


def test_action_defaults_to_run():
    import json as _json

    raw = _json.loads(build_request("md-stats", {"source_path": "a.md"}))
    assert raw["action"] == "run"


def test_parse_plain_envelope():
    raw = '{"status": "success", "summary": "ok", "data": {"a": 1}}'
    env = parse_envelope(raw)
    assert env["status"] == "success"
    assert env["artifacts"] == []
    assert env["warnings"] == []


def test_parse_fenced_json():
    raw = '```json\n{"status": "success", "summary": "done"}\n```'
    assert parse_envelope(raw)["status"] == "success"


def test_parse_chatter_then_json():
    raw = 'I analyzed the note. Here is my result:\n{"status": "success", "summary": "verdict", "data": {"x": 1}}\nThanks!'
    env = parse_envelope(raw)
    assert env["data"]["x"] == 1


def test_parse_invalid_raises():
    with pytest.raises(ValueError):
        parse_envelope("no json at all")
    with pytest.raises(ValueError):
        parse_envelope("")
    with pytest.raises(ValueError):
        parse_envelope('{"no_status_key": true}')


def test_error_envelope_shape():
    env = error_envelope("boom")
    assert env == {
        "v": 1,
        "status": "error",
        "summary": "boom",
        "data": {},
        "artifacts": [],
        "warnings": [],
    }


def test_version_stamped_on_request_and_response():
    import json as _json

    request = _json.loads(build_request("md-stats", {}))
    assert request["v"] == 1

    env = parse_envelope('{"status": "success"}')
    assert env["v"] == 1  # hub stamps it; never taken from skill output
