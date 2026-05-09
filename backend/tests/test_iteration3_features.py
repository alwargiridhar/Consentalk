"""Consentalk iteration-3 feature tests.

Covers: billing endpoints (plans, me, subscribe, cancel), free-tier quota
enforcement (rooms/day, images/session), admin billing grant/revoke + listing,
RBAC (permissions catalog, roles CRUD, assign/revoke), admin analytics summary.

Existing 54-test suite must continue to pass — these are NEW tests only.
Test fixtures auto-grant premium to test users; for free-tier 402 paths we
manually insert non-premium users.
"""
import os
import uuid
import pytest
import requests
from datetime import datetime, timezone, timedelta

BASE_URL = "https://intent-space-1.preview.emergentagent.com"


def auth(t):
    return {"Authorization": f"Bearer {t}", "Content-Type": "application/json"}


# ---------- helpers to mint a *truly free-tier* user (is_premium=False) ----------

def _mint_free_user(mongo, name="FreeUser"):
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    token = f"test_free_{uuid.uuid4().hex[:16]}"
    mongo.users.insert_one({
        "user_id": user_id,
        "email": f"TEST_free_{uuid.uuid4().hex[:6]}@example.com".lower(),
        "name": name,
        "picture": None,
        "role": "user",
        "verified": False,
        "verification_data": None,
        "risk_score": 0,
        "status": "active",
        "created_at": datetime.now(timezone.utc),
        "last_active": datetime.now(timezone.utc),
        "is_premium": False,
        "premium_until": None,
        "premium_plan": None,
    })
    mongo.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": token,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "created_at": datetime.now(timezone.utc),
    })
    return {"user_id": user_id, "session_token": token, "name": name}


def _cleanup_user(mongo, u):
    mongo.users.delete_one({"user_id": u["user_id"]})
    mongo.user_sessions.delete_many({"user_id": u["user_id"]})
    mongo.rooms.delete_many({"owner_user_id": u["user_id"]})


# ---------- /api/billing/plans ----------
class TestBillingPlans:
    def test_plans_structure(self, api):
        r = api.get(f"{BASE_URL}/api/billing/plans")
        assert r.status_code == 200, r.text
        body = r.json()
        plans = body.get("plans")
        assert isinstance(plans, list) and len(plans) == 4
        ids = sorted(p["id"] for p in plans)
        assert ids == ["monthly_inr", "monthly_usd", "yearly_inr", "yearly_usd"]
        # currency + price sanity
        for p in plans:
            assert p["currency"] in ("INR", "USD")
            assert isinstance(p["price"], (int, float)) and p["price"] > 0
            assert p["days"] in (30, 365)
            assert p.get("price_label")
        ft = body.get("free_tier") or {}
        assert ft.get("rooms_per_day") == 1
        assert ft.get("images_per_session") == 3
        assert isinstance(ft.get("features"), list) and len(ft["features"]) > 0
        assert isinstance(body.get("premium_features"), list) and len(body["premium_features"]) > 0


