"""Iteration 7 feature tests:
- 3-day free trial (start-trial, plans.trial_days, billing.me)
- Subscribe with yearly_inr (~365 days out)
- Google Play verify-purchase (30 days for presence_monthly)
- Billing restore
- Room join request flow (light mode owner approves/rejects)
- voice/transcribe endpoint smoke
"""

import os
import uuid
import requests
import pytest
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient

from conftest import auth_headers, BASE_URL

API = f"{BASE_URL}/api"


def _fresh_user(mongo, name="Trial User"):
    """Create a brand-new user with no premium and no trial_used.
    The shared conftest user fixtures pre-grant premium for other tests so
    we must build fresh ones here."""
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    token = f"test_sess_{uuid.uuid4().hex[:16]}"
    email = f"TEST_iter7_{uuid.uuid4().hex[:6]}@example.com"
    mongo.users.insert_one({
        "user_id": user_id,
        "email": email,
        "name": name,
        "picture": None,
        "role": "user",
        "verified": False,
        "verification_data": None,
        "risk_score": 0,
        "status": "active",
        "created_at": datetime.now(timezone.utc),
        "last_active": datetime.now(timezone.utc),
        # explicitly NOT premium
        "is_premium": False,
        "premium_until": None,
        "premium_plan": None,
        "trial_used": False,
    })
    mongo.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": token,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "created_at": datetime.now(timezone.utc),
    })
    return {"user_id": user_id, "session_token": token, "email": email, "name": name, "role": "user"}


@pytest.fixture
def fresh_user_a(mongo):
    u = _fresh_user(mongo, "Trial A")
    yield u
    mongo.users.delete_one({"user_id": u["user_id"]})
    mongo.user_sessions.delete_many({"user_id": u["user_id"]})


@pytest.fixture
def fresh_user_b(mongo):
    u = _fresh_user(mongo, "Trial B")
    yield u
    mongo.users.delete_one({"user_id": u["user_id"]})
    mongo.user_sessions.delete_many({"user_id": u["user_id"]})


@pytest.fixture
def fresh_user_c(mongo):
    u = _fresh_user(mongo, "Trial C")
    yield u
    mongo.users.delete_one({"user_id": u["user_id"]})
    mongo.user_sessions.delete_many({"user_id": u["user_id"]})


# --------------------------- BILLING / PLANS ---------------------------
class TestBillingPlans:
    def test_plans_trial_days_and_inr_labels(self):
        r = requests.get(f"{API}/billing/plans")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("trial_days") == 3, body
        # Verify INR pricing labels exist
        plans = body.get("plans", [])
        by_id = {p["id"]: p for p in plans}
        assert "monthly_inr" in by_id
        assert "yearly_inr" in by_id
        assert by_id["monthly_inr"]["price_label"] == "₹99 / month"
        assert by_id["yearly_inr"]["price_label"] == "₹999 / year"
        # trial_days on each plan as well
        for pid in ("monthly_inr", "yearly_inr"):
            assert by_id[pid].get("trial_days") == 3, by_id[pid]


class TestBillingMeFresh:
    def test_fresh_user_billing_me(self, fresh_user_a):
        r = requests.get(f"{API}/billing/me", headers=auth_headers(fresh_user_a))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("is_premium") is False
        assert body.get("trial_used") is False
        assert body.get("trial_days") == 3


class TestStartTrial:
    def test_start_trial_then_second_call_400(self, fresh_user_b):
        # First call activates 3-day trial
        r = requests.post(f"{API}/billing/start-trial", headers=auth_headers(fresh_user_b))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("ok") is True
        assert body.get("trial_days") == 3
        # premium_until should be ~3 days from now
        from dateutil import parser as dtparser
        until = dtparser.isoparse(body["premium_until"])
        delta = (until - datetime.now(timezone.utc)).total_seconds()
        # 3 days = 259200s. Allow 60s clock skew.
        assert 259200 - 120 <= delta <= 259200 + 120, delta

        # Verify billing/me reflects trial_used + is_premium
        m = requests.get(f"{API}/billing/me", headers=auth_headers(fresh_user_b))
        assert m.status_code == 200
        mbody = m.json()
        assert mbody["is_premium"] is True
        assert mbody["trial_used"] is True
        assert mbody["premium_plan"] == "trial"

        # Second start-trial call must 400
        r2 = requests.post(f"{API}/billing/start-trial", headers=auth_headers(fresh_user_b))
        assert r2.status_code == 400, r2.text


