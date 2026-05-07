from __future__ import annotations

from app import audit


def setup_function() -> None:
    audit.clear()


def test_record_appends_and_recent_returns_newest_first() -> None:
    audit.record("guest.restart", actor="alice", vmid=100)
    audit.record("guest.restart", actor="bob", vmid=200)
    events = audit.recent()
    assert len(events) == 2
    assert events[0]["actor"] == "bob"
    assert events[1]["actor"] == "alice"
    assert all("ts" in e for e in events)


def test_recent_respects_limit() -> None:
    for i in range(10):
        audit.record("evt", i=i)
    assert len(audit.recent(limit=3)) == 3


def test_buffer_caps_at_max_size() -> None:
    for i in range(audit._BUFFER_SIZE + 50):
        audit.record("evt", i=i)
    events = audit.recent(limit=999)
    # Returns only the buffer size, oldest dropped.
    assert len(events) == audit._BUFFER_SIZE
    # Newest first means highest i first
    assert events[0]["i"] == audit._BUFFER_SIZE + 49