# ---------- /api/billing/me ----------
class TestBillingMe:
    def test_me_admin_unlimited_true_for_super_admin(self, api, super_admin):
        r = api.get(f"{BASE_URL}/api/billing/me",
                    headers=auth(super_admin["session_token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("is_admin_unlimited") is True
        assert "is_premium" in body

    def test_me_for_free_user(self, api, mongo):
        u = _mint_free_user(mongo)
        try:
            r = api.get(f"{BASE_URL}/api/billing/me",
                        headers=auth(u["session_token"]))
            assert r.status_code == 200
            body = r.json()
            assert body.get("is_premium") is False
            assert body.get("is_admin_unlimited") is False
        finally:
            _cleanup_user(mongo, u)

    def test_me_unauthenticated(self, api):
        r = api.get(f"{BASE_URL}/api/billing/me")
        assert r.status_code == 401


# ---------- /api/billing/subscribe ----------
class TestBillingSubscribe:
    def test_subscribe_bad_plan_400(self, api, user_a):
        r = api.post(f"{BASE_URL}/api/billing/subscribe",
                     json={"plan_id": "lifetime_eternity"},
                     headers=auth(user_a["session_token"]))
        assert r.status_code == 400

    def test_subscribe_monthly_inr_marks_premium(self, api, mongo):
        u = _mint_free_user(mongo)
        try:
            r = api.post(f"{BASE_URL}/api/billing/subscribe",
                         json={"plan_id": "monthly_inr"},
                         headers=auth(u["session_token"]))
            assert r.status_code == 200, r.text
            body = r.json()
            assert body.get("ok") is True
            assert body.get("mocked") is True
            assert body.get("plan", {}).get("id") == "monthly_inr"
            assert body.get("premium_until")
            # GET-back verification
            me = api.get(f"{BASE_URL}/api/billing/me",
                        headers=auth(u["session_token"])).json()
            assert me.get("is_premium") is True
            assert me.get("premium_plan") == "monthly_inr"
            # billing event row exists
            assert mongo.billing_events.count_documents(
                {"user_id": u["user_id"], "type": "subscribe_self_mocked"}
            ) >= 1
        finally:
            _cleanup_user(mongo, u)

    def test_cancel_self_logs_event(self, api, mongo):
        u = _mint_free_user(mongo)
        try:
            r = api.post(f"{BASE_URL}/api/billing/cancel", json={},
                         headers=auth(u["session_token"]))
            assert r.status_code == 200
            assert r.json().get("ok") is True
            assert mongo.billing_events.count_documents(
                {"user_id": u["user_id"], "type": "cancel_self"}
            ) >= 1
        finally:
            _cleanup_user(mongo, u)


# ---------- Free-tier room cap ----------
class TestFreeTierRoomCap:
    def test_free_user_2nd_room_402(self, api, mongo):
        u = _mint_free_user(mongo)
        try:
            r1 = api.post(f"{BASE_URL}/api/rooms/create",
                          json={"name": "TEST_q1", "phrase": "free quota one phrase",
                                "pin": "1010"},
                          headers=auth(u["session_token"]))
            assert r1.status_code == 200, r1.text
            r2 = api.post(f"{BASE_URL}/api/rooms/create",
                          json={"name": "TEST_q2", "phrase": "free quota two phrase",
                                "pin": "2020"},
                          headers=auth(u["session_token"]))
            assert r2.status_code == 402, r2.text
            assert "Free tier" in r2.text or "Upgrade" in r2.text
        finally:
            _cleanup_user(mongo, u)

    def test_premium_user_no_cap(self, api, user_a):
        # user_a is premium per fixture
        for i in range(3):
            r = api.post(f"{BASE_URL}/api/rooms/create",
                         json={"name": f"TEST_prem_{i}",
                               "phrase": f"premium room phrase {i} extra",
                               "pin": "3030"},
                         headers=auth(user_a["session_token"]))
            assert r.status_code == 200, f"premium room {i} blocked: {r.text}"

    def test_super_admin_no_cap(self, api, super_admin):
        for i in range(3):
            r = api.post(f"{BASE_URL}/api/rooms/create",
                         json={"name": f"TEST_sa_{i}",
                               "phrase": f"super admin room {i} phrase",
                               "pin": "4040"},
                         headers=auth(super_admin["session_token"]))
            assert r.status_code == 200, r.text


# ---------- Free-tier image cap ----------
class TestFreeTierImageCap:
    def test_free_user_4th_image_402(self, api, mongo):
        u = _mint_free_user(mongo)
        try:
            r = api.post(f"{BASE_URL}/api/rooms/create",
                         json={"name": "TEST_imgcap", "phrase": "image cap phrase here",
                               "pin": "5050"},
                         headers=auth(u["session_token"]))
            assert r.status_code == 200, r.text
            rid = r.json()["room_id"]
            for i in range(3):
                rr = api.post(f"{BASE_URL}/api/rooms/{rid}/messages",
                              json={"content_type": "image", "content": f"img{i}_b64"},
                              headers=auth(u["session_token"]))
                assert rr.status_code == 200, f"img {i}: {rr.text}"
            r4 = api.post(f"{BASE_URL}/api/rooms/{rid}/messages",
                          json={"content_type": "image", "content": "img4_b64"},
                          headers=auth(u["session_token"]))
            assert r4.status_code == 402, r4.text
            # text still allowed even after image cap hit
            rt = api.post(f"{BASE_URL}/api/rooms/{rid}/messages",
                          json={"content_type": "text", "content": "still ok"},
                          headers=auth(u["session_token"]))
            assert rt.status_code == 200
        finally:
            _cleanup_user(mongo, u)

    def test_premium_user_unlimited_images(self, api, user_a):
        r = api.post(f"{BASE_URL}/api/rooms/create",
                     json={"name": "TEST_premimg", "phrase": "prem img phrase here",
                           "pin": "6060"},
                     headers=auth(user_a["session_token"]))
        rid = r.json()["room_id"]
        for i in range(5):
            rr = api.post(f"{BASE_URL}/api/rooms/{rid}/messages",
                          json={"content_type": "image", "content": f"img{i}_b64"},
                          headers=auth(user_a["session_token"]))
            assert rr.status_code == 200, f"prem img {i}: {rr.text}"


# ---------- Admin billing grant/revoke ----------
class TestAdminBilling:
    def test_super_admin_grant_revoke(self, api, super_admin, mongo):
        u = _mint_free_user(mongo, name="GrantTarget")
        try:
            r = api.post(f"{BASE_URL}/api/admin/billing/grant",
                         json={"target_user_id": u["user_id"],
                               "plan_id": "monthly_inr", "days": 5},
                         headers=auth(super_admin["session_token"]))
            assert r.status_code == 200, r.text
            assert r.json().get("ok") is True
            assert r.json().get("premium_until")
            # admin_actions audit row written
            assert mongo.admin_actions.count_documents(
                {"target_user_id": u["user_id"],
                 "admin_user_id": super_admin["user_id"],
                 "action": {"$regex": "^premium_grant"}}
            ) >= 1
            # user is_premium True
            udoc = mongo.users.find_one({"user_id": u["user_id"]})
            assert udoc.get("is_premium") is True
            # revoke
            rv = api.post(f"{BASE_URL}/api/admin/billing/revoke",
                          json={"target_user_id": u["user_id"],
                                "plan_id": "monthly_inr"},
                          headers=auth(super_admin["session_token"]))
            assert rv.status_code == 200
            udoc2 = mongo.users.find_one({"user_id": u["user_id"]})
            assert udoc2.get("is_premium") is False
        finally:
            _cleanup_user(mongo, u)

    def test_non_super_admin_without_perm_403(self, api, mongo, user_b):
        # user_b is plain user (role='user'); call should be 403 from require_admin
        r = api.post(f"{BASE_URL}/api/admin/billing/grant",
                     json={"target_user_id": user_b["user_id"],
                           "plan_id": "monthly_inr"},
                     headers=auth(user_b["session_token"]))
        assert r.status_code == 403

    def test_admin_with_billing_grant_perm_can_grant(self, api, mongo, super_admin):
        # promote a plain user to admin role with billing.grant permission only
        adm = _mint_free_user(mongo, name="LtdAdmin")
        target = _mint_free_user(mongo, name="LtdTarget")
        try:
            mongo.users.update_one(
                {"user_id": adm["user_id"]},
                {"$set": {"role": "admin", "permissions": ["billing.grant"]}})
            r = api.post(f"{BASE_URL}/api/admin/billing/grant",
                         json={"target_user_id": target["user_id"],
                               "plan_id": "monthly_inr"},
                         headers=auth(adm["session_token"]))
            assert r.status_code == 200, r.text
            # but revoke should still 403 because no billing.revoke perm
            rv = api.post(f"{BASE_URL}/api/admin/billing/revoke",
                          json={"target_user_id": target["user_id"],
                                "plan_id": "monthly_inr"},
                          headers=auth(adm["session_token"]))
            assert rv.status_code == 403, rv.text
        finally:
            _cleanup_user(mongo, adm)
            _cleanup_user(mongo, target)

    def test_billing_users_listing_super_admin(self, api, super_admin):
        r = api.get(f"{BASE_URL}/api/admin/billing/users",
                    headers=auth(super_admin["session_token"]))
        assert r.status_code == 200, r.text
        assert isinstance(r.json().get("users"), list)

    def test_billing_users_403_without_perm(self, api, mongo):
        adm = _mint_free_user(mongo, name="NoPermAdmin")
        try:
            mongo.users.update_one(
                {"user_id": adm["user_id"]},
                {"$set": {"role": "admin", "permissions": []}})
            r = api.get(f"{BASE_URL}/api/admin/billing/users",
                        headers=auth(adm["session_token"]))
            assert r.status_code == 403
        finally:
            _cleanup_user(mongo, adm)

    def test_billing_events_listing(self, api, super_admin):
        r = api.get(f"{BASE_URL}/api/admin/billing/events",
                    headers=auth(super_admin["session_token"]))
        assert r.status_code == 200
        assert isinstance(r.json().get("events"), list)


# ---------- RBAC ----------
class TestRBAC:
    def test_permissions_catalog_admin(self, api, super_admin):
        r = api.get(f"{BASE_URL}/api/admin/permissions",
                    headers=auth(super_admin["session_token"]))
        assert r.status_code == 200
        cat = r.json().get("catalog")
        assert isinstance(cat, list) and len(cat) >= 16
        assert "billing.grant" in cat
        assert "analytics.view" in cat
        assert "rbac.manage_roles" in cat

    def test_create_role_super_admin_only(self, api, super_admin, user_b, mongo):
        # non-super-admin user_b cannot create
        r0 = api.post(f"{BASE_URL}/api/admin/roles",
                      json={"name": "NotAllowed", "permissions": ["billing.view"]},
                      headers=auth(user_b["session_token"]))
        assert r0.status_code == 403

        r = api.post(f"{BASE_URL}/api/admin/roles",
                     json={"name": "TEST_billing_viewer",
                           "description": "view billing",
                           "permissions": ["billing.view", "not_a_real_perm"]},
                     headers=auth(super_admin["session_token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        rid = body["role_id"]
        # invalid perm filtered out
        assert "not_a_real_perm" not in body["permissions"]
        assert "billing.view" in body["permissions"]
        # cleanup
        api.delete(f"{BASE_URL}/api/admin/roles/{rid}",
                   headers=auth(super_admin["session_token"]))

    def test_assign_revoke_role_flow(self, api, super_admin, mongo):
        target = _mint_free_user(mongo, name="RoleTarget")
        try:
            # create two roles
            r1 = api.post(f"{BASE_URL}/api/admin/roles",
                          json={"name": "TEST_role_a",
                                "permissions": ["billing.view", "analytics.view"]},
                          headers=auth(super_admin["session_token"]))
            r2 = api.post(f"{BASE_URL}/api/admin/roles",
                          json={"name": "TEST_role_b",
                                "permissions": ["billing.grant"]},
                          headers=auth(super_admin["session_token"]))
            role_a = r1.json()["role_id"]
            role_b = r2.json()["role_id"]
            try:
                # assign role_a
                ra = api.post(f"{BASE_URL}/api/admin/users/assign-role",
                              json={"target_user_id": target["user_id"],
                                    "role_id": role_a},
                              headers=auth(super_admin["session_token"]))
                assert ra.status_code == 200, ra.text
                perms = set(ra.json()["permissions"])
                assert {"billing.view", "analytics.view"}.issubset(perms)
                # assign role_b — union onto perms
                rb = api.post(f"{BASE_URL}/api/admin/users/assign-role",
                              json={"target_user_id": target["user_id"],
                                    "role_id": role_b},
                              headers=auth(super_admin["session_token"]))
                assert rb.status_code == 200
                perms2 = set(rb.json()["permissions"])
                assert {"billing.view", "analytics.view", "billing.grant"}.issubset(perms2)
                # extra_roles list contains both
                udoc = mongo.users.find_one({"user_id": target["user_id"]})
                assert role_a in (udoc.get("extra_roles") or [])
                assert role_b in (udoc.get("extra_roles") or [])
                # revoke role_a — perms rebuilt from remaining (only role_b)
                rv = api.post(f"{BASE_URL}/api/admin/users/revoke-role",
                              json={"target_user_id": target["user_id"],
                                    "role_id": role_a},
                              headers=auth(super_admin["session_token"]))
                assert rv.status_code == 200
                udoc2 = mongo.users.find_one({"user_id": target["user_id"]})
                assert role_a not in (udoc2.get("extra_roles") or [])
                assert role_b in (udoc2.get("extra_roles") or [])
                assert set(udoc2.get("permissions") or []) == {"billing.grant"}
                # delete role_b — should pull from extra_roles
                rd = api.delete(f"{BASE_URL}/api/admin/roles/{role_b}",
                                headers=auth(super_admin["session_token"]))
                assert rd.status_code == 200
                udoc3 = mongo.users.find_one({"user_id": target["user_id"]})
                assert role_b not in (udoc3.get("extra_roles") or [])
            finally:
                # idempotent cleanup
                api.delete(f"{BASE_URL}/api/admin/roles/{role_a}",
                           headers=auth(super_admin["session_token"]))
                api.delete(f"{BASE_URL}/api/admin/roles/{role_b}",
                           headers=auth(super_admin["session_token"]))
        finally:
            _cleanup_user(mongo, target)

    def test_assign_role_non_super_admin_403(self, api, super_admin, user_b, mongo):
        # create a role as super-admin first
        r = api.post(f"{BASE_URL}/api/admin/roles",
                     json={"name": "TEST_role_x",
                           "permissions": ["billing.view"]},
                     headers=auth(super_admin["session_token"]))
        rid = r.json()["role_id"]
        try:
            r2 = api.post(f"{BASE_URL}/api/admin/users/assign-role",
                          json={"target_user_id": user_b["user_id"],
                                "role_id": rid},
                          headers=auth(user_b["session_token"]))
            assert r2.status_code == 403
        finally:
            api.delete(f"{BASE_URL}/api/admin/roles/{rid}",
                       headers=auth(super_admin["session_token"]))


# ---------- Admin analytics ----------
class TestAnalytics:
    def test_analytics_super_admin(self, api, super_admin):
        r = api.get(f"{BASE_URL}/api/admin/analytics/summary",
                    headers=auth(super_admin["session_token"]))
        assert r.status_code == 200, r.text
        body = r.json()
        for key in ("users", "rooms", "reports"):
            assert key in body, f"missing {key} in analytics"
        u = body["users"]
        for k in ("total", "verified", "premium", "suspended", "blacklisted"):
            assert k in u and isinstance(u[k], int)
        rr = body["rooms"]
        for k in ("total", "active", "today"):
            assert k in rr and isinstance(rr[k], int)
        assert "open" in body["reports"] and isinstance(body["reports"]["open"], int)

    def test_analytics_403_without_perm(self, api, mongo):
        adm = _mint_free_user(mongo, name="NoAnalyticsAdmin")
        try:
            mongo.users.update_one(
                {"user_id": adm["user_id"]},
                {"$set": {"role": "admin", "permissions": []}})
            r = api.get(f"{BASE_URL}/api/admin/analytics/summary",
                        headers=auth(adm["session_token"]))
            assert r.status_code == 403
        finally:
            _cleanup_user(mongo, adm)

    def test_analytics_admin_with_perm_200(self, api, mongo):
        adm = _mint_free_user(mongo, name="AnalyticsAdmin")
        try:
            mongo.users.update_one(
                {"user_id": adm["user_id"]},
                {"$set": {"role": "admin", "permissions": ["analytics.view"]}})
            r = api.get(f"{BASE_URL}/api/admin/analytics/summary",
                        headers=auth(adm["session_token"]))
            assert r.status_code == 200
        finally:
            _cleanup_user(mongo, adm)

    def test_analytics_plain_user_403(self, api, user_a):
        r = api.get(f"{BASE_URL}/api/admin/analytics/summary",
                    headers=auth(user_a["session_token"]))
        # require_admin runs first → 403
        assert r.status_code == 403