class TestSubscribeYearly:
    def test_subscribe_yearly_inr_365_days(self, fresh_user_c):
        r = requests.post(
            f"{API}/billing/subscribe",
            headers=auth_headers(fresh_user_c),
            json={"plan_id": "yearly_inr"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "premium_until" in body
        from dateutil import parser as dtparser
        until = dtparser.isoparse(body["premium_until"])
        delta_days = (until - datetime.now(timezone.utc)).total_seconds() / 86400
        # Should be ~365 days
        assert 364 < delta_days < 366, delta_days

        # Verify persisted
        m = requests.get(f"{API}/billing/me", headers=auth_headers(fresh_user_c))
        assert m.status_code == 200
        mbody = m.json()
        assert mbody["is_premium"] is True
        assert mbody["premium_plan"] == "yearly_inr"


class TestGooglePlayVerify:
    def test_verify_monthly_30_days(self, mongo):
        u = _fresh_user(mongo, "GPlay User")
        try:
            r = requests.post(
                f"{API}/billing/google-play/verify-purchase",
                headers=auth_headers(u),
                json={
                    "product_id": "presence_monthly",
                    "purchase_token": "TEST_TOKEN_" + uuid.uuid4().hex[:8],
                    "order_id": "TEST_ORDER_" + uuid.uuid4().hex[:6],
                    "purchase_state": 1,
                },
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body.get("ok") is True
            assert body.get("plan_id") == "monthly_inr"
            from dateutil import parser as dtparser
            until = dtparser.isoparse(body["premium_until"])
            delta_days = (until - datetime.now(timezone.utc)).total_seconds() / 86400
            assert 29 < delta_days < 31, delta_days
        finally:
            mongo.users.delete_one({"user_id": u["user_id"]})
            mongo.user_sessions.delete_many({"user_id": u["user_id"]})


class TestRestore:
    def test_restore_returns_entitlement(self, mongo):
        u = _fresh_user(mongo, "Restore User")
        try:
            # Start trial first to give entitlement
            r = requests.post(f"{API}/billing/start-trial", headers=auth_headers(u))
            assert r.status_code == 200
            # Restore should reflect it
            r2 = requests.post(f"{API}/billing/restore", headers=auth_headers(u))
            assert r2.status_code == 200, r2.text
            body = r2.json()
            assert body.get("is_premium") is True
            assert body.get("premium_plan") == "trial"
            assert body.get("premium_until") is not None
        finally:
            mongo.users.delete_one({"user_id": u["user_id"]})
            mongo.user_sessions.delete_many({"user_id": u["user_id"]})


# --------------------------- JOIN REQUEST FLOW (light mode) ---------------------------
class TestJoinRequestFlow:
    def _make_light_room(self, owner):
        """Create a light-mode duo room owned by `owner`."""
        phrase = f"TEST phrase {uuid.uuid4().hex[:6]}"
        payload = {
            "name": "TEST Light Room",
            "phrase": phrase,
            "room_type": "duo",
            "security_mode": "light",
        }
        r = requests.post(f"{API}/rooms/create", headers=auth_headers(owner), json=payload)
        assert r.status_code == 200, r.text
        return r.json()["room_id"], phrase

    def test_approve_join_request_adds_member(self, user_a, user_b, mongo):
        room_id, _phrase = self._make_light_room(user_a)
        try:
            # user_b requests to join
            r = requests.post(
                f"{API}/rooms/{room_id}/request-join", headers=auth_headers(user_b)
            )
            assert r.status_code == 200, r.text
            req_id = r.json()["request_id"]

            # Owner lists pending
            lst = requests.get(
                f"{API}/rooms/{room_id}/join-requests", headers=auth_headers(user_a)
            )
            assert lst.status_code == 200, lst.text
            requests_list = lst.json()["requests"]
            assert any(rq["request_id"] == req_id for rq in requests_list)
            target = next(rq for rq in requests_list if rq["request_id"] == req_id)
            assert target["requester_name"] == user_b["name"]
            assert target["requester_email"] == user_b["email"]

            # Approve
            ap = requests.post(
                f"{API}/rooms/{room_id}/join-requests/{req_id}/decision",
                headers=auth_headers(user_a),
                json={"approve": True},
            )
            assert ap.status_code == 200, ap.text
            assert ap.json()["approved"] is True

            # Verify user_b is now member
            room_doc = mongo.rooms.find_one({"room_id": room_id})
            assert user_b["user_id"] in room_doc.get("members", []), room_doc

            # Pending list now empty
            lst2 = requests.get(
                f"{API}/rooms/{room_id}/join-requests", headers=auth_headers(user_a)
            )
            assert lst2.status_code == 200
            assert all(rq["request_id"] != req_id for rq in lst2.json()["requests"])
        finally:
            mongo.rooms.delete_one({"room_id": room_id})
            mongo.join_requests.delete_many({"room_id": room_id})
            mongo.messages.delete_many({"room_id": room_id})

    def test_reject_join_request_does_not_add_member(self, user_a, normal_user, mongo):
        room_id, _phrase = self._make_light_room(user_a)
        try:
            r = requests.post(
                f"{API}/rooms/{room_id}/request-join", headers=auth_headers(normal_user)
            )
            assert r.status_code == 200
            req_id = r.json()["request_id"]

            rj = requests.post(
                f"{API}/rooms/{room_id}/join-requests/{req_id}/decision",
                headers=auth_headers(user_a),
                json={"approve": False},
            )
            assert rj.status_code == 200, rj.text
            assert rj.json()["approved"] is False

            # Verify normal_user is NOT a member
            room_doc = mongo.rooms.find_one({"room_id": room_id})
            assert normal_user["user_id"] not in room_doc.get("members", [])

            # The join request should be marked rejected
            jr = mongo.join_requests.find_one({"request_id": req_id})
            assert jr["status"] == "rejected"
        finally:
            mongo.rooms.delete_one({"room_id": room_id})
            mongo.join_requests.delete_many({"room_id": room_id})

    def test_non_owner_cannot_list_join_requests(self, user_a, user_b, mongo):
        room_id, _phrase = self._make_light_room(user_a)
        try:
            r = requests.get(
                f"{API}/rooms/{room_id}/join-requests", headers=auth_headers(user_b)
            )
            assert r.status_code == 403, r.text
        finally:
            mongo.rooms.delete_one({"room_id": room_id})


# --------------------------- VOICE TRANSCRIBE SMOKE ---------------------------
class TestVoiceTranscribeEndpointExists:
    def test_endpoint_exists_requires_auth(self):
        # No auth → should NOT be 404 (endpoint exists). Likely 401/403/422.
        r = requests.post(f"{API}/voice/transcribe")
        assert r.status_code != 404, r.text
        assert r.status_code in (400, 401, 403, 422), r.status_code
