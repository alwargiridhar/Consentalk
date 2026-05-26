"""Iteration 8 feature tests: smart-keypad summon behavior.

Backend contract for POST /api/rooms/summon:

1. Member of LIGHT room + phrase only -> rooms=[<room>], pin_required=False
2. Non-member, LIGHT room owned by other + phrase only -> rooms=[],
   join_candidate={...}, pin_required=False
3. Member of DEEP room + phrase only (no pin) -> rooms=[], pin_required=True;
   then phrase+correct PIN -> rooms=[<room>]
4. Random unmatched phrase -> rooms=[], join_candidate=None, pin_required=False
5. Privacy: non-member of a DEEP room must NEVER see pin_required=True (we
   must not leak that a Deep room exists for that phrase).
"""

import uuid
import requests
import pytest

from conftest import auth_headers, BASE_URL

API = f"{BASE_URL}/api"


# --------------------------- helpers ---------------------------

def _create_room(owner, phrase, security_mode, pin=None, room_type="duo"):
    payload = {
        "name": f"TEST {security_mode} room",
        "phrase": phrase,
        "room_type": room_type,
        "security_mode": security_mode,
    }
    if security_mode == "deep":
        payload["pin"] = pin or "1234"
    r = requests.post(f"{API}/rooms/create", headers=auth_headers(owner), json=payload)
    assert r.status_code == 200, r.text
    return r.json()["room_id"]


def _summon(user, phrase, pin=None):
    body = {"phrase": phrase}
    if pin is not None:
        body["pin"] = pin
    r = requests.post(f"{API}/rooms/summon", headers=auth_headers(user), json=body)
    assert r.status_code == 200, r.text
    return r.json()


# --------------------------- tests ---------------------------

class TestLightMemberNoKeypad:
    """Scenario 1: Member of a Light room -> instant unlock, no PIN required."""

    def test_light_member_returns_room_no_pin(self, user_a, mongo):
        phrase = f"TEST light member {uuid.uuid4().hex[:6]}"
        room_id = _create_room(user_a, phrase, "light")
        try:
            res = _summon(user_a, phrase)
            assert res["pin_required"] is False, res
            assert res["join_candidate"] is None
            assert isinstance(res["rooms"], list)
            assert len(res["rooms"]) == 1, res
            assert res["rooms"][0]["room_id"] == room_id
            assert res["rooms"][0].get("security_mode", "light") == "light"
        finally:
            mongo.rooms.delete_one({"room_id": room_id})


class TestLightNonMemberJoinCandidate:
    """Scenario 2: Non-member of a Light room -> join_candidate is surfaced,
    pin_required=False (no keypad)."""

    def test_light_non_member_returns_join_candidate(self, user_a, user_b, mongo):
        phrase = f"TEST light non-member {uuid.uuid4().hex[:6]}"
        room_id = _create_room(user_a, phrase, "light")
        try:
            res = _summon(user_b, phrase)
            assert res["rooms"] == []
            assert res["pin_required"] is False, res
            jc = res["join_candidate"]
            assert jc is not None, res
            assert jc["room_id"] == room_id
            assert jc["security_mode"] == "light"
        finally:
            mongo.rooms.delete_one({"room_id": room_id})
            mongo.join_requests.delete_many({"room_id": room_id})


class TestDeepMemberRequiresPin:
    """Scenario 3: Member of a Deep room -> phrase alone yields pin_required=True
    and empty rooms; phrase+correct pin yields the room."""

    def test_deep_member_two_step_summon(self, user_a, mongo):
        phrase = f"TEST deep member {uuid.uuid4().hex[:6]}"
        pin = "246810"
        room_id = _create_room(user_a, phrase, "deep", pin=pin)
        try:
            # Step 1: no pin
            res1 = _summon(user_a, phrase)
            assert res1["rooms"] == [], res1
            assert res1["join_candidate"] is None
            assert res1["pin_required"] is True, res1

            # Step 1b: wrong pin -> still empty, no room leak
            res_wrong = _summon(user_a, phrase, pin="000000")
            assert res_wrong["rooms"] == [], res_wrong

            # Step 2: correct pin
            res2 = _summon(user_a, phrase, pin=pin)
            assert len(res2["rooms"]) == 1, res2
            assert res2["rooms"][0]["room_id"] == room_id
        finally:
            mongo.rooms.delete_one({"room_id": room_id})


class TestRandomPhraseNoKeypad:
    """Scenario 4: A phrase not matching any room -> empty results, no PIN."""

    def test_random_phrase_returns_empty(self, user_a):
        phrase = f"completely random {uuid.uuid4().hex}"
        res = _summon(user_a, phrase)
        assert res["rooms"] == [], res
        assert res["join_candidate"] is None, res
        assert res["pin_required"] is False, res


class TestDeepPrivacyForNonMembers:
    """Scenario 5: Non-member of a Deep room must NEVER see pin_required=True.
    Otherwise a stranger could probe phrases to discover Deep room existence."""

    def test_deep_non_member_no_pin_leak(self, user_a, user_b, mongo):
        phrase = f"TEST deep private {uuid.uuid4().hex[:6]}"
        room_id = _create_room(user_a, phrase, "deep", pin="135790")
        try:
            res = _summon(user_b, phrase)
            assert res["rooms"] == [], res
            assert res["join_candidate"] is None, res
            assert res["pin_required"] is False, (
                "Privacy violation: pin_required leaked to non-member of Deep room"
            )

            # Even providing a random PIN should not leak existence
            res2 = _summon(user_b, phrase, pin="135790")
            assert res2["rooms"] == [], res2
            # PIN supplied so pin_required is computed only on phrase-only path
            # but room must still not be returned for a non-member.
        finally:
            mongo.rooms.delete_one({"room_id": room_id})


class TestPinRequiredFieldAlwaysPresent:
    """The pin_required field should always be present (default False) so the
    frontend can branch reliably."""

    def test_pin_required_field_present(self, user_a):
        res = _summon(user_a, f"unmatched {uuid.uuid4().hex}")
        assert "pin_required" in res, res
        assert "rooms" in res
        assert "join_candidate" in res
