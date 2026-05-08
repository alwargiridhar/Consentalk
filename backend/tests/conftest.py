import os
import time
import uuid
import pytest
import requests
from datetime import datetime, timezone, timedelta
from pymongo import MongoClient

BASE_URL = "https://intent-space-1.preview.emergentagent.com"
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest.fixture(scope="session")
def mongo():
    c = MongoClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


def _make_user(mongo, email, name="Test User", role="user", status="active", verified=False):
    user_id = f"user_{uuid.uuid4().hex[:12]}"
    token = f"test_sess_{uuid.uuid4().hex[:16]}"
    mongo.users.insert_one({
        "user_id": user_id,
        "email": email.lower(),
        "name": name,
        "picture": None,
        "role": role,
        "verified": verified,
        "verification_data": None,
        "risk_score": 0,
        "status": status,
        "created_at": datetime.now(timezone.utc),
        "last_active": datetime.now(timezone.utc),
    })
    mongo.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": token,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "created_at": datetime.now(timezone.utc),
    })
    return {"user_id": user_id, "session_token": token, "email": email.lower(), "name": name, "role": role}


@pytest.fixture(scope="session")
def user_a(mongo):
    u = _make_user(mongo, f"TEST_a_{uuid.uuid4().hex[:6]}@example.com", "Alice")
    yield u
    mongo.users.delete_one({"user_id": u["user_id"]})
    mongo.user_sessions.delete_many({"user_id": u["user_id"]})


@pytest.fixture(scope="session")
def user_b(mongo):
    u = _make_user(mongo, f"TEST_b_{uuid.uuid4().hex[:6]}@example.com", "Bob")
    yield u
    mongo.users.delete_one({"user_id": u["user_id"]})
    mongo.user_sessions.delete_many({"user_id": u["user_id"]})


@pytest.fixture(scope="session")
def normal_user(mongo):
    u = _make_user(mongo, f"TEST_n_{uuid.uuid4().hex[:6]}@example.com", "Normal")
    yield u
    mongo.users.delete_one({"user_id": u["user_id"]})
    mongo.user_sessions.delete_many({"user_id": u["user_id"]})


@pytest.fixture(scope="session")
def super_admin(mongo):
    # Use canonical super admin email; backend startup forces role=super_admin
    email = "alwargiridhar@gmail.com"
    existing = mongo.users.find_one({"email": email})
    if existing:
        user_id = existing["user_id"]
        mongo.users.update_one({"user_id": user_id}, {"$set": {"role": "super_admin", "status": "active"}})
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        mongo.users.insert_one({
            "user_id": user_id,
            "email": email,
            "name": "Super Admin",
            "picture": None,
            "role": "super_admin",
            "verified": True,
            "verification_data": None,
            "risk_score": 0,
            "status": "active",
            "created_at": datetime.now(timezone.utc),
            "last_active": datetime.now(timezone.utc),
        })
    token = f"test_sa_{uuid.uuid4().hex[:16]}"
    mongo.user_sessions.insert_one({
        "user_id": user_id,
        "session_token": token,
        "expires_at": datetime.now(timezone.utc) + timedelta(days=7),
        "created_at": datetime.now(timezone.utc),
    })
    yield {"user_id": user_id, "session_token": token, "email": email, "name": "Super Admin", "role": "super_admin"}
    mongo.user_sessions.delete_one({"session_token": token})


def auth_headers(user):
    return {"Authorization": f"Bearer {user['session_token']}", "Content-Type": "application/json"}


@pytest.fixture
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s
