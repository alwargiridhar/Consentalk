"""Consentalk iteration-4 backend feature tests.

Covers:
- Owner force-exit (/rooms/{id}/leave) permanently closes room (status='ended'),
  wipes db.messages, creates forensic fragments, and prior phrase+pin no longer
  summonable.
- Non-owner force-exit (/rooms/{id}/end) wipes session messages, broadcasts
  WS {type:'ended', by_name}, room remains 'active'.
- Read-receipt WS auto-wipe with TWO websocket clients: sender (A) sees
  {type:'deleted', message_id} when reader (B) marks the message read.
"""
import asyncio
import json
import uuid
import pytest
import requests
import websockets

BASE_URL = "https://intent-space-1.preview.emergentagent.com"
WS_BASE = BASE_URL.replace("https://", "wss://").replace("http://", "ws://")


def auth(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


def _create_room_with(user_a, user_b, mongo, phrase, pin, name="TEST_iter4"):
    r = requests.post(
        f"{BASE_URL}/api/rooms/create",
        json={"name": name, "phrase": phrase, "pin": pin},
        headers=auth(user_a["session_token"]),
    )
    assert r.status_code == 200, r.text
    rid = r.json()["room_id"]
    # Add B as member directly so we don't depend on invite flow
    mongo.rooms.update_one({"room_id": rid}, {"$addToSet": {"members": user_b["user_id"]}})
    return rid


async def _connect(rid, token):
    url = f"{WS_BASE}/api/ws/room/{rid}?token={token}"
    return await websockets.connect(url, max_size=1024 * 1024)


async def _drain_until(ws, type_match, timeout=5.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        remaining = deadline - asyncio.get_event_loop().time()
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            return None
        try:
            payload = json.loads(raw)
        except Exception:
            continue
        if payload.get("type") == type_match:
            return payload
    return None


# ---------- Owner force-exit closes room permanently ----------
class TestOwnerLeavePermanentClose:
    """Iteration-4: owner /leave sets status='ended' and is no longer summonable."""

    def test_owner_leave_sets_status_ended_and_wipes(self, user_a, user_b, mongo):
        phrase = f"phrase {uuid.uuid4().hex[:6]} owner end"
        pin = "9911"
        rid = _create_room_with(user_a, user_b, mongo, phrase, pin, name="TEST_owner_leave")
        # Send a message so we can verify wipe
        m = requests.post(
            f"{BASE_URL}/api/rooms/{rid}/messages",
            json={"content_type": "text", "content": "hello before close"},
            headers=auth(user_a["session_token"]),
        )
        assert m.status_code == 200, m.text
        # Pre-condition
        assert mongo.messages.count_documents({"room_id": rid}) >= 1

        # Owner force-exits via /leave
        r = requests.post(
            f"{BASE_URL}/api/rooms/{rid}/leave",
            json={}, headers=auth(user_a["session_token"]),
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True and body.get("owner") is True

        # Room marked ended and messages wiped
        room_doc = mongo.rooms.find_one({"room_id": rid})
        assert room_doc is not None
        assert room_doc.get("status") == "ended", f"status was {room_doc.get('status')}"
        assert room_doc.get("session_active") is False
        assert mongo.messages.count_documents({"room_id": rid}) == 0
        # Forensic fragments created
        assert mongo.forensic_fragments.count_documents({"room_id": rid}) >= 1

        # Subsequent summon by owner with same phrase+pin returns NO rooms
        sm = requests.post(
            f"{BASE_URL}/api/rooms/summon",
            json={"phrase": phrase, "pin": pin},
            headers=auth(user_a["session_token"]),
        )
        assert sm.status_code == 200
        rooms = sm.json().get("rooms", [])
        assert all(rr.get("room_id") != rid for rr in rooms), \
            f"ended room should not be summonable: got {rooms}"


# ---------- Non-owner force-exit wipes via /end but keeps status active ----------
@pytest.mark.asyncio
class TestNonOwnerEndWipes:
    async def test_non_owner_end_wipes_messages_and_broadcasts(self, user_a, user_b, mongo):
        phrase = f"phrase {uuid.uuid4().hex[:6]} nonowner end"
        rid = _create_room_with(user_a, user_b, mongo, phrase, "8822", name="TEST_nonowner_end")
        # Send a message
        m = requests.post(
            f"{BASE_URL}/api/rooms/{rid}/messages",
            json={"content_type": "text", "content": "to be wiped by non-owner"},
            headers=auth(user_a["session_token"]),
        )
        assert m.status_code == 200
        assert mongo.messages.count_documents({"room_id": rid}) >= 1

        # Owner A connects via WS — should see 'ended' broadcast when B ends
        ws_a = await _connect(rid, user_a["session_token"])
        try:
            await asyncio.sleep(0.3)  # drain presence
            # Non-owner B calls /end
            r = requests.post(
                f"{BASE_URL}/api/rooms/{rid}/end",
                json={}, headers=auth(user_b["session_token"]),
            )
            assert r.status_code == 200, r.text
            ev = await _drain_until(ws_a, "ended", timeout=5.0)
            assert ev is not None, "owner did not receive 'ended' WS event"
            assert ev.get("by_name") == user_b["name"]

            # Messages wiped
            assert mongo.messages.count_documents({"room_id": rid}) == 0
            # Room status still 'active' (or unset, which means default not 'ended')
            room_doc = mongo.rooms.find_one({"room_id": rid})
            assert room_doc.get("status") != "ended", \
                f"non-owner /end should not flip status to ended; got {room_doc.get('status')}"
            assert room_doc.get("session_active") is False
        finally:
            await ws_a.close()


# ---------- Read-receipt WS auto-wipe with TWO clients ----------
@pytest.mark.asyncio
class TestReadReceiptWsBroadcast:
    async def test_sender_receives_deleted_event_when_reader_marks_read(
        self, user_a, user_b, mongo
    ):
        phrase = f"phrase {uuid.uuid4().hex[:6]} read wipe"
        rid = _create_room_with(user_a, user_b, mongo, phrase, "7733", name="TEST_read_wipe")

        # Connect both WS clients FIRST
        ws_a = await _connect(rid, user_a["session_token"])
        ws_b = await _connect(rid, user_b["session_token"])
        try:
            await asyncio.sleep(0.3)  # drain presence frames

            # A sends a message
            m = requests.post(
                f"{BASE_URL}/api/rooms/{rid}/messages",
                json={"content_type": "text", "content": "please read me"},
                headers=auth(user_a["session_token"]),
            )
            assert m.status_code == 200
            mid = m.json()["message_id"]

            # B should receive 'message' event
            msg_ev = await _drain_until(ws_b, "message", timeout=5.0)
            assert msg_ev is not None, "B did not get 'message' WS event"
            assert msg_ev.get("message", {}).get("message_id") == mid

            # B marks read
            r = requests.post(
                f"{BASE_URL}/api/rooms/{rid}/messages/{mid}/read",
                json={}, headers=auth(user_b["session_token"]),
            )
            assert r.status_code == 200, r.text

            # Sender A should receive {type:'deleted', message_id}
            del_ev = await _drain_until(ws_a, "deleted", timeout=5.0)
            assert del_ev is not None, "sender A did not get 'deleted' WS event"
            assert del_ev.get("message_id") == mid

            # DB confirms message wiped
            assert mongo.messages.count_documents({"message_id": mid}) == 0
        finally:
            await ws_a.close()
            await ws_b.close()
