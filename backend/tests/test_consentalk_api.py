"""Consentalk backend tests - core flows"""
import os
import io
import uuid
import pytest
import requests
from datetime import datetime, timezone, timedelta

BASE_URL = "https://intent-space-1.preview.emergentagent.com"


# ---------- Health ----------
def test_root_health(api):
    r = api.get(f"{BASE_URL}/api/")
    assert r.status_code == 200
    body = r.json()
    assert body.get("app") == "Consentalk"
    assert "tagline" in body


# ---------- Auth ----------
def test_auth_session_invalid(api):
    r = api.post(f"{BASE_URL}/api/auth/session", json={"session_id": "definitely-bad-id"})
    assert r.status_code in (400, 401, 502), f"got {r.status_code}: {r.text}"


def test_auth_session_empty(api):
    r = api.post(f"{BASE_URL}/api/auth/session", json={"session_id": ""})
    assert r.status_code == 400


def test_auth_me_unauth(api):
    r = api.get(f"{BASE_URL}/api/auth/me")
    assert r.status_code == 401


def test_auth_me_with_bearer(api, user_a):
    r = api.get(f"{BASE_URL}/api/auth/me",
                headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200
    data = r.json()
    assert data["user_id"] == user_a["user_id"]
    assert data["email"] == user_a["email"]
    assert data["role"] == "user"


# ---------- Profile/Verify ----------
def test_profile_verify(api, user_a, mongo):
    phone = "+15551234567"
    # 1) request OTP
    r1 = api.post(f"{BASE_URL}/api/profile/phone/request-otp",
                  json={"phone": phone},
                  headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r1.status_code == 200, r1.text
    code = r1.json().get("dev_code")
    assert code and len(code) == 6
    # 2) verify OTP
    r2 = api.post(f"{BASE_URL}/api/profile/phone/verify-otp",
                  json={"phone": phone, "code": code},
                  headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r2.status_code == 200, r2.text
    # 3) submit verification
    payload = {
        "full_legal_name": "Alice Test",
        "date_of_birth": "1990-01-01",
        "country": "United States",
        "phone": phone,
        "consent_acknowledged": True,
    }
    r = api.post(f"{BASE_URL}/api/profile/verify",
                 json=payload,
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["verified"] is True
    # confirm persisted
    udoc = mongo.users.find_one({"user_id": user_a["user_id"]})
    assert udoc["verified"] is True


def test_profile_verify_requires_otp(api, user_b):
    # Without OTP, /profile/verify must reject even with consent
    r = api.post(f"{BASE_URL}/api/profile/verify",
                 json={"full_legal_name": "x", "date_of_birth": "2000-01-01",
                       "country": "US", "phone": "+15551112222", "consent_acknowledged": True},
                 headers={"Authorization": f"Bearer {user_b['session_token']}"})
    assert r.status_code == 400
    assert "Phone not verified" in r.text or "OTP" in r.text


def test_profile_verify_no_consent(api, user_b):
    r = api.post(f"{BASE_URL}/api/profile/verify",
                 json={"full_legal_name": "x", "date_of_birth": "2000-01-01",
                       "country": "US", "phone": "555", "consent_acknowledged": False},
                 headers={"Authorization": f"Bearer {user_b['session_token']}"})
    assert r.status_code == 400


# ---------- Rooms ----------
@pytest.fixture(scope="module")
def created_room(user_a):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {user_a['session_token']}",
                      "Content-Type": "application/json"})
    payload = {"name": "TEST_Room", "phrase": "open sesame please",
               "pin": "1234", "room_type": "duo"}
    r = s.post(f"{BASE_URL}/api/rooms/create", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    return {"room_id": data["room_id"], "phrase": payload["phrase"], "pin": payload["pin"]}


def test_room_create(created_room):
    assert created_room["room_id"].startswith("room_")


def test_room_create_short_phrase(api, user_a):
    r = api.post(f"{BASE_URL}/api/rooms/create",
                 json={"name": "x", "phrase": "ab", "pin": "1234"},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 400


def test_room_create_short_pin(api, user_a):
    r = api.post(f"{BASE_URL}/api/rooms/create",
                 json={"name": "x", "phrase": "valid phrase here", "pin": "12"},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 400


def test_room_summon_match(api, user_a, created_room):
    r = api.post(f"{BASE_URL}/api/rooms/summon",
                 json={"phrase": created_room["phrase"], "pin": created_room["pin"]},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200
    rooms = r.json()["rooms"]
    assert any(r2["room_id"] == created_room["room_id"] for r2 in rooms)


def test_room_summon_wrong_phrase(api, user_a, created_room):
    r = api.post(f"{BASE_URL}/api/rooms/summon",
                 json={"phrase": "totally wrong phrase", "pin": created_room["pin"]},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200
    assert r.json()["rooms"] == []


def test_room_summon_wrong_pin(api, user_a, created_room):
    r = api.post(f"{BASE_URL}/api/rooms/summon",
                 json={"phrase": created_room["phrase"], "pin": "9999"},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200
    assert r.json()["rooms"] == []


def test_room_summon_non_member(api, user_b, created_room):
    r = api.post(f"{BASE_URL}/api/rooms/summon",
                 json={"phrase": created_room["phrase"], "pin": created_room["pin"]},
                 headers={"Authorization": f"Bearer {user_b['session_token']}"})
    assert r.status_code == 200
    assert r.json()["rooms"] == []


# ---------- Messages ----------
def test_send_message_text(api, user_a, created_room):
    r = api.post(f"{BASE_URL}/api/rooms/{created_room['room_id']}/messages",
                 json={"content_type": "text", "content": "Hello world"},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200, r.text
    msg = r.json()
    assert msg["content"] == "Hello world"
    assert msg["content_type"] == "text"
    assert "message_id" in msg


def test_send_message_voice_image(api, user_a, created_room):
    for ct, c in [("voice", "data:audio/m4a;base64,xxx"),
                  ("image", "data:image/png;base64,iVBORw0KG")]:
        r = api.post(f"{BASE_URL}/api/rooms/{created_room['room_id']}/messages",
                     json={"content_type": ct, "content": c},
                     headers={"Authorization": f"Bearer {user_a['session_token']}"})
        assert r.status_code == 200, f"{ct}: {r.text}"


def test_send_invalid_content_type(api, user_a, created_room):
    r = api.post(f"{BASE_URL}/api/rooms/{created_room['room_id']}/messages",
                 json={"content_type": "video", "content": "x"},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 400


def test_list_messages_in_order(api, user_a, created_room):
    r = api.get(f"{BASE_URL}/api/rooms/{created_room['room_id']}/messages",
                headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200
    msgs = r.json()["messages"]
    assert len(msgs) >= 3
    times = [m["created_at"] for m in msgs]
    assert times == sorted(times)


def test_list_messages_non_member(api, user_b, created_room):
    r = api.get(f"{BASE_URL}/api/rooms/{created_room['room_id']}/messages",
                headers={"Authorization": f"Bearer {user_b['session_token']}"})
    assert r.status_code == 404


# ---------- End-room (forensic wipe) ----------
def test_end_room_wipes_and_archives(api, user_a, created_room, mongo):
    rid = created_room["room_id"]
    r = api.post(f"{BASE_URL}/api/rooms/{rid}/end",
                 json={},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200
    assert r.json().get("wiped") is True
    # messages wiped
    assert mongo.messages.count_documents({"room_id": rid}) == 0
    # forensic fragments archived
    assert mongo.forensic_fragments.count_documents({"room_id": rid}) >= 1
    # room marked session ended
    room_doc = mongo.rooms.find_one({"room_id": rid})
    assert room_doc["session_active"] is False


# ---------- Invitations ----------
def test_invite_owner_only_and_accept_flow(api, user_a, user_b, mongo):
    # create new room
    r = api.post(f"{BASE_URL}/api/rooms/create",
                 json={"name": "TEST_inv", "phrase": "invite phrase here", "pin": "5555"},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200
    rid = r.json()["room_id"]

    # non-owner cannot invite
    r2 = api.post(f"{BASE_URL}/api/rooms/{rid}/invite",
                  json={"email": "rand@example.com"},
                  headers={"Authorization": f"Bearer {user_b['session_token']}"})
    assert r2.status_code == 403

    # owner invites user_b
    r3 = api.post(f"{BASE_URL}/api/rooms/{rid}/invite",
                  json={"email": user_b["email"]},
                  headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r3.status_code == 200
    inv_id = r3.json()["invitation_id"]

    # user_b sees invitation
    r4 = api.get(f"{BASE_URL}/api/rooms/invitations",
                 headers={"Authorization": f"Bearer {user_b['session_token']}"})
    assert r4.status_code == 200
    invs = r4.json()["invitations"]
    assert any(i["invitation_id"] == inv_id for i in invs)

    # accept
    r5 = api.post(f"{BASE_URL}/api/rooms/invitations/{inv_id}/accept",
                  json={},
                  headers={"Authorization": f"Bearer {user_b['session_token']}"})
    assert r5.status_code == 200
    room = mongo.rooms.find_one({"room_id": rid})
    assert user_b["user_id"] in room["members"]


def test_decline_invitation(api, user_a, user_b, mongo):
    r = api.post(f"{BASE_URL}/api/rooms/create",
                 json={"name": "TEST_dec", "phrase": "decline this phrase", "pin": "6666"},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    rid = r.json()["room_id"]
    r3 = api.post(f"{BASE_URL}/api/rooms/{rid}/invite",
                  json={"email": user_b["email"]},
                  headers={"Authorization": f"Bearer {user_a['session_token']}"})
    inv_id = r3.json()["invitation_id"]
    r5 = api.post(f"{BASE_URL}/api/rooms/invitations/{inv_id}/decline",
                  json={},
                  headers={"Authorization": f"Bearer {user_b['session_token']}"})
    assert r5.status_code == 200
    inv = mongo.invitations.find_one({"invitation_id": inv_id})
    assert inv["status"] == "declined"


# ---------- Reports / risk escalation ----------
def test_report_self_blocked(api, user_a):
    r = api.post(f"{BASE_URL}/api/reports",
                 json={"reported_user_id": user_a["user_id"], "reason": "self"},
                 headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 400


def test_report_escalation(api, user_a, mongo):
    # fresh target user
    target_id = f"user_{uuid.uuid4().hex[:12]}"
    target_email = f"TEST_target_{uuid.uuid4().hex[:6]}@example.com"
    mongo.users.insert_one({
        "user_id": target_id, "email": target_email, "name": "Target",
        "picture": None, "role": "user", "verified": False,
        "verification_data": None, "risk_score": 0, "status": "active",
        "created_at": datetime.now(timezone.utc),
    })
    try:
        statuses = []
        for i in range(8):
            r = api.post(f"{BASE_URL}/api/reports",
                         json={"reported_user_id": target_id, "reason": f"r{i}"},
                         headers={"Authorization": f"Bearer {user_a['session_token']}"})
            assert r.status_code == 200
            doc = mongo.users.find_one({"user_id": target_id})
            statuses.append((doc["risk_score"], doc["status"]))
        # final state
        final = mongo.users.find_one({"user_id": target_id})
        assert final["risk_score"] == 8
        assert final["status"] == "suspended"
        # check escalation thresholds happened
        all_status = [s for _, s in statuses]
        assert "warned" in all_status
        assert "restricted" in all_status
        assert "suspended" in all_status
    finally:
        mongo.users.delete_one({"user_id": target_id})
        mongo.reports.delete_many({"reported_user_id": target_id})


# ---------- Transparency ----------
def test_transparency_summary(api, user_a):
    r = api.get(f"{BASE_URL}/api/transparency/summary",
                headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 200
    body = r.json()
    assert body["plaintext_chats_stored"] == 0
    assert body["forensic_window_days"] == 90
    assert "active_sessions" in body
    assert "active_rooms" in body


# ---------- Voice transcribe validation ----------
def test_voice_transcribe_empty(api, user_a):
    files = {"file": ("audio.m4a", b"", "audio/m4a")}
    r = requests.post(f"{BASE_URL}/api/voice/transcribe", files=files,
                      headers={"Authorization": f"Bearer {user_a['session_token']}"})
    assert r.status_code == 400, r.text


def test_voice_transcribe_unauth():
    files = {"file": ("audio.m4a", b"abc", "audio/m4a")}
    r = requests.post(f"{BASE_URL}/api/voice/transcribe", files=files)
    assert r.status_code == 401


# ---------- Admin / Super Admin ----------
def test_admin_users_forbidden_for_normal(api, normal_user):
    r = api.get(f"{BASE_URL}/api/admin/users",
                headers={"Authorization": f"Bearer {normal_user['session_token']}"})
    assert r.status_code == 403


def test_admin_users_super_admin(api, super_admin):
    r = api.get(f"{BASE_URL}/api/admin/users",
                headers={"Authorization": f"Bearer {super_admin['session_token']}"})
    assert r.status_code == 200
    assert "users" in r.json()


def test_admin_action_warn_restrict_suspend_blacklist(api, super_admin, mongo):
    # create target
    tid = f"user_{uuid.uuid4().hex[:12]}"
    mongo.users.insert_one({
        "user_id": tid, "email": f"TEST_actt_{uuid.uuid4().hex[:6]}@x.com",
        "name": "T", "picture": None, "role": "user", "verified": False,
        "verification_data": None, "risk_score": 0, "status": "active",
        "created_at": datetime.now(timezone.utc),
    })
    try:
        for action, expected in [("warn", "warned"), ("restrict", "restricted"),
                                  ("suspend", "suspended"), ("blacklist", "blacklisted"),
                                  ("reactivate", "active")]:
            r = api.post(f"{BASE_URL}/api/admin/users/action",
                         json={"target_user_id": tid, "action": action, "reason": "t"},
                         headers={"Authorization": f"Bearer {super_admin['session_token']}"})
            assert r.status_code == 200, f"{action}: {r.text}"
            doc = mongo.users.find_one({"user_id": tid})
            assert doc["status"] == expected
    finally:
        mongo.users.delete_one({"user_id": tid})


def test_blacklist_requires_super_admin(api, mongo, super_admin):
    # promote a user to admin (not super_admin)
    admin_id = f"user_{uuid.uuid4().hex[:12]}"
    admin_token = f"test_adm_{uuid.uuid4().hex[:12]}"
    mongo.users.insert_one({
        "user_id": admin_id, "email": f"TEST_adm_{uuid.uuid4().hex[:6]}@x.com",
        "name": "Adm", "picture": None, "role": "admin", "verified": False,
        "verification_data": None, "risk_score": 0, "status": "active",
        "created_at": datetime.now(timezone.utc),
    })
    mongo.user_sessions.insert_one({
        "user_id": admin_id, "session_token": admin_token,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "created_at": datetime.now(timezone.utc),
    })
    tid = f"user_{uuid.uuid4().hex[:12]}"
    mongo.users.insert_one({
        "user_id": tid, "email": f"TEST_t2_{uuid.uuid4().hex[:6]}@x.com",
        "name": "T2", "picture": None, "role": "user", "verified": False,
        "verification_data": None, "risk_score": 0, "status": "active",
        "created_at": datetime.now(timezone.utc),
    })
    try:
        r = api.post(f"{BASE_URL}/api/admin/users/action",
                     json={"target_user_id": tid, "action": "blacklist"},
                     headers={"Authorization": f"Bearer {admin_token}"})
        assert r.status_code == 403
    finally:
        mongo.users.delete_many({"user_id": {"$in": [admin_id, tid]}})
        mongo.user_sessions.delete_one({"session_token": admin_token})


def test_role_change_super_admin_only(api, super_admin, normal_user, mongo):
    # normal user tries -> 403
    r = api.post(f"{BASE_URL}/api/admin/users/role",
                 json={"target_user_id": normal_user["user_id"], "role": "admin"},
                 headers={"Authorization": f"Bearer {normal_user['session_token']}"})
    assert r.status_code == 403

    # super admin promotes normal_user -> admin
    r2 = api.post(f"{BASE_URL}/api/admin/users/role",
                  json={"target_user_id": normal_user["user_id"], "role": "admin"},
                  headers={"Authorization": f"Bearer {super_admin['session_token']}"})
    assert r2.status_code == 200, r2.text
    assert mongo.users.find_one({"user_id": normal_user["user_id"]})["role"] == "admin"

    # super admin cannot demote canonical super admin
    r3 = api.post(f"{BASE_URL}/api/admin/users/role",
                  json={"target_user_id": super_admin["user_id"], "role": "user"},
                  headers={"Authorization": f"Bearer {super_admin['session_token']}"})
    assert r3.status_code == 403


def test_admin_forensic_super_admin_only(api, super_admin, normal_user):
    r = api.get(f"{BASE_URL}/api/admin/forensic",
                headers={"Authorization": f"Bearer {normal_user['session_token']}"})
    assert r.status_code == 403
    r2 = api.get(f"{BASE_URL}/api/admin/forensic",
                 headers={"Authorization": f"Bearer {super_admin['session_token']}"})
    assert r2.status_code == 200
    body = r2.json()
    assert "fragments" in body
    assert body["retention_days"] == 90


def test_admin_audit(api, super_admin):
    r = api.get(f"{BASE_URL}/api/admin/audit",
                headers={"Authorization": f"Bearer {super_admin['session_token']}"})
    assert r.status_code == 200
    assert "actions" in r.json()


# ---------- Auto super-admin promotion ----------
def test_auto_super_admin_role_set(mongo):
    # backend startup forces alwargiridhar@gmail.com -> super_admin
    doc = mongo.users.find_one({"email": "alwargiridhar@gmail.com"})
    assert doc is not None
    assert doc["role"] == "super_admin"
