"""Consentalk iteration-2 feature tests.

Covers: phone OTP request/verify, /profile/verify gating, invite-by-phone,
/rooms/{id}/leave (owner vs non-owner), /messages/{id}/read auto-delete,
/users/{id} basic info access control, /rooms/{id}/end WS broadcast,
WS screenshot_request/response relay.
"""
import os
import asyncio
import json
import uuid
import pytest
import requests
import websockets
from datetime import datetime, timezone, timedelta

BASE_URL = "https://intent-space-1.preview.emergentagent.com"
WS_BASE = BASE_URL.replace("https://", "wss://").replace("http://", "ws://")


def auth(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


# ---------- Phone OTP ----------
class TestPhoneOtp:
    def test_request_otp_returns_dev_code(self, api, user_a):
        r = api.post(f"{BASE_URL}/api/profile/phone/request-otp",
                     json={"phone": "+15553334444"},
                     headers=auth(user_a["session_token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert body.get("mocked") is True
        code = body.get("dev_code")
        assert code and len(code) == 6 and code.isdigit()

    def test_request_otp_short_phone(self, api, user_a):
        r = api.post(f"{BASE_URL}/api/profile/phone/request-otp",
                     json={"phone": "12345"},
                     headers=auth(user_a["session_token"]))
        assert r.status_code == 400

    def test_verify_otp_wrong_code(self, api, user_a):
        phone = "+15558887777"
        r1 = api.post(f"{BASE_URL}/api/profile/phone/request-otp",
                      json={"phone": phone}, headers=auth(user_a["session_token"]))
        assert r1.status_code == 200
        r2 = api.post(f"{BASE_URL}/api/profile/phone/verify-otp",
                      json={"phone": phone, "code": "000000"},
                      headers=auth(user_a["session_token"]))
        # could match by chance but extremely unlikely
        assert r2.status_code == 400
        assert "Incorrect" in r2.text or "OTP" in r2.text

    def test_verify_otp_correct_code(self, api, user_a):
        phone = "+15559990000"
        r1 = api.post(f"{BASE_URL}/api/profile/phone/request-otp",
                      json={"phone": phone}, headers=auth(user_a["session_token"]))
        code = r1.json()["dev_code"]
        r2 = api.post(f"{BASE_URL}/api/profile/phone/verify-otp",
                      json={"phone": phone, "code": code},
                      headers=auth(user_a["session_token"]))
        assert r2.status_code == 200, r2.text
        assert r2.json()["ok"] is True

    def test_verify_otp_no_request(self, api, user_b):
        r = api.post(f"{BASE_URL}/api/profile/phone/verify-otp",
                     json={"phone": "+19990001111", "code": "123456"},
                     headers=auth(user_b["session_token"]))
        assert r.status_code == 404

    def test_verify_otp_expired(self, api, user_a, mongo):
        phone = "+15551110000"
        r1 = api.post(f"{BASE_URL}/api/profile/phone/request-otp",
                      json={"phone": phone}, headers=auth(user_a["session_token"]))
        code = r1.json()["dev_code"]
        # backdate
        mongo.phone_otps.update_one(
            {"user_id": user_a["user_id"], "phone": phone},
            {"$set": {"expires_at": datetime.now(timezone.utc) - timedelta(minutes=1)}},
        )
        r2 = api.post(f"{BASE_URL}/api/profile/phone/verify-otp",
                      json={"phone": phone, "code": code},
                      headers=auth(user_a["session_token"]))
        assert r2.status_code == 400
        assert "expired" in r2.text.lower() or "OTP" in r2.text


# ---------- Invite by phone ----------
class TestInviteByPhone:
    def test_invite_neither_email_nor_phone_400(self, api, user_a):
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_inv_x", "phrase": "phone invite phrase", "pin": "1212"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        r2 = api.post(f"{BASE_URL}/api/rooms/{rid}/invite",
                      json={}, headers=auth(user_a["session_token"]))
        assert r2.status_code == 400

    def test_invite_by_phone_links_to_verified_user(self, api, user_a, user_b, mongo):
        # Mark user_b as verified with a phone in verification_data
        bphone = f"+1555{uuid.uuid4().int % 10000000:07d}"
        mongo.users.update_one(
            {"user_id": user_b["user_id"]},
            {"$set": {"verified": True,
                      "verification_data": {"phone": bphone, "country": "US",
                                            "full_legal_name": "B", "date_of_birth": "1990-01-01"}}},
        )
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_inv_p", "phrase": "phone link phrase", "pin": "9090"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        r2 = api.post(f"{BASE_URL}/api/rooms/{rid}/invite",
                      json={"phone": bphone},
                      headers=auth(user_a["session_token"]))
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body.get("invitation_id")
        # b's invitation list must include this invitation (matched by phone)
        r3 = api.get(f"{BASE_URL}/api/rooms/invitations",
                     headers=auth(user_b["session_token"]))
        assert r3.status_code == 200
        invs = r3.json()["invitations"]
        assert any(i["invitation_id"] == body["invitation_id"] for i in invs)


# ---------- /rooms/{id}/leave ----------
class TestLeaveRoom:
    def test_non_owner_leave_removes_from_members(self, api, user_a, user_b, mongo):
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_leave1", "phrase": "leave non-owner phrase", "pin": "4444"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        # add b as member
        mongo.rooms.update_one({"room_id": rid}, {"$addToSet": {"members": user_b["user_id"]}})
        r2 = api.post(f"{BASE_URL}/api/rooms/{rid}/leave",
                      json={}, headers=auth(user_b["session_token"]))
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body.get("ok") is True
        assert body.get("owner") is False
        room = mongo.rooms.find_one({"room_id": rid})
        assert user_b["user_id"] not in room.get("members", [])
        # owner still present
        assert user_a["user_id"] in room.get("members", [])

    def test_owner_leave_closes_and_wipes(self, api, user_a, mongo):
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_leave2", "phrase": "leave owner phrase", "pin": "5151"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        # send a message
        api.post(f"{BASE_URL}/api/rooms/{rid}/messages",
                 json={"content_type": "text", "content": "to be wiped"},
                 headers=auth(user_a["session_token"]))
        assert mongo.messages.count_documents({"room_id": rid}) == 1
        r2 = api.post(f"{BASE_URL}/api/rooms/{rid}/leave",
                      json={}, headers=auth(user_a["session_token"]))
        assert r2.status_code == 200
        assert r2.json().get("owner") is True
        room = mongo.rooms.find_one({"room_id": rid})
        assert room.get("status") == "ended"
        assert room.get("session_active") is False
        assert mongo.messages.count_documents({"room_id": rid}) == 0
        assert mongo.forensic_fragments.count_documents({"room_id": rid}) >= 1

    def test_leave_non_member_404(self, api, user_a, user_b):
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_leave3", "phrase": "leave 404 phrase", "pin": "3131"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        r2 = api.post(f"{BASE_URL}/api/rooms/{rid}/leave",
                      json={}, headers=auth(user_b["session_token"]))
        assert r2.status_code == 404


# ---------- /messages/{id}/read ----------
class TestReadReceipts:
    def test_sender_read_returns_self(self, api, user_a, user_b, mongo):
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_read1", "phrase": "read receipt phrase one", "pin": "7777"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        mongo.rooms.update_one({"room_id": rid}, {"$addToSet": {"members": user_b["user_id"]}})
        msg = api.post(f"{BASE_URL}/api/rooms/{rid}/messages",
                       json={"content_type": "text", "content": "hi"},
                       headers=auth(user_a["session_token"])).json()
        mid = msg["message_id"]
        r2 = api.post(f"{BASE_URL}/api/rooms/{rid}/messages/{mid}/read",
                      json={}, headers=auth(user_a["session_token"]))
        assert r2.status_code == 200
        assert r2.json().get("self") is True
        # message still exists
        assert mongo.messages.count_documents({"message_id": mid}) == 1

    def test_all_others_read_deletes_message(self, api, user_a, user_b, mongo):
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_read2", "phrase": "read receipt phrase two", "pin": "8181"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        mongo.rooms.update_one({"room_id": rid}, {"$addToSet": {"members": user_b["user_id"]}})
        msg = api.post(f"{BASE_URL}/api/rooms/{rid}/messages",
                       json={"content_type": "text", "content": "delete me"},
                       headers=auth(user_a["session_token"])).json()
        mid = msg["message_id"]
        # only one OTHER member: user_b. b reads => should delete.
        r2 = api.post(f"{BASE_URL}/api/rooms/{rid}/messages/{mid}/read",
                      json={}, headers=auth(user_b["session_token"]))
        assert r2.status_code == 200
        assert mongo.messages.count_documents({"message_id": mid}) == 0


# ---------- /users/{id} basic info ----------
class TestUserBasicInfo:
    def test_user_info_in_shared_room(self, api, user_a, user_b, mongo):
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_uinfo", "phrase": "shared room phrase here", "pin": "2424"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        mongo.rooms.update_one({"room_id": rid}, {"$addToSet": {"members": user_b["user_id"]}})
        # a fetches b
        r2 = api.get(f"{BASE_URL}/api/users/{user_b['user_id']}",
                     headers=auth(user_a["session_token"]))
        assert r2.status_code == 200, r2.text
        body = r2.json()
        assert body["user_id"] == user_b["user_id"]
        assert body["name"] == user_b["name"]
        assert "verified" in body

    def test_user_info_country_only_when_verified(self, api, user_a, user_b, mongo):
        # ensure a shared room
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_uinfo2", "phrase": "country gate phrase", "pin": "3535"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        mongo.rooms.update_one({"room_id": rid}, {"$addToSet": {"members": user_b["user_id"]}})
        # set b unverified with country
        mongo.users.update_one({"user_id": user_b["user_id"]},
                               {"$set": {"verified": False,
                                         "verification_data": {"country": "United States", "phone": "x"}}})
        r2 = api.get(f"{BASE_URL}/api/users/{user_b['user_id']}",
                     headers=auth(user_a["session_token"]))
        assert r2.status_code == 200
        assert r2.json().get("country") is None
        # verify b
        mongo.users.update_one({"user_id": user_b["user_id"]}, {"$set": {"verified": True}})
        r3 = api.get(f"{BASE_URL}/api/users/{user_b['user_id']}",
                     headers=auth(user_a["session_token"]))
        assert r3.json().get("country") == "United States"

    def test_user_info_no_shared_room_403(self, api, user_a, mongo):
        # create fresh isolated user
        target_id = f"user_{uuid.uuid4().hex[:12]}"
        mongo.users.insert_one({
            "user_id": target_id, "email": f"TEST_iso_{uuid.uuid4().hex[:6]}@x.com",
            "name": "Iso", "picture": None, "role": "user", "verified": False,
            "verification_data": None, "risk_score": 0, "status": "active",
            "created_at": datetime.now(timezone.utc),
        })
        try:
            r = api.get(f"{BASE_URL}/api/users/{target_id}",
                        headers=auth(user_a["session_token"]))
            assert r.status_code == 403
        finally:
            mongo.users.delete_one({"user_id": target_id})


# ---------- WS broadcast: end + screenshot ----------
@pytest.mark.asyncio
class TestWebSocketBroadcasts:
    async def _connect(self, room_id, token):
        url = f"{WS_BASE}/api/ws/room/{room_id}?token={token}"
        return await websockets.connect(url, max_size=1024 * 1024)

    async def _drain_until(self, ws, type_match, timeout=5.0):
        """Read frames until we get one whose 'type' equals type_match."""
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

    async def test_end_room_broadcasts_ended(self, user_a, user_b, mongo):
        # fresh room with both members
        s = requests.Session()
        s.headers.update(auth(user_a["session_token"]))
        r = s.post(f"{BASE_URL}/api/rooms/create",
                   json={"name": "TEST_ws_end", "phrase": "ws end phrase here", "pin": "1313"})
        rid = r.json()["room_id"]
        mongo.rooms.update_one({"room_id": rid}, {"$addToSet": {"members": user_b["user_id"]}})
        ws_b = await self._connect(rid, user_b["session_token"])
        try:
            # drain initial presence frames
            await asyncio.sleep(0.3)
            # owner ends
            r2 = requests.post(f"{BASE_URL}/api/rooms/{rid}/end",
                               json={}, headers=auth(user_a["session_token"]))
            assert r2.status_code == 200
            ev = await self._drain_until(ws_b, "ended", timeout=5.0)
            assert ev is not None, "B did not receive 'ended' event"
            assert ev.get("by_name") == user_a["name"]
        finally:
            await ws_b.close()

    async def test_screenshot_request_response_relay(self, user_a, user_b, mongo):
        s = requests.Session()
        s.headers.update(auth(user_a["session_token"]))
        r = s.post(f"{BASE_URL}/api/rooms/create",
                   json={"name": "TEST_ws_ss", "phrase": "ws screenshot phrase", "pin": "1414"})
        rid = r.json()["room_id"]
        mongo.rooms.update_one({"room_id": rid}, {"$addToSet": {"members": user_b["user_id"]}})
        ws_a = await self._connect(rid, user_a["session_token"])
        ws_b = await self._connect(rid, user_b["session_token"])
        try:
            await asyncio.sleep(0.3)
            req_id = f"req_{uuid.uuid4().hex[:6]}"
            await ws_a.send(json.dumps({"type": "screenshot_request", "request_id": req_id}))
            ev = await self._drain_until(ws_b, "screenshot_request", timeout=5.0)
            assert ev is not None
            assert ev.get("request_id") == req_id
            assert ev.get("user_id") == user_a["user_id"]
            # b responds allow
            await ws_b.send(json.dumps({"type": "screenshot_response",
                                         "request_id": req_id, "allow": True}))
            ev2 = await self._drain_until(ws_a, "screenshot_response", timeout=5.0)
            assert ev2 is not None
            assert ev2.get("allow") is True
            assert ev2.get("request_id") == req_id
        finally:
            await ws_a.close()
            await ws_b.close()
