"""Iteration 9 — retention dropdown + history-on-mount + wipe + sweeper tests.

Covers:
- Primary bug fix: history persistence — A sends 3 messages while B offline,
  B comes back and GETs /api/rooms/{id}/messages returns all 3.
- POST /api/rooms/create accepts retention_mode (default 10min, invalid -> 10min).
- PATCH /api/rooms/{id}/settings owner-only with retention_mode.
- POST /api/rooms/{id}/wipe (any member).
- mark_message_read sets delete_at for 5/10/15-min modes, NOT for on_refresh.
- Background sweeper deletes messages whose delete_at <= now within ~30s.
"""

import time
import uuid
import requests
import pytest
from datetime import datetime, timezone, timedelta

from conftest import auth_headers, BASE_URL

API = f"{BASE_URL}/api"


# --------------------------- helpers ---------------------------

def _create_room(owner, phrase=None, retention_mode=None, security_mode="light", pin=None):
    payload = {
        "name": f"TEST iter9 {uuid.uuid4().hex[:4]}",
        "phrase": phrase or f"TEST iter9 phrase {uuid.uuid4().hex[:8]}",
        "room_type": "duo",
        "security_mode": security_mode,
    }
    if retention_mode is not None:
        payload["retention_mode"] = retention_mode
    if security_mode == "deep":
        payload["pin"] = pin or "1234"
    r = requests.post(f"{API}/rooms/create", headers=auth_headers(owner), json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def _add_member(mongo, room_id, user_id):
    mongo.rooms.update_one({"room_id": room_id}, {"$addToSet": {"members": user_id}})


def _send_message(user, room_id, text):
    r = requests.post(
        f"{API}/rooms/{room_id}/messages",
        headers=auth_headers(user),
        json={"content_type": "text", "content": text},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _list_messages(user, room_id):
    r = requests.get(f"{API}/rooms/{room_id}/messages", headers=auth_headers(user))
    assert r.status_code == 200, r.text
    return r.json()["messages"]


# --------------------------- PRIMARY BUG FIX ---------------------------

class TestHistoryPersistence:
    """B disconnected while A sends 3 messages → on reconnect B sees all 3."""

    def test_history_returned_for_late_reader(self, user_a, user_b, mongo):
        room = _create_room(user_a, retention_mode="on_refresh")  # avoid auto-delete
        room_id = room["room_id"]
        _add_member(mongo, room_id, user_b["user_id"])
        try:
            _send_message(user_a, room_id, "TEST_msg_1")
            _send_message(user_a, room_id, "TEST_msg_2")
            _send_message(user_a, room_id, "TEST_msg_3")
            # B reconnects → GET /messages must return all 3 in order
            msgs = _list_messages(user_b, room_id)
            texts = [m["content"] for m in msgs]
            assert texts == ["TEST_msg_1", "TEST_msg_2", "TEST_msg_3"], texts
        finally:
            mongo.rooms.delete_one({"room_id": room_id})
            mongo.messages.delete_many({"room_id": room_id})


# --------------------------- CREATE ROOM RETENTION ---------------------------

class TestCreateRoomRetention:
    def test_default_is_10min(self, user_a, mongo):
        room = _create_room(user_a)  # no retention_mode supplied
        try:
            assert room["retention_mode"] == "10min", room
            doc = mongo.rooms.find_one({"room_id": room["room_id"]})
            assert doc["retention_mode"] == "10min"
        finally:
            mongo.rooms.delete_one({"room_id": room["room_id"]})

    @pytest.mark.parametrize("mode", ["5min", "10min", "15min", "on_refresh"])
    def test_each_valid_mode(self, user_a, mongo, mode):
        room = _create_room(user_a, retention_mode=mode)
        try:
            assert room["retention_mode"] == mode
        finally:
            mongo.rooms.delete_one({"room_id": room["room_id"]})

    def test_invalid_falls_back_to_10min(self, user_a, mongo):
        room = _create_room(user_a, retention_mode="bogus_mode")
        try:
            assert room["retention_mode"] == "10min"
            doc = mongo.rooms.find_one({"room_id": room["room_id"]})
            assert doc["retention_mode"] == "10min"
        finally:
            mongo.rooms.delete_one({"room_id": room["room_id"]})


# --------------------------- PATCH SETTINGS ---------------------------

class TestPatchSettings:
    def test_owner_can_change_retention(self, user_a, mongo):
        room = _create_room(user_a, retention_mode="10min")
        rid = room["room_id"]
        try:
            r = requests.patch(
                f"{API}/rooms/{rid}/settings",
                headers=auth_headers(user_a),
                json={"retention_mode": "5min"},
            )
            assert r.status_code == 200, r.text
            assert r.json()["retention_mode"] == "5min"
            assert mongo.rooms.find_one({"room_id": rid})["retention_mode"] == "5min"
        finally:
            mongo.rooms.delete_one({"room_id": rid})

    def test_non_owner_forbidden(self, user_a, user_b, mongo):
        room = _create_room(user_a, retention_mode="10min")
        rid = room["room_id"]
        _add_member(mongo, rid, user_b["user_id"])
        try:
            r = requests.patch(
                f"{API}/rooms/{rid}/settings",
                headers=auth_headers(user_b),
                json={"retention_mode": "5min"},
            )
            assert r.status_code == 403, r.text
            assert mongo.rooms.find_one({"room_id": rid})["retention_mode"] == "10min"
        finally:
            mongo.rooms.delete_one({"room_id": rid})

    def test_invalid_mode_rejected(self, user_a, mongo):
        room = _create_room(user_a)
        rid = room["room_id"]
        try:
            r = requests.patch(
                f"{API}/rooms/{rid}/settings",
                headers=auth_headers(user_a),
                json={"retention_mode": "bogus"},
            )
            assert r.status_code == 400
        finally:
            mongo.rooms.delete_one({"room_id": rid})


# --------------------------- WIPE ENDPOINT ---------------------------

class TestWipe:
    def test_any_member_can_wipe(self, user_a, user_b, mongo):
        room = _create_room(user_a, retention_mode="on_refresh")
        rid = room["room_id"]
        _add_member(mongo, rid, user_b["user_id"])
        try:
            _send_message(user_a, rid, "TEST_keep_1")
            _send_message(user_a, rid, "TEST_keep_2")
            assert len(_list_messages(user_a, rid)) == 2

            # B (non-owner member) can wipe
            r = requests.post(f"{API}/rooms/{rid}/wipe", headers=auth_headers(user_b))
            assert r.status_code == 200, r.text
            assert r.json()["ok"] is True
            assert len(_list_messages(user_a, rid)) == 0
            assert mongo.messages.count_documents({"room_id": rid}) == 0
        finally:
            mongo.rooms.delete_one({"room_id": rid})
            mongo.messages.delete_many({"room_id": rid})

    def test_non_member_cannot_wipe(self, user_a, user_b, mongo):
        # user_b is NOT a member
        room = _create_room(user_a, retention_mode="on_refresh")
        rid = room["room_id"]
        try:
            _send_message(user_a, rid, "TEST_msg")
            r = requests.post(f"{API}/rooms/{rid}/wipe", headers=auth_headers(user_b))
            assert r.status_code == 404, r.text
            assert mongo.messages.count_documents({"room_id": rid}) == 1
        finally:
            mongo.rooms.delete_one({"room_id": rid})
            mongo.messages.delete_many({"room_id": rid})


# --------------------------- MARK_READ / RETENTION SCHEDULING ---------------------------

class TestMarkReadScheduling:
    @pytest.mark.parametrize("mode,minutes", [("5min", 5), ("10min", 10), ("15min", 15)])
    def test_time_modes_set_delete_at(self, user_a, user_b, mongo, mode, minutes):
        room = _create_room(user_a, retention_mode=mode)
        rid = room["room_id"]
        _add_member(mongo, rid, user_b["user_id"])
        try:
            msg = _send_message(user_a, rid, f"TEST_{mode}_msg")
            mid = msg["message_id"]
            t0 = datetime.now(timezone.utc)
            r = requests.post(
                f"{API}/rooms/{rid}/messages/{mid}/read",
                headers=auth_headers(user_b),
            )
            assert r.status_code == 200, r.text
            doc = mongo.messages.find_one({"message_id": mid})
            assert doc is not None, "message must NOT yet be deleted"
            assert "delete_at" in doc and doc["delete_at"] is not None
            delete_at = doc["delete_at"]
            if delete_at.tzinfo is None:
                delete_at = delete_at.replace(tzinfo=timezone.utc)
            expected = t0 + timedelta(minutes=minutes)
            # tolerance ±30s
            assert abs((delete_at - expected).total_seconds()) < 30, (delete_at, expected)
        finally:
            mongo.rooms.delete_one({"room_id": rid})
            mongo.messages.delete_many({"room_id": rid})

    def test_on_refresh_does_not_schedule(self, user_a, user_b, mongo):
        room = _create_room(user_a, retention_mode="on_refresh")
        rid = room["room_id"]
        _add_member(mongo, rid, user_b["user_id"])
        try:
            msg = _send_message(user_a, rid, "TEST_on_refresh_msg")
            mid = msg["message_id"]
            r = requests.post(
                f"{API}/rooms/{rid}/messages/{mid}/read",
                headers=auth_headers(user_b),
            )
            assert r.status_code == 200, r.text
            doc = mongo.messages.find_one({"message_id": mid})
            assert doc is not None
            assert doc.get("delete_at") is None, doc.get("delete_at")
            assert user_b["user_id"] in (doc.get("read_by") or [])
        finally:
            mongo.rooms.delete_one({"room_id": rid})
            mongo.messages.delete_many({"room_id": rid})


# --------------------------- BACKGROUND SWEEPER ---------------------------

class TestRetentionSweeper:
    """Insert a message with delete_at in the past, wait up to ~35s, confirm gone."""

    def test_sweeper_deletes_past_due_messages(self, user_a, mongo):
        room = _create_room(user_a, retention_mode="5min")
        rid = room["room_id"]
        try:
            mid = f"msg_TEST_{uuid.uuid4().hex[:10]}"
            mongo.messages.insert_one({
                "message_id": mid,
                "room_id": rid,
                "sender_user_id": user_a["user_id"],
                "sender_name": user_a["name"],
                "content_type": "text",
                "content": "TEST_sweep_me",
                "created_at": datetime.now(timezone.utc) - timedelta(minutes=10),
                "delete_at": datetime.now(timezone.utc) - timedelta(seconds=1),
                "read_by": [],
            })
            assert mongo.messages.find_one({"message_id": mid}) is not None
            # Sweeper runs every 30s — give it up to 40s to fire.
            deadline = time.time() + 40
            while time.time() < deadline:
                doc = mongo.messages.find_one({"message_id": mid})
                if doc is None:
                    break
                time.sleep(2)
            doc = mongo.messages.find_one({"message_id": mid})
            assert doc is None, "background sweeper did not delete past-due message in 40s"
        finally:
            mongo.rooms.delete_one({"room_id": rid})
            mongo.messages.delete_many({"room_id": rid})
