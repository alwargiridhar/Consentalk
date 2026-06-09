"""
Consentalk Backend
==================
Privacy-first ephemeral communication platform.
"""

from fastapi import (
    FastAPI,
    APIRouter,
    HTTPException,
    Depends,
    Request,
    Response,
    UploadFile,
    File,
    WebSocket,
    WebSocketDisconnect,
)
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import hashlib
import uuid
import base64
import tempfile
import asyncio
from pathlib import Path
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
from datetime import datetime, timezone, timedelta
import httpx
from emergentintegrations.llm.openai.speech_to_text import OpenAISpeechToText

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
mongo_url = os.environ["MONGO_URL"]
db_name = os.environ["DB_NAME"]
EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")
SUPER_ADMIN_EMAIL = os.environ.get("SUPER_ADMIN_EMAIL", "alwargiridhar@gmail.com").lower()
FORENSIC_RETENTION_DAYS = int(os.environ.get("FORENSIC_RETENTION_DAYS", "90"))

client = AsyncIOMotorClient(mongo_url)
db = client[db_name]

app = FastAPI(title="Consentalk API")
api_router = APIRouter(prefix="/api")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("consentalk")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def normalize_phrase(phrase: str) -> str:
    return " ".join((phrase or "").lower().strip().split())


def hash_secret(value: str, salt: str = "consentalk-v1") -> str:
    return hashlib.sha256(f"{salt}:{value}".encode("utf-8")).hexdigest()


def hash_phrase(phrase: str) -> str:
    return hash_secret(normalize_phrase(phrase), salt="phrase")


def hash_pin(pin: str) -> str:
    return hash_secret(str(pin).strip(), salt="pin")


def encrypt_fragment(content: str) -> str:
    """Lightweight obfuscation for forensic fragments (NOT real E2EE,
    placeholder for future libsodium integration)."""
    return base64.b64encode(content.encode("utf-8")).decode("ascii")


def decrypt_fragment(blob: str) -> str:
    try:
        return base64.b64decode(blob.encode("ascii")).decode("utf-8")
    except Exception:
        return "[unreadable]"


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class User(BaseModel):
    user_id: str
    email: str
    name: str
    picture: Optional[str] = None
    role: str = "user"
    verified: bool = False
    verification_data: Optional[Dict[str, Any]] = None
    risk_score: int = 0
    status: str = "active"
    created_at: datetime
    last_active: Optional[datetime] = None
    # Premium / RBAC fields (added in iteration 3)
    is_premium: bool = False
    premium_until: Optional[datetime] = None
    premium_plan: Optional[str] = None  # e.g. "monthly_inr", "yearly_inr"
    extra_roles: List[str] = []  # additional RBAC roles beyond `role`
    permissions: List[str] = []  # explicit permission grants
    display_alias: Optional[str] = None  # custom 2-3 char alias for privacy


class SubscribeInput(BaseModel):
    plan_id: str  # monthly_inr | yearly_inr | monthly_usd | yearly_usd


class GrantPremiumInput(BaseModel):
    target_user_id: str
    plan_id: str  # same set
    days: Optional[int] = None  # override duration (super-admin)


class RoleDef(BaseModel):
    role_id: str
    name: str
    description: Optional[str] = None
    permissions: List[str] = []


class CreateRoleInput(BaseModel):
    name: str
    description: Optional[str] = None
    permissions: List[str] = []


class AssignRoleInput(BaseModel):
    target_user_id: str
    role_id: str
    probationary: bool = False
    expires_in_days: Optional[int] = None


# ------------- Plans / pricing (server-of-truth) -------------
PLANS: Dict[str, Dict[str, Any]] = {
    "monthly_inr": {
        "id": "monthly_inr",
        "name": "Consentalk Presence — Monthly",
        "currency": "INR",
        "price": 99,
        "price_label": "₹99 / month",
        "days": 30,
        "google_play_product_id": "presence_monthly",
        "trial_days": 3,
    },
    "yearly_inr": {
        "id": "yearly_inr",
        "name": "Consentalk Presence — Yearly",
        "currency": "INR",
        "price": 999,
        "price_label": "₹999 / year",
        "days": 365,
        "google_play_product_id": "presence_yearly",
        "trial_days": 3,
    },
    "monthly_usd": {
        "id": "monthly_usd",
        "name": "Consentalk Presence — Monthly",
        "currency": "USD",
        "price": 1.99,
        "price_label": "$1.99 / month",
        "days": 30,
        "google_play_product_id": "presence_monthly",
        "trial_days": 3,
    },
    "yearly_usd": {
        "id": "yearly_usd",
        "name": "Consentalk Presence — Yearly",
        "currency": "USD",
        "price": 19.99,
        "price_label": "$19.99 / year",
        "days": 365,
        "google_play_product_id": "presence_yearly",
        "trial_days": 3,
    },
}

# Free-tier limits
FREE_ROOMS_PER_DAY = 1
FREE_IMAGES_PER_DAY = 3
TRIAL_DAYS = 3

# Built-in / default permission catalog
PERMISSION_CATALOG = [
    "moderation.review",
    "moderation.action_user",
    "moderation.blacklist",
    "billing.grant",
    "billing.revoke",
    "billing.view",
    "rbac.manage_roles",
    "rbac.assign_roles",
    "analytics.view",
    "support.view_tickets",
    "support.close_tickets",
    "region.manage",
    "feature_flags.manage",
    "career.promote",
    "career.invite",
    "forensic.view",
]


def _is_premium_active(user: Dict[str, Any]) -> bool:
    if not user:
        return False
    if user.get("role") in ("admin", "super_admin"):
        return True  # admins/super-admins always treated as premium
    if not user.get("is_premium"):
        return False
    until = user.get("premium_until")
    if isinstance(until, datetime):
        return until.replace(tzinfo=timezone.utc) > utcnow() if until.tzinfo is None else until > utcnow()
    return True


class SessionDataInput(BaseModel):
    session_id: str


class VerificationInput(BaseModel):
    full_legal_name: str
    date_of_birth: str
    country: str
    phone: str
    consent_acknowledged: bool


class PhoneOtpRequest(BaseModel):
    phone: str


class PhoneOtpVerify(BaseModel):
    phone: str
    code: str


class CreateRoomInput(BaseModel):
    name: str
    phrase: str
    pin: Optional[str] = None  # optional in Light mode, required in Deep
    room_type: str = "duo"
    security_mode: str = "light"  # "light" (phrase only) | "deep" (phrase + pin)
    # Retention: one of "5min" | "10min" | "15min" | "on_refresh".
    # "on_refresh" → messages persist until anyone hits the wipe button or
    # leaves/ends the room. Time-based modes auto-delete N minutes after the
    # message has been read by all other members.
    retention_mode: str = "10min"


class SummonRoomInput(BaseModel):
    phrase: str
    pin: Optional[str] = None


class RoomSecurityInput(BaseModel):
    security_mode: str
    pin: Optional[str] = None  # required when switching to deep


class RoomSettingsInput(BaseModel):
    retention_mode: Optional[str] = None  # "5min" | "10min" | "15min" | "on_refresh"


class JoinRequestApprovalInput(BaseModel):
    approve: bool


class InviteInput(BaseModel):
    email: Optional[str] = None
    phone: Optional[str] = None


class MessageInput(BaseModel):
    content_type: str
    content: str


class ReportInput(BaseModel):
    reported_user_id: Optional[str] = None
    reported_user_email: Optional[str] = None
    room_id: Optional[str] = None
    reason: str
    details: Optional[str] = None


class AdminActionInput(BaseModel):
    target_user_id: str
    action: str
    reason: Optional[str] = None


class AdminRoleInput(BaseModel):
    target_user_id: str
    role: str


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
async def _resolve_super_admin(email: str) -> str:
    return "super_admin" if (email or "").lower() == SUPER_ADMIN_EMAIL else "user"


async def get_session_token(request: Request) -> Optional[str]:
    token = request.cookies.get("session_token")
    if token:
        return token
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


async def get_current_user(request: Request) -> User:
    token = await get_session_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")

    expires_at = session.get("expires_at")
    if expires_at:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < utcnow():
            raise HTTPException(status_code=401, detail="Session expired")

    user_doc = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
    if not user_doc:
        raise HTTPException(status_code=401, detail="User not found")

    user = User(**user_doc)
    if user.status == "blacklisted":
        raise HTTPException(status_code=403, detail="Account blacklisted")
    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role not in ("admin", "super_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


async def require_super_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "super_admin":
        raise HTTPException(status_code=403, detail="Super admin access required")
    return user


@api_router.get("/")
async def root():
    return {"app": "Consentalk", "tagline": "Private by Presence."}


@api_router.post("/auth/session")
async def auth_session(payload: SessionDataInput, request: Request, response: Response):
    if not payload.session_id:
        raise HTTPException(status_code=400, detail="session_id required")
    async with httpx.AsyncClient(timeout=15.0) as http_client:
        try:
            r = await http_client.get(
                "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
                headers={"X-Session-ID": payload.session_id},
            )
        except Exception as exc:
            logger.exception("emergent auth call failed")
            raise HTTPException(status_code=502, detail=f"Auth provider error: {exc}")

    if r.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid session_id")

    data = r.json()
    email = (data.get("email") or "").lower()
    name = data.get("name") or "Friend"
    picture = data.get("picture") or None
    session_token = data.get("session_token")
    if not email or not session_token:
        raise HTTPException(status_code=502, detail="Auth provider returned no email/token")

    existing = await db.users.find_one({"email": email}, {"_id": 0})
    if existing:
        user_id = existing["user_id"]
        if email == SUPER_ADMIN_EMAIL and existing.get("role") != "super_admin":
            await db.users.update_one(
                {"user_id": user_id}, {"$set": {"role": "super_admin"}}
            )
        await db.users.update_one(
            {"user_id": user_id},
            {"$set": {"last_active": utcnow(), "name": name, "picture": picture}},
        )
    else:
        user_id = f"user_{uuid.uuid4().hex[:12]}"
        role = await _resolve_super_admin(email)
        await db.users.insert_one(
            {
                "user_id": user_id,
                "email": email,
                "name": name,
                "picture": picture,
                "role": role,
                "verified": False,
                "verification_data": None,
                "risk_score": 0,
                "status": "active",
                "created_at": utcnow(),
                "last_active": utcnow(),
            }
        )

    await db.user_sessions.insert_one(
        {
            "user_id": user_id,
            "session_token": session_token,
            "expires_at": utcnow() + timedelta(days=7),
            "device_info": {
                "user_agent": request.headers.get("user-agent", "unknown"),
                "ip": request.client.host if request.client else None,
            },
            "created_at": utcnow(),
        }
    )

    response.set_cookie(
        key="session_token",
        value=session_token,
        max_age=7 * 24 * 60 * 60,
        httponly=True,
        secure=True,
        samesite="none",
        path="/",
    )

    user_doc = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    return {"user": User(**user_doc).model_dump(), "session_token": session_token}


@api_router.get("/auth/me")
async def auth_me(user: User = Depends(get_current_user)):
    return user


@api_router.post("/auth/logout")
async def auth_logout(request: Request, response: Response):
    token = await get_session_token(request)
    if token:
        await db.user_sessions.delete_one({"session_token": token})
    response.delete_cookie("session_token", path="/")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Profile / Verification
# ---------------------------------------------------------------------------
@api_router.post("/profile/verify")
async def submit_verification(
    payload: VerificationInput, user: User = Depends(get_current_user)
):
    if not payload.consent_acknowledged:
        raise HTTPException(status_code=400, detail="Consent acknowledgement required")
    if not payload.full_legal_name.strip() or not payload.phone.strip():
        raise HTTPException(status_code=400, detail="Name and phone are required")
    # phone must be OTP-verified before this endpoint sets verified=True
    phone_norm = payload.phone.strip()
    otp_record = await db.phone_otps.find_one(
        {"user_id": user.user_id, "phone": phone_norm, "verified": True},
        {"_id": 0},
    )
    if not otp_record:
        raise HTTPException(
            status_code=400,
            detail="Phone not verified. Please request and confirm an OTP first.",
        )
    await db.users.update_one(
        {"user_id": user.user_id},
        {
            "$set": {
                "verified": True,
                "verification_data": {
                    "full_legal_name": payload.full_legal_name.strip(),
                    "date_of_birth": payload.date_of_birth.strip(),
                    "country": payload.country.strip(),
                    "phone": phone_norm,
                    "phone_verified": True,
                    "verified_at": utcnow().isoformat(),
                },
            }
        },
    )
    user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    return User(**user_doc)


# Phone OTP — MOCKED (dev returns the code, real prod would send SMS via Twilio).
@api_router.post("/profile/phone/request-otp")
async def request_phone_otp(payload: PhoneOtpRequest, user: User = Depends(get_current_user)):
    phone = payload.phone.strip()
    if len(phone) < 6:
        raise HTTPException(status_code=400, detail="Invalid phone number")
    code = f"{int.from_bytes(os.urandom(3), 'big') % 1000000:06d}"
    await db.phone_otps.update_one(
        {"user_id": user.user_id, "phone": phone},
        {
            "$set": {
                "user_id": user.user_id,
                "phone": phone,
                "code": code,
                "verified": False,
                "expires_at": utcnow() + timedelta(minutes=10),
                "created_at": utcnow(),
            }
        },
        upsert=True,
    )
    # MOCKED: in production this sends SMS. For MVP we surface the code in the
    # response so the user can complete the flow without an SMS provider.
    return {"ok": True, "dev_code": code, "mocked": True}


@api_router.post("/profile/phone/verify-otp")
async def verify_phone_otp(payload: PhoneOtpVerify, user: User = Depends(get_current_user)):
    rec = await db.phone_otps.find_one(
        {"user_id": user.user_id, "phone": payload.phone.strip()}, {"_id": 0}
    )
    if not rec:
        raise HTTPException(status_code=404, detail="No OTP requested for this phone")
    expires = rec.get("expires_at")
    if expires and expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires and expires < utcnow():
        raise HTTPException(status_code=400, detail="OTP expired — request a new one")
    if (rec.get("code") or "") != payload.code.strip():
        raise HTTPException(status_code=400, detail="Incorrect OTP")
    await db.phone_otps.update_one(
        {"user_id": user.user_id, "phone": payload.phone.strip()},
        {"$set": {"verified": True, "verified_at": utcnow()}},
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Voice transcription (Whisper-1)
# ---------------------------------------------------------------------------
@api_router.post("/voice/transcribe")
async def voice_transcribe(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=500, detail="Server LLM key not configured")
    suffix = ""
    fname = (file.filename or "audio.m4a").lower()
    for ext in ("m4a", "mp3", "mp4", "wav", "webm", "mpeg", "mpga"):
        if fname.endswith(f".{ext}"):
            suffix = f".{ext}"
            break
    if not suffix:
        suffix = ".m4a"
    contents = await file.read()
    if len(contents) == 0:
        raise HTTPException(status_code=400, detail="Empty audio file")
    if len(contents) > 25 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio file too large (max 25MB)")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp.write(contents)
    tmp.close()
    try:
        stt = OpenAISpeechToText(api_key=EMERGENT_LLM_KEY)
        # Newer litellm requires bytes/IO/PathLike (not a str path) for `file`.
        # Pass an open binary file handle. Library validates via str path first
        # (size+ext checks), so we keep the temp file on disk and reopen here.
        with open(tmp.name, "rb") as fh:
            result = await stt.transcribe(
                file=fh, model="whisper-1", response_format="json"
            )
        if isinstance(result, dict):
            text = result.get("text", "")
        else:
            text = getattr(result, "text", "") or str(result)
        return {"text": text.strip()}
    except Exception as exc:
        logger.exception("transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}")
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Rooms
# ---------------------------------------------------------------------------
@api_router.post("/rooms/create")
async def create_room(payload: CreateRoomInput, user: User = Depends(get_current_user)):
    if user.status in ("suspended", "blacklisted"):
        raise HTTPException(status_code=403, detail="Account restricted")
    phrase_norm = normalize_phrase(payload.phrase)
    if len(phrase_norm) < 3:
        raise HTTPException(status_code=400, detail="Phrase too short")
    if payload.room_type not in ("duo", "circle"):
        raise HTTPException(status_code=400, detail="Invalid room type")
    if payload.security_mode not in ("light", "deep"):
        raise HTTPException(status_code=400, detail="Invalid security_mode")

    pin_value = (payload.pin or "").strip()
    if payload.security_mode == "deep":
        if not pin_value or len(pin_value) < 4:
            raise HTTPException(status_code=400, detail="PIN must be at least 4 digits for Deep mode")
        pin_hash = hash_pin(pin_value)
    else:
        pin_hash = None  # light mode has no PIN

    # Light mode: phrase must be globally unique
    if payload.security_mode == "light":
        existing = await db.rooms.find_one(
            {"phrase_hash": hash_phrase(phrase_norm), "status": "active", "security_mode": "light"},
            {"_id": 0},
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Room already allocated. Please use a more unique phrase. "
                    "Try adding more words for uniqueness."
                ),
            )

    # Free-tier limit: 1 room/day. Admin/super-admin/premium are unlimited.
    user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    if not _is_premium_active(user_doc or {}):
        day_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        rooms_today = await db.rooms.count_documents(
            {"owner_user_id": user.user_id, "created_at": {"$gte": day_start}}
        )
        if rooms_today >= FREE_ROOMS_PER_DAY:
            raise HTTPException(
                status_code=402,
                detail=(
                    "Free tier allows 1 room per day. Upgrade to Consentalk "
                    "Presence for unlimited rooms."
                ),
            )

    room_id = f"room_{uuid.uuid4().hex[:14]}"
    # Validate retention mode
    rmode = (payload.retention_mode or "10min").strip()
    if rmode not in ("5min", "10min", "15min", "on_refresh"):
        rmode = "10min"
    await db.rooms.insert_one(
        {
            "room_id": room_id,
            "owner_user_id": user.user_id,
            "name": payload.name.strip() or "Untitled Room",
            "room_type": payload.room_type,
            "security_mode": payload.security_mode,
            "retention_mode": rmode,
            "phrase_hash": hash_phrase(phrase_norm),
            "pin_hash": pin_hash,
            "members": [user.user_id],
            "status": "active",
            "session_active": False,
            "created_at": utcnow(),
            "last_active": utcnow(),
        }
    )
    return {
        "room_id": room_id,
        "name": payload.name,
        "room_type": payload.room_type,
        "security_mode": payload.security_mode,
        "retention_mode": rmode,
    }


@api_router.post("/rooms/{room_id}/security")
async def change_room_security(
    room_id: str,
    payload: RoomSecurityInput,
    user: User = Depends(get_current_user),
):
    room = await db.rooms.find_one({"room_id": room_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room["owner_user_id"] != user.user_id:
        raise HTTPException(status_code=403, detail="Only the owner can change room security")
    if payload.security_mode not in ("light", "deep"):
        raise HTTPException(status_code=400, detail="Invalid security_mode")
    update: Dict[str, Any] = {"security_mode": payload.security_mode}
    if payload.security_mode == "deep":
        if not payload.pin or len(payload.pin) < 4:
            raise HTTPException(status_code=400, detail="PIN required for Deep mode")
        update["pin_hash"] = hash_pin(payload.pin)
    else:
        # Light mode: drop the PIN, re-check phrase uniqueness
        existing = await db.rooms.find_one(
            {
                "phrase_hash": room["phrase_hash"],
                "status": "active",
                "security_mode": "light",
                "room_id": {"$ne": room_id},
            },
            {"_id": 0},
        )
        if existing:
            raise HTTPException(
                status_code=409,
                detail="Phrase is already used by another Light room — pick a more unique phrase first.",
            )
        update["pin_hash"] = None
    await db.rooms.update_one({"room_id": room_id}, {"$set": update})
    return {"ok": True, "security_mode": payload.security_mode}


# Retention modes accepted: "5min", "10min", "15min", "on_refresh"
_RETENTION_MODES = ("5min", "10min", "15min", "on_refresh")
_RETENTION_MINUTES = {"5min": 5, "10min": 10, "15min": 15}


@api_router.patch("/rooms/{room_id}/settings")
async def update_room_settings(
    room_id: str,
    payload: RoomSettingsInput,
    user: User = Depends(get_current_user),
):
    """Owner-only — change room settings (currently just retention_mode)."""
    room = await db.rooms.find_one({"room_id": room_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room["owner_user_id"] != user.user_id:
        raise HTTPException(
            status_code=403, detail="Only the owner can change room settings"
        )
    update: Dict[str, Any] = {}
    if payload.retention_mode is not None:
        if payload.retention_mode not in _RETENTION_MODES:
            raise HTTPException(status_code=400, detail="Invalid retention_mode")
        update["retention_mode"] = payload.retention_mode
    if not update:
        return {"ok": True, "retention_mode": room.get("retention_mode", "10min")}
    await db.rooms.update_one({"room_id": room_id}, {"$set": update})
    # Broadcast the new setting so clients can update their UI immediately.
    await ws_manager.broadcast(
        room_id,
        {
            "type": "settings_updated",
            "retention_mode": update.get(
                "retention_mode", room.get("retention_mode", "10min")
            ),
        },
    )
    return {"ok": True, **update}


@api_router.post("/rooms/{room_id}/wipe")
async def wipe_room_messages(
    room_id: str, user: User = Depends(get_current_user)
):
    """Any member can trigger a 'refresh & wipe' — instantly deletes all
    messages currently in the room (used by the 'on_refresh' retention
    mode). This does NOT end the room session."""
    room = await db.rooms.find_one(
        {"room_id": room_id, "members": user.user_id}, {"_id": 0}
    )
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    await db.messages.delete_many({"room_id": room_id})
    await ws_manager.broadcast(
        room_id,
        {
            "type": "wiped",
            "by_user_id": user.user_id,
            "by_name": user.name,
        },
    )
    return {"ok": True}


@api_router.post("/rooms/summon")
async def summon_room(payload: SummonRoomInput, user: User = Depends(get_current_user)):
    if user.status in ("suspended", "blacklisted"):
        raise HTTPException(status_code=403, detail="Account restricted")
    p_hash = hash_phrase(payload.phrase)

    # Match rooms where this user is already a member AND phrase/pin matches
    # the room's security mode.
    query: Dict[str, Any] = {
        "phrase_hash": p_hash,
        "members": user.user_id,
        "status": "active",
    }
    pin_value = (payload.pin or "").strip()
    # If a PIN was supplied, it must match the room's pin_hash. If no PIN, only
    # match rooms in Light mode (where pin_hash is None).
    pin_hash = hash_pin(pin_value) if pin_value else None

    rooms_cursor = db.rooms.find(query, {"_id": 0, "phrase_hash": 0, "pin_hash": 0})
    all_rooms = await rooms_cursor.to_list(50)
    rooms = []
    for r in all_rooms:
        mode = r.get("security_mode", "deep")
        # Re-fetch pin_hash separately because we projected it out
        full = await db.rooms.find_one({"room_id": r["room_id"]}, {"_id": 0})
        full_pin_hash = full.get("pin_hash")
        if mode == "deep":
            if not pin_hash or pin_hash != full_pin_hash:
                continue
        else:  # light
            # In light mode the PIN is ignored; phrase alone unlocks the room.
            pass
        rooms.append(r)

    if rooms:
        await db.rooms.update_many(
            {"room_id": {"$in": [r["room_id"] for r in rooms]}},
            {"$set": {"last_active": utcnow(), "session_active": True}},
        )

    # If no rooms matched as a member, check if a Light-mode room exists for
    # this phrase that the user is NOT yet a member of — surface a "request
    # access" hint so the user can request to join.
    join_candidate = None
    pin_required = False
    if not rooms and not pin_value:
        candidate = await db.rooms.find_one(
            {
                "phrase_hash": p_hash,
                "status": "active",
                "security_mode": "light",
                "members": {"$ne": user.user_id},
            },
            {"_id": 0, "phrase_hash": 0, "pin_hash": 0},
        )
        if candidate:
            join_candidate = {
                "room_id": candidate["room_id"],
                "name": candidate["name"],
                "room_type": candidate.get("room_type", "duo"),
                "security_mode": candidate.get("security_mode", "light"),
            }
        else:
            # No Light-mode match — check whether this user is a MEMBER of a
            # Deep-mode room with this phrase. Only then do we admit that a
            # PIN is required (we never disclose room existence to non-members).
            deep_member = await db.rooms.find_one(
                {
                    "phrase_hash": p_hash,
                    "status": "active",
                    "security_mode": "deep",
                    "members": user.user_id,
                },
                {"_id": 0},
            )
            if deep_member:
                pin_required = True

    return {
        "rooms": rooms,
        "join_candidate": join_candidate,
        "pin_required": pin_required,
    }


# ----------- Join-request workflow (Light mode entry) -----------
@api_router.post("/rooms/{room_id}/request-join")
async def request_join(room_id: str, user: User = Depends(get_current_user)):
    room = await db.rooms.find_one({"room_id": room_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.get("status") != "active":
        raise HTTPException(status_code=410, detail="Room is closed")
    if user.user_id in room.get("members", []):
        return {"ok": True, "already_member": True}
    existing = await db.join_requests.find_one(
        {
            "room_id": room_id,
            "requester_user_id": user.user_id,
            "status": "pending",
        },
        {"_id": 0},
    )
    if existing:
        return {"ok": True, "request_id": existing["request_id"], "already_pending": True}
    req_id = f"req_{uuid.uuid4().hex[:12]}"
    await db.join_requests.insert_one(
        {
            "request_id": req_id,
            "room_id": room_id,
            "requester_user_id": user.user_id,
            "requester_name": user.name,
            "requester_email": user.email,
            "requester_picture": user.picture,
            "requester_verified": user.verified,
            "status": "pending",
            "created_at": utcnow(),
        }
    )
    # Notify owner via WS
    await ws_manager.broadcast(
        room_id,
        {
            "type": "join_request",
            "request_id": req_id,
            "requester_user_id": user.user_id,
            "requester_name": user.name,
            "requester_email": user.email,
        },
    )
    return {"ok": True, "request_id": req_id}


@api_router.get("/rooms/{room_id}/join-requests")
async def list_join_requests(room_id: str, user: User = Depends(get_current_user)):
    room = await db.rooms.find_one({"room_id": room_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room["owner_user_id"] != user.user_id:
        raise HTTPException(status_code=403, detail="Only the owner can view join requests")
    cursor = db.join_requests.find(
        {"room_id": room_id, "status": "pending"}, {"_id": 0}
    ).sort("created_at", -1)
    items = await cursor.to_list(200)
    for it in items:
        if isinstance(it.get("created_at"), datetime):
            it["created_at"] = it["created_at"].isoformat()
    return {"requests": items}


@api_router.get("/rooms/join-requests/pending")
async def my_pending_join_requests(user: User = Depends(get_current_user)):
    """All pending join requests across rooms owned by the caller."""
    owned_rooms = await db.rooms.find(
        {"owner_user_id": user.user_id, "status": "active"}, {"_id": 0, "room_id": 1, "name": 1}
    ).to_list(200)
    if not owned_rooms:
        return {"requests": []}
    room_id_to_name = {r["room_id"]: r.get("name") for r in owned_rooms}
    cursor = db.join_requests.find(
        {"room_id": {"$in": list(room_id_to_name.keys())}, "status": "pending"},
        {"_id": 0},
    ).sort("created_at", -1)
    items = await cursor.to_list(200)
    for it in items:
        it["room_name"] = room_id_to_name.get(it.get("room_id"))
        if isinstance(it.get("created_at"), datetime):
            it["created_at"] = it["created_at"].isoformat()
    return {"requests": items}


@api_router.post("/rooms/{room_id}/join-requests/{request_id}/decision")
async def decide_join_request(
    room_id: str,
    request_id: str,
    payload: JoinRequestApprovalInput,
    user: User = Depends(get_current_user),
):
    room = await db.rooms.find_one({"room_id": room_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room["owner_user_id"] != user.user_id:
        raise HTTPException(status_code=403, detail="Only the owner can approve / reject")
    req = await db.join_requests.find_one(
        {"request_id": request_id, "room_id": room_id, "status": "pending"}, {"_id": 0}
    )
    if not req:
        raise HTTPException(status_code=404, detail="Request not found or already decided")
    if payload.approve:
        # Capacity check
        if room["room_type"] == "duo" and len(room.get("members", [])) >= 2:
            raise HTTPException(status_code=400, detail="Duo room is full")
        if room["room_type"] == "circle" and len(room.get("members", [])) >= 8:
            raise HTTPException(status_code=400, detail="Circle room is full")
        await db.rooms.update_one(
            {"room_id": room_id}, {"$addToSet": {"members": req["requester_user_id"]}}
        )
        await db.join_requests.update_one(
            {"request_id": request_id},
            {"$set": {"status": "approved", "decided_at": utcnow(), "decided_by": user.user_id}},
        )
        await ws_manager.broadcast(
            room_id,
            {
                "type": "join_request_decided",
                "request_id": request_id,
                "requester_user_id": req["requester_user_id"],
                "approved": True,
            },
        )
        return {"ok": True, "approved": True}
    else:
        await db.join_requests.update_one(
            {"request_id": request_id},
            {"$set": {"status": "rejected", "decided_at": utcnow(), "decided_by": user.user_id}},
        )
        await ws_manager.broadcast(
            room_id,
            {
                "type": "join_request_decided",
                "request_id": request_id,
                "requester_user_id": req["requester_user_id"],
                "approved": False,
            },
        )
        return {"ok": True, "approved": False}


@api_router.get("/rooms/my-join-requests")
async def my_join_requests(user: User = Depends(get_current_user)):
    """My outgoing join requests."""
    cursor = db.join_requests.find(
        {"requester_user_id": user.user_id}, {"_id": 0}
    ).sort("created_at", -1)
    items = await cursor.to_list(100)
    for it in items:
        if isinstance(it.get("created_at"), datetime):
            it["created_at"] = it["created_at"].isoformat()
        if isinstance(it.get("decided_at"), datetime):
            it["decided_at"] = it["decided_at"].isoformat()
    return {"requests": items}


@api_router.post("/rooms/{room_id}/invite")
async def invite_to_room(
    room_id: str, payload: InviteInput, user: User = Depends(get_current_user)
):
    room = await db.rooms.find_one({"room_id": room_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room["owner_user_id"] != user.user_id:
        raise HTTPException(status_code=403, detail="Only the owner can invite")
    if room["room_type"] == "duo" and len(room.get("members", [])) >= 2:
        raise HTTPException(status_code=400, detail="Duo rooms accept only 2 members")
    if room["room_type"] == "circle" and len(room.get("members", [])) >= 8:
        raise HTTPException(status_code=400, detail="Circle rooms accept up to 8 members")

    invite_email = (payload.email or "").strip().lower() or None
    invite_phone = (payload.phone or "").strip() or None
    if not invite_email and not invite_phone:
        raise HTTPException(status_code=400, detail="Provide email or phone")

    invitee = None
    if invite_email:
        invitee = await db.users.find_one({"email": invite_email}, {"_id": 0})
    if not invitee and invite_phone:
        invitee = await db.users.find_one(
            {"verification_data.phone": invite_phone}, {"_id": 0}
        )

    invitation_id = f"inv_{uuid.uuid4().hex[:12]}"
    await db.invitations.insert_one(
        {
            "invitation_id": invitation_id,
            "room_id": room_id,
            "room_name": room.get("name"),
            "room_type": room.get("room_type"),
            "inviter_user_id": user.user_id,
            "inviter_name": user.name,
            "invited_email": invite_email,
            "invited_phone": invite_phone,
            "invited_user_id": invitee["user_id"] if invitee else None,
            "status": "pending",
            "created_at": utcnow(),
        }
    )
    return {"invitation_id": invitation_id, "linked_user": bool(invitee)}


@api_router.get("/rooms/invitations")
async def my_invitations(user: User = Depends(get_current_user)):
    user_phone = None
    full = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    if full and full.get("verification_data"):
        user_phone = full["verification_data"].get("phone")
    or_clauses: List[Dict[str, Any]] = [
        {"invited_user_id": user.user_id},
        {"invited_email": user.email.lower()},
    ]
    if user_phone:
        or_clauses.append({"invited_phone": user_phone})
    cursor = db.invitations.find(
        {"$or": or_clauses, "status": "pending"},
        {"_id": 0},
    ).sort("created_at", -1)
    items = await cursor.to_list(100)
    return {"invitations": items}


@api_router.post("/rooms/invitations/{invitation_id}/accept")
async def accept_invitation(invitation_id: str, user: User = Depends(get_current_user)):
    inv = await db.invitations.find_one({"invitation_id": invitation_id}, {"_id": 0})
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.get("invited_user_id") not in (user.user_id, None) and inv.get(
        "invited_email"
    ) != user.email.lower():
        raise HTTPException(status_code=403, detail="Invitation not for this account")
    room = await db.rooms.find_one({"room_id": inv["room_id"]}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room no longer exists")
    if user.user_id not in room.get("members", []):
        await db.rooms.update_one(
            {"room_id": inv["room_id"]}, {"$addToSet": {"members": user.user_id}}
        )
    await db.invitations.update_one(
        {"invitation_id": invitation_id},
        {"$set": {"status": "accepted", "accepted_at": utcnow(), "invited_user_id": user.user_id}},
    )
    return {
        "ok": True,
        "room_id": inv["room_id"],
        "phrase_hint": "Ask the inviter for the phrase + PIN",
    }


@api_router.post("/rooms/invitations/{invitation_id}/decline")
async def decline_invitation(invitation_id: str, user: User = Depends(get_current_user)):
    inv = await db.invitations.find_one({"invitation_id": invitation_id}, {"_id": 0})
    if not inv:
        raise HTTPException(status_code=404, detail="Invitation not found")
    if inv.get("invited_user_id") not in (user.user_id, None) and inv.get(
        "invited_email"
    ) != user.email.lower():
        raise HTTPException(status_code=403, detail="Invitation not for this account")
    await db.invitations.update_one(
        {"invitation_id": invitation_id},
        {"$set": {"status": "declined", "declined_at": utcnow()}},
    )
    return {"ok": True}


@api_router.get("/rooms/{room_id}")
async def get_room(room_id: str, user: User = Depends(get_current_user)):
    room = await db.rooms.find_one(
        {"room_id": room_id, "members": user.user_id},
        {"_id": 0, "phrase_hash": 0, "pin_hash": 0},
    )
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    # Single bulk lookup for all members in this room (was an N+1 loop).
    member_ids = room.get("members", []) or []
    users_by_id: Dict[str, Dict[str, Any]] = {}
    if member_ids:
        cursor = db.users.find(
            {"user_id": {"$in": member_ids}},
            {"_id": 0, "verification_data": 0},
        )
        for u in await cursor.to_list(length=len(member_ids)):
            users_by_id[u["user_id"]] = u
    members = []
    owner_id = room.get("owner_user_id")
    for uid in member_ids:
        u = users_by_id.get(uid)
        if not u:
            continue
        members.append(
            {
                "user_id": u["user_id"],
                "name": u.get("name"),
                "picture": u.get("picture"),
                "verified": u.get("verified", False),
                "is_owner": uid == owner_id,
            }
        )
    room["members_detail"] = members
    return room


@api_router.post("/rooms/{room_id}/end")
async def end_room_session(room_id: str, user: User = Depends(get_current_user)):
    room = await db.rooms.find_one({"room_id": room_id, "members": user.user_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    msgs = await db.messages.find({"room_id": room_id}, {"_id": 0}).to_list(2000)
    if msgs:
        fragments = []
        expiry = utcnow() + timedelta(days=FORENSIC_RETENTION_DAYS)
        for m in msgs:
            fragments.append(
                {
                    "fragment_id": f"frag_{uuid.uuid4().hex[:12]}",
                    "room_id": room_id,
                    "encrypted_blob": encrypt_fragment(
                        f"[{m.get('content_type')}] {m.get('sender_user_id')}: "
                        f"{m.get('content','')[:200]}"
                    ),
                    "created_at": m.get("created_at", utcnow()),
                    "expires_at": expiry,
                    "ended_by": user.user_id,
                }
            )
        if fragments:
            await db.forensic_fragments.insert_many(fragments)
    await db.messages.delete_many({"room_id": room_id})
    await db.rooms.update_one(
        {"room_id": room_id},
        {
            "$set": {
                "session_active": False,
                "last_ended_at": utcnow(),
                "last_ended_by": user.user_id,
            }
        },
    )
    # broadcast end-of-conversation to other connected clients so they wipe
    # their local state and show "{name} left." notice.
    await ws_manager.broadcast(
        room_id,
        {
            "type": "ended",
            "by_user_id": user.user_id,
            "by_name": user.name,
        },
    )
    return {"ok": True, "wiped": True}


@api_router.post("/rooms/{room_id}/leave")
async def leave_room(room_id: str, user: User = Depends(get_current_user)):
    """Remove caller from members. If owner leaves, room is permanently closed."""
    room = await db.rooms.find_one({"room_id": room_id, "members": user.user_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    is_owner = room.get("owner_user_id") == user.user_id
    if is_owner:
        # close the room and wipe like end-conversation
        msgs = await db.messages.find({"room_id": room_id}, {"_id": 0}).to_list(2000)
        if msgs:
            expiry = utcnow() + timedelta(days=FORENSIC_RETENTION_DAYS)
            await db.forensic_fragments.insert_many([
                {
                    "fragment_id": f"frag_{uuid.uuid4().hex[:12]}",
                    "room_id": room_id,
                    "encrypted_blob": encrypt_fragment(
                        f"[{m.get('content_type')}] {m.get('sender_user_id')}: "
                        f"{m.get('content','')[:200]}"
                    ),
                    "created_at": m.get("created_at", utcnow()),
                    "expires_at": expiry,
                    "ended_by": user.user_id,
                }
                for m in msgs
            ])
        await db.messages.delete_many({"room_id": room_id})
        await db.rooms.update_one(
            {"room_id": room_id},
            {"$set": {"status": "ended", "session_active": False, "last_ended_at": utcnow(), "last_ended_by": user.user_id}},
        )
        await ws_manager.broadcast(
            room_id,
            {"type": "ended", "by_user_id": user.user_id, "by_name": user.name, "permanent": True},
        )
    else:
        await db.rooms.update_one(
            {"room_id": room_id}, {"$pull": {"members": user.user_id}}
        )
        await ws_manager.broadcast(
            room_id,
            {
                "type": "left",
                "by_user_id": user.user_id,
                "by_name": user.name,
            },
        )
    return {"ok": True, "owner": is_owner}


@api_router.post("/rooms/{room_id}/messages/{message_id}/read")
async def mark_message_read(
    room_id: str, message_id: str, user: User = Depends(get_current_user)
):
    """Mark a message as read by the caller.

    Behaviour by retention mode:
      • "on_refresh"   → only track read_by; never auto-delete here.
      • "5/10/15 min"  → when every OTHER member has read, schedule
                          delete_at = now + N minutes (does NOT delete yet,
                          the background sweeper handles the wipe).
    """
    room = await db.rooms.find_one({"room_id": room_id, "members": user.user_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    msg = await db.messages.find_one({"message_id": message_id, "room_id": room_id}, {"_id": 0})
    if not msg:
        return {"ok": True, "already_deleted": True}
    if msg.get("sender_user_id") == user.user_id:
        # readers do not include the sender
        return {"ok": True, "self": True}
    await db.messages.update_one(
        {"message_id": message_id, "room_id": room_id},
        {"$addToSet": {"read_by": user.user_id}},
    )
    msg = await db.messages.find_one({"message_id": message_id, "room_id": room_id}, {"_id": 0})
    if not msg:
        return {"ok": True}
    retention_mode = room.get("retention_mode") or "10min"
    other_members = [
        m for m in room.get("members", []) if m != msg.get("sender_user_id")
    ]
    read_by = set(msg.get("read_by") or [])
    if (
        retention_mode in _RETENTION_MINUTES
        and other_members
        and read_by.issuperset(other_members)
        and not msg.get("delete_at")
    ):
        minutes = _RETENTION_MINUTES[retention_mode]
        delete_at = utcnow() + timedelta(minutes=minutes)
        await db.messages.update_one(
            {"message_id": message_id, "room_id": room_id},
            {"$set": {"delete_at": delete_at}},
        )
        # Tell live clients that this message has a scheduled deletion so they
        # can render a countdown badge (handler is optional on the client).
        await ws_manager.broadcast(
            room_id,
            {
                "type": "scheduled_delete",
                "message_id": message_id,
                "delete_at": delete_at.isoformat(),
            },
        )
    return {"ok": True, "retention_mode": retention_mode}


@api_router.get("/users/{user_id}")
async def get_user_basic(user_id: str, user: User = Depends(get_current_user)):
    """Basic user info — accessible to anyone in a shared room."""
    target = await db.users.find_one({"user_id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    # only allow if the requester shares at least one active room with target
    shared = await db.rooms.find_one(
        {"members": {"$all": [user.user_id, user_id]}}, {"_id": 0}
    )
    if not shared and user.user_id != user_id and user.role not in ("admin", "super_admin"):
        raise HTTPException(status_code=403, detail="Not in a shared room")
    vd = target.get("verification_data") or {}
    return {
        "user_id": target["user_id"],
        "name": target.get("name"),
        "picture": target.get("picture"),
        "verified": target.get("verified", False),
        "country": vd.get("country") if target.get("verified") else None,
        "joined_at": target.get("created_at").isoformat()
        if isinstance(target.get("created_at"), datetime)
        else target.get("created_at"),
        "status": target.get("status", "active"),
    }


@api_router.get("/rooms/{room_id}/messages")
async def list_messages(room_id: str, user: User = Depends(get_current_user)):
    room = await db.rooms.find_one({"room_id": room_id, "members": user.user_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    msgs = await db.messages.find({"room_id": room_id}, {"_id": 0}).sort("created_at", 1).to_list(500)
    return {"messages": [_serialize_message(m) for m in msgs]}


@api_router.post("/rooms/{room_id}/messages")
async def send_message(
    room_id: str, payload: MessageInput, user: User = Depends(get_current_user)
):
    if user.status in ("suspended", "blacklisted"):
        raise HTTPException(status_code=403, detail="Account restricted")
    room = await db.rooms.find_one({"room_id": room_id, "members": user.user_id}, {"_id": 0})
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if payload.content_type not in ("text", "voice", "image"):
        raise HTTPException(status_code=400, detail="Invalid content_type")
    if not payload.content:
        raise HTTPException(status_code=400, detail="Empty content")
    # Free-tier image quota: 3 images per day per user (across all rooms).
    if payload.content_type == "image":
        user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
        if not _is_premium_active(user_doc or {}):
            day_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
            count = await db.messages.count_documents(
                {
                    "sender_user_id": user.user_id,
                    "content_type": "image",
                    "created_at": {"$gte": day_start},
                }
            )
            if count >= FREE_IMAGES_PER_DAY:
                raise HTTPException(
                    status_code=402,
                    detail=(
                        f"Free tier allows {FREE_IMAGES_PER_DAY} images per day. "
                        "Upgrade to Consentalk Presence for unlimited media."
                    ),
                )
    msg = {
        "message_id": f"msg_{uuid.uuid4().hex[:14]}",
        "room_id": room_id,
        "sender_user_id": user.user_id,
        "sender_name": user.name,
        "sender_picture": user.picture,
        "content_type": payload.content_type,
        "content": payload.content,
        "created_at": utcnow(),
    }
    insert_doc = msg.copy()
    await db.messages.insert_one(insert_doc)
    serialized = _serialize_message(msg)
    await db.rooms.update_one(
        {"room_id": room_id}, {"$set": {"last_active": utcnow(), "session_active": True}}
    )
    await ws_manager.broadcast(room_id, {"type": "message", "message": serialized})
    return serialized


def _serialize_message(m: Dict[str, Any]) -> Dict[str, Any]:
    out = {k: v for k, v in m.items() if k != "_id"}
    if isinstance(out.get("created_at"), datetime):
        out["created_at"] = out["created_at"].isoformat()
    return out


# ---------------------------------------------------------------------------
# Reports / Safety
# ---------------------------------------------------------------------------
@api_router.post("/reports")
async def create_report(payload: ReportInput, user: User = Depends(get_current_user)):
    if not payload.reason or not payload.reason.strip():
        raise HTTPException(status_code=400, detail="Reason required")
    target_user = None
    if payload.reported_user_id:
        target_user = await db.users.find_one({"user_id": payload.reported_user_id}, {"_id": 0})
    elif payload.reported_user_email:
        target_user = await db.users.find_one(
            {"email": payload.reported_user_email.lower()}, {"_id": 0}
        )
    if not target_user:
        raise HTTPException(status_code=404, detail="Reported user not found")
    if target_user["user_id"] == user.user_id:
        raise HTTPException(status_code=400, detail="Cannot report yourself")
    report_id = f"rep_{uuid.uuid4().hex[:12]}"
    await db.reports.insert_one(
        {
            "report_id": report_id,
            "reporter_user_id": user.user_id,
            "reporter_name": user.name,
            "reported_user_id": target_user["user_id"],
            "reported_user_email": target_user["email"],
            "reported_user_name": target_user.get("name"),
            "room_id": payload.room_id,
            "reason": payload.reason.strip(),
            "details": (payload.details or "").strip(),
            "status": "open",
            "created_at": utcnow(),
        }
    )
    new_score = (target_user.get("risk_score", 0) or 0) + 1
    current_status = target_user.get("status", "active")
    if current_status == "blacklisted":
        new_status = "blacklisted"
    else:
        # monotonic risk tiers — pick highest tier reached, regardless of current
        if new_score >= 8:
            new_status = "suspended"
        elif new_score >= 5:
            new_status = "restricted"
        elif new_score >= 3:
            new_status = "warned"
        else:
            new_status = current_status if current_status != "active" else "active"
    await db.users.update_one(
        {"user_id": target_user["user_id"]},
        {"$set": {"risk_score": new_score, "status": new_status}},
    )
    return {"report_id": report_id}


@api_router.get("/reports/mine")
async def my_reports(user: User = Depends(get_current_user)):
    cursor = db.reports.find({"reporter_user_id": user.user_id}, {"_id": 0}).sort("created_at", -1)
    items = await cursor.to_list(200)
    return {"reports": items}


# ---------------------------------------------------------------------------
# Transparency
# ---------------------------------------------------------------------------
@api_router.get("/transparency/sessions")
async def my_sessions(user: User = Depends(get_current_user)):
    cursor = db.user_sessions.find(
        {"user_id": user.user_id}, {"_id": 0, "session_token": 0}
    ).sort("created_at", -1)
    items = await cursor.to_list(50)
    return {"sessions": items}


@api_router.get("/transparency/summary")
async def transparency_summary(user: User = Depends(get_current_user)):
    sessions_count = await db.user_sessions.count_documents({"user_id": user.user_id})
    rooms_count = await db.rooms.count_documents({"members": user.user_id, "status": "active"})
    forensic_total = await db.forensic_fragments.count_documents(
        {"expires_at": {"$gt": utcnow()}}
    )
    return {
        "active_sessions": sessions_count,
        "active_rooms": rooms_count,
        "forensic_window_days": FORENSIC_RETENTION_DAYS,
        "forensic_fragments_global_active": forensic_total,
        "plaintext_chats_stored": 0,
    }


# ---------------------------------------------------------------------------
# Admin & Super Admin
# ---------------------------------------------------------------------------
@api_router.get("/admin/users")
async def admin_users(admin: User = Depends(require_admin)):
    cursor = db.users.find({}, {"_id": 0, "verification_data": 0}).sort("created_at", -1)
    items = await cursor.to_list(500)
    return {"users": items}


@api_router.get("/admin/reports")
async def admin_reports(admin: User = Depends(require_admin)):
    cursor = db.reports.find({}, {"_id": 0}).sort("created_at", -1)
    items = await cursor.to_list(500)
    return {"reports": items}


@api_router.post("/admin/users/action")
async def admin_action(payload: AdminActionInput, admin: User = Depends(require_admin)):
    target = await db.users.find_one({"user_id": payload.target_user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    valid = {
        "warn": "warned",
        "restrict": "restricted",
        "require_phone": "restricted",
        "suspend": "suspended",
        "blacklist": "blacklisted",
        "reactivate": "active",
    }
    if payload.action not in valid:
        raise HTTPException(status_code=400, detail="Invalid action")
    if payload.action == "blacklist" and admin.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only super admin can blacklist")
    new_status = valid[payload.action]
    update: Dict[str, Any] = {"$set": {"status": new_status}}
    if payload.action == "reactivate":
        update["$set"]["risk_score"] = 0
    await db.users.update_one({"user_id": payload.target_user_id}, update)
    await db.admin_actions.insert_one(
        {
            "action_id": f"act_{uuid.uuid4().hex[:12]}",
            "admin_user_id": admin.user_id,
            "admin_name": admin.name,
            "target_user_id": payload.target_user_id,
            "action": payload.action,
            "reason": (payload.reason or "").strip(),
            "created_at": utcnow(),
        }
    )
    user_doc = await db.users.find_one({"user_id": payload.target_user_id}, {"_id": 0})
    return {"ok": True, "user": user_doc}


@api_router.post("/admin/users/role")
async def admin_role(payload: AdminRoleInput, super_admin: User = Depends(require_super_admin)):
    if payload.role not in ("user", "admin", "super_admin"):
        raise HTTPException(status_code=400, detail="Invalid role")
    target = await db.users.find_one({"user_id": payload.target_user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    if target["email"] == SUPER_ADMIN_EMAIL and payload.role != "super_admin":
        raise HTTPException(
            status_code=403, detail="Cannot demote the platform super admin"
        )
    await db.users.update_one(
        {"user_id": payload.target_user_id}, {"$set": {"role": payload.role}}
    )
    await db.admin_actions.insert_one(
        {
            "action_id": f"act_{uuid.uuid4().hex[:12]}",
            "admin_user_id": super_admin.user_id,
            "admin_name": super_admin.name,
            "target_user_id": payload.target_user_id,
            "action": f"role_change:{payload.role}",
            "reason": "",
            "created_at": utcnow(),
        }
    )
    user_doc = await db.users.find_one({"user_id": payload.target_user_id}, {"_id": 0})
    return {"ok": True, "user": user_doc}


@api_router.get("/admin/forensic")
async def admin_forensic(super_admin: User = Depends(require_super_admin)):
    cursor = db.forensic_fragments.find({}, {"_id": 0}).sort("created_at", -1).limit(200)
    items = await cursor.to_list(200)
    for it in items:
        it["preview"] = decrypt_fragment(it.get("encrypted_blob", ""))
        if isinstance(it.get("created_at"), datetime):
            it["created_at"] = it["created_at"].isoformat()
        if isinstance(it.get("expires_at"), datetime):
            it["expires_at"] = it["expires_at"].isoformat()
    return {"fragments": items, "retention_days": FORENSIC_RETENTION_DAYS}


@api_router.get("/admin/audit")
async def admin_audit(admin: User = Depends(require_admin)):
    cursor = db.admin_actions.find({}, {"_id": 0}).sort("created_at", -1).limit(200)
    items = await cursor.to_list(200)
    for it in items:
        if isinstance(it.get("created_at"), datetime):
            it["created_at"] = it["created_at"].isoformat()
    return {"actions": items}


# ---------------------------------------------------------------------------
# Billing & Premium (Iteration 3)
# ---------------------------------------------------------------------------
@api_router.get("/billing/plans")
async def billing_plans():
    return {
        "plans": list(PLANS.values()),
        "free_tier": {
            "rooms_per_day": FREE_ROOMS_PER_DAY,
            "images_per_day": FREE_IMAGES_PER_DAY,
            "features": [
                "Voice phrase access",
                "Basic encrypted messaging",
                "Force exit safety tools",
                "Unlimited room joining",
                f"{FREE_IMAGES_PER_DAY} images per day",
                f"{FREE_ROOMS_PER_DAY} room creation per day",
            ],
        },
        "trial_days": TRIAL_DAYS,
        "premium_features": [
            "Unlimited room creation",
            "Unlimited media sharing",
            "Uninterrupted room continuity",
            "Consentalk Deep mode access",
            "Multi-device continuity",
            "Trusted Circles",
            "Priority safety support",
            "Premium Presence badge",
        ],
    }


@api_router.get("/billing/me")
async def billing_me(user: User = Depends(get_current_user)):
    user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")
    active = _is_premium_active(user_doc)
    until = user_doc.get("premium_until")
    if isinstance(until, datetime):
        until_iso = until.isoformat()
    else:
        until_iso = until
    return {
        "is_premium": active,
        "premium_until": until_iso,
        "premium_plan": user_doc.get("premium_plan"),
        "is_admin_unlimited": user.role in ("admin", "super_admin"),
        "trial_used": bool(user_doc.get("trial_used")),
        "trial_days": TRIAL_DAYS,
    }


@api_router.post("/billing/start-trial")
async def billing_start_trial(user: User = Depends(get_current_user)):
    user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")
    if user_doc.get("trial_used"):
        raise HTTPException(status_code=400, detail="Free trial already used on this account")
    if _is_premium_active(user_doc):
        raise HTTPException(status_code=400, detail="You already have an active premium")
    new_until = utcnow() + timedelta(days=TRIAL_DAYS)
    await db.users.update_one(
        {"user_id": user.user_id},
        {
            "$set": {
                "is_premium": True,
                "premium_plan": "trial",
                "premium_until": new_until,
                "trial_used": True,
                "trial_started_at": utcnow(),
            }
        },
    )
    await db.billing_events.insert_one(
        {
            "event_id": f"bill_{uuid.uuid4().hex[:12]}",
            "user_id": user.user_id,
            "type": "trial_start",
            "premium_until": new_until,
            "created_at": utcnow(),
        }
    )
    return {"ok": True, "premium_until": new_until.isoformat(), "trial_days": TRIAL_DAYS}


@api_router.post("/billing/subscribe")
async def billing_subscribe(payload: SubscribeInput, user: User = Depends(get_current_user)):
    """MOCKED subscribe — in production this would integrate with Razorpay/Stripe.
    For MVP we mark the user premium immediately and log it for transparency."""
    plan = PLANS.get(payload.plan_id)
    if not plan:
        raise HTTPException(status_code=400, detail="Unknown plan")
    user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    base = utcnow()
    until_existing = (user_doc or {}).get("premium_until")
    if isinstance(until_existing, datetime):
        existing = until_existing.replace(tzinfo=timezone.utc) if until_existing.tzinfo is None else until_existing
        if existing > base:
            base = existing
    new_until = base + timedelta(days=plan["days"])
    await db.users.update_one(
        {"user_id": user.user_id},
        {
            "$set": {
                "is_premium": True,
                "premium_plan": plan["id"],
                "premium_until": new_until,
            }
        },
    )
    await db.billing_events.insert_one(
        {
            "event_id": f"bill_{uuid.uuid4().hex[:12]}",
            "user_id": user.user_id,
            "type": "subscribe_self_mocked",
            "plan_id": plan["id"],
            "amount": plan["price"],
            "currency": plan["currency"],
            "premium_until": new_until,
            "created_at": utcnow(),
        }
    )
    return {
        "ok": True,
        "mocked": True,
        "premium_until": new_until.isoformat(),
        "plan": plan,
    }


@api_router.post("/billing/cancel")
async def billing_cancel(user: User = Depends(get_current_user)):
    """User-initiated downgrade — premium runs out at the existing premium_until,
    but plan auto-renew is turned off (we do not auto-renew anyway in this MVP)."""
    await db.billing_events.insert_one(
        {
            "event_id": f"bill_{uuid.uuid4().hex[:12]}",
            "user_id": user.user_id,
            "type": "cancel_self",
            "created_at": utcnow(),
        }
    )
    return {"ok": True}


@api_router.get("/admin/billing/users")
async def admin_billing_users(admin: User = Depends(require_admin)):
    if admin.role != "super_admin" and "billing.view" not in (admin.permissions or []):
        raise HTTPException(status_code=403, detail="billing.view required")
    cursor = db.users.find(
        {"is_premium": True}, {"_id": 0, "verification_data": 0}
    ).sort("premium_until", -1)
    items = await cursor.to_list(500)
    for it in items:
        if isinstance(it.get("premium_until"), datetime):
            it["premium_until"] = it["premium_until"].isoformat()
        if isinstance(it.get("created_at"), datetime):
            it["created_at"] = it["created_at"].isoformat()
        if isinstance(it.get("last_active"), datetime):
            it["last_active"] = it["last_active"].isoformat()
    return {"users": items}


@api_router.post("/admin/billing/grant")
async def admin_billing_grant(
    payload: GrantPremiumInput, admin: User = Depends(require_admin)
):
    if admin.role != "super_admin" and "billing.grant" not in (admin.permissions or []):
        raise HTTPException(status_code=403, detail="billing.grant required")
    plan = PLANS.get(payload.plan_id)
    if not plan:
        raise HTTPException(status_code=400, detail="Unknown plan")
    target = await db.users.find_one({"user_id": payload.target_user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    days = payload.days if payload.days is not None else plan["days"]
    base = utcnow()
    existing = target.get("premium_until")
    if isinstance(existing, datetime):
        existing_aware = (
            existing.replace(tzinfo=timezone.utc) if existing.tzinfo is None else existing
        )
        if existing_aware > base:
            base = existing_aware
    new_until = base + timedelta(days=int(days))
    await db.users.update_one(
        {"user_id": payload.target_user_id},
        {
            "$set": {
                "is_premium": True,
                "premium_plan": plan["id"],
                "premium_until": new_until,
            }
        },
    )
    await db.billing_events.insert_one(
        {
            "event_id": f"bill_{uuid.uuid4().hex[:12]}",
            "user_id": payload.target_user_id,
            "type": "admin_grant",
            "by_user_id": admin.user_id,
            "by_name": admin.name,
            "plan_id": plan["id"],
            "days": int(days),
            "premium_until": new_until,
            "created_at": utcnow(),
        }
    )
    await db.admin_actions.insert_one(
        {
            "action_id": f"act_{uuid.uuid4().hex[:12]}",
            "admin_user_id": admin.user_id,
            "admin_name": admin.name,
            "target_user_id": payload.target_user_id,
            "action": f"premium_grant:{plan['id']}:{int(days)}d",
            "reason": "",
            "created_at": utcnow(),
        }
    )
    return {"ok": True, "premium_until": new_until.isoformat()}


@api_router.post("/admin/billing/revoke")
async def admin_billing_revoke(
    payload: GrantPremiumInput, admin: User = Depends(require_admin)
):
    if admin.role != "super_admin" and "billing.revoke" not in (admin.permissions or []):
        raise HTTPException(status_code=403, detail="billing.revoke required")
    target = await db.users.find_one({"user_id": payload.target_user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    await db.users.update_one(
        {"user_id": payload.target_user_id},
        {
            "$set": {
                "is_premium": False,
                "premium_until": None,
                "premium_plan": None,
            }
        },
    )
    await db.billing_events.insert_one(
        {
            "event_id": f"bill_{uuid.uuid4().hex[:12]}",
            "user_id": payload.target_user_id,
            "type": "admin_revoke",
            "by_user_id": admin.user_id,
            "by_name": admin.name,
            "created_at": utcnow(),
        }
    )
    await db.admin_actions.insert_one(
        {
            "action_id": f"act_{uuid.uuid4().hex[:12]}",
            "admin_user_id": admin.user_id,
            "admin_name": admin.name,
            "target_user_id": payload.target_user_id,
            "action": "premium_revoke",
            "reason": "",
            "created_at": utcnow(),
        }
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# RBAC (Iteration 3)
# ---------------------------------------------------------------------------
@api_router.get("/admin/permissions")
async def admin_permissions(admin: User = Depends(require_admin)):
    return {"catalog": PERMISSION_CATALOG}


@api_router.get("/admin/roles")
async def admin_roles_list(admin: User = Depends(require_admin)):
    cursor = db.custom_roles.find({}, {"_id": 0}).sort("created_at", 1)
    items = await cursor.to_list(500)
    return {"roles": items}


@api_router.post("/admin/roles")
async def admin_roles_create(
    payload: CreateRoleInput, super_admin: User = Depends(require_super_admin)
):
    name = (payload.name or "").strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Role name too short")
    role_id = f"role_{uuid.uuid4().hex[:10]}"
    perms = [p for p in (payload.permissions or []) if p in PERMISSION_CATALOG]
    await db.custom_roles.insert_one(
        {
            "role_id": role_id,
            "name": name,
            "description": (payload.description or "").strip(),
            "permissions": perms,
            "created_by": super_admin.user_id,
            "created_at": utcnow(),
        }
    )
    return {"ok": True, "role_id": role_id, "permissions": perms}


@api_router.delete("/admin/roles/{role_id}")
async def admin_roles_delete(role_id: str, super_admin: User = Depends(require_super_admin)):
    res = await db.custom_roles.delete_one({"role_id": role_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Role not found")
    # Pull this role from any users' extra_roles list
    await db.users.update_many({}, {"$pull": {"extra_roles": role_id}})
    return {"ok": True}


@api_router.post("/admin/users/assign-role")
async def admin_assign_role(
    payload: AssignRoleInput, super_admin: User = Depends(require_super_admin)
):
    role = await db.custom_roles.find_one({"role_id": payload.role_id}, {"_id": 0})
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    target = await db.users.find_one({"user_id": payload.target_user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    # union the role's permissions onto user.permissions
    new_perms = list(set((target.get("permissions") or []) + role.get("permissions", [])))
    await db.users.update_one(
        {"user_id": payload.target_user_id},
        {
            "$set": {"permissions": new_perms},
            "$addToSet": {"extra_roles": payload.role_id},
        },
    )
    await db.admin_actions.insert_one(
        {
            "action_id": f"act_{uuid.uuid4().hex[:12]}",
            "admin_user_id": super_admin.user_id,
            "admin_name": super_admin.name,
            "target_user_id": payload.target_user_id,
            "action": f"role_assign:{role['name']}"
            + (":probationary" if payload.probationary else ""),
            "reason": "",
            "created_at": utcnow(),
        }
    )
    return {"ok": True, "permissions": new_perms}


@api_router.post("/admin/users/revoke-role")
async def admin_revoke_role(
    payload: AssignRoleInput, super_admin: User = Depends(require_super_admin)
):
    role = await db.custom_roles.find_one({"role_id": payload.role_id}, {"_id": 0})
    if not role:
        raise HTTPException(status_code=404, detail="Role not found")
    target = await db.users.find_one({"user_id": payload.target_user_id}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    other_roles = [
        r for r in (target.get("extra_roles") or []) if r != payload.role_id
    ]
    rebuilt: List[str] = []
    for r_id in other_roles:
        rd = await db.custom_roles.find_one({"role_id": r_id}, {"_id": 0})
        if rd:
            rebuilt += rd.get("permissions", [])
    await db.users.update_one(
        {"user_id": payload.target_user_id},
        {
            "$set": {
                "extra_roles": other_roles,
                "permissions": list(set(rebuilt)),
            }
        },
    )
    await db.admin_actions.insert_one(
        {
            "action_id": f"act_{uuid.uuid4().hex[:12]}",
            "admin_user_id": super_admin.user_id,
            "admin_name": super_admin.name,
            "target_user_id": payload.target_user_id,
            "action": f"role_revoke:{role['name']}",
            "reason": "",
            "created_at": utcnow(),
        }
    )
    return {"ok": True}


# ---------------------------------------------------------------------------
# Admin analytics
# ---------------------------------------------------------------------------
@api_router.get("/admin/analytics/summary")
async def admin_analytics(admin: User = Depends(require_admin)):
    if admin.role != "super_admin" and "analytics.view" not in (admin.permissions or []):
        raise HTTPException(status_code=403, detail="analytics.view required")
    total_users = await db.users.count_documents({})
    verified = await db.users.count_documents({"verified": True})
    premium = await db.users.count_documents(
        {"is_premium": True, "premium_until": {"$gt": utcnow()}}
    )
    rooms_active = await db.rooms.count_documents({"status": "active"})
    rooms_total = await db.rooms.count_documents({})
    reports_open = await db.reports.count_documents({"status": "open"})
    blacklisted = await db.users.count_documents({"status": "blacklisted"})
    suspended = await db.users.count_documents({"status": "suspended"})
    day_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    rooms_today = await db.rooms.count_documents({"created_at": {"$gte": day_start}})
    return {
        "users": {
            "total": total_users,
            "verified": verified,
            "premium": premium,
            "suspended": suspended,
            "blacklisted": blacklisted,
        },
        "rooms": {"total": rooms_total, "active": rooms_active, "today": rooms_today},
        "reports": {"open": reports_open},
    }


@api_router.get("/admin/billing/events")
async def admin_billing_events(admin: User = Depends(require_admin)):
    if admin.role != "super_admin" and "billing.view" not in (admin.permissions or []):
        raise HTTPException(status_code=403, detail="billing.view required")
    cursor = db.billing_events.find({}, {"_id": 0}).sort("created_at", -1).limit(200)
    items = await cursor.to_list(200)
    for it in items:
        if isinstance(it.get("created_at"), datetime):
            it["created_at"] = it["created_at"].isoformat()
        if isinstance(it.get("premium_until"), datetime):
            it["premium_until"] = it["premium_until"].isoformat()
    return {"events": items}


# ---------------------------------------------------------------------------
# Google Play Billing webhook (signed receipt → entitlement)
# ---------------------------------------------------------------------------
class GooglePlayReceipt(BaseModel):
    product_id: str  # presence_monthly | presence_yearly
    purchase_token: str
    order_id: Optional[str] = None
    purchase_state: int = 1  # 1=purchased, 0=cancelled, 2=pending


@api_router.post("/billing/google-play/verify-purchase")
async def google_play_verify(
    payload: GooglePlayReceipt, user: User = Depends(get_current_user)
):
    """Server-side activation after a Google Play purchase. In production
    this MUST verify the purchase_token against the Play Developer API using
    a service account. For MVP we trust the client signal but record the
    full receipt for auditability + later re-verification.
    """
    pid = payload.product_id
    if pid == "presence_monthly":
        days = 30
        plan_id = "monthly_inr"
    elif pid == "presence_yearly":
        days = 365
        plan_id = "yearly_inr"
    else:
        raise HTTPException(status_code=400, detail="Unknown product_id")

    if payload.purchase_state != 1:
        # cancelled / pending → ignore but log
        await db.billing_events.insert_one(
            {
                "event_id": f"bill_{uuid.uuid4().hex[:12]}",
                "user_id": user.user_id,
                "type": "gplay_pending_or_cancelled",
                "product_id": pid,
                "purchase_token": payload.purchase_token,
                "state": payload.purchase_state,
                "created_at": utcnow(),
            }
        )
        return {"ok": False, "state": payload.purchase_state}

    user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    base = utcnow()
    existing = (user_doc or {}).get("premium_until")
    if isinstance(existing, datetime):
        existing_aware = existing.replace(tzinfo=timezone.utc) if existing.tzinfo is None else existing
        if existing_aware > base:
            base = existing_aware
    new_until = base + timedelta(days=days)
    await db.users.update_one(
        {"user_id": user.user_id},
        {
            "$set": {
                "is_premium": True,
                "premium_plan": plan_id,
                "premium_until": new_until,
                "google_play_purchase_token": payload.purchase_token,
                "google_play_product_id": pid,
            }
        },
    )
    await db.billing_events.insert_one(
        {
            "event_id": f"bill_{uuid.uuid4().hex[:12]}",
            "user_id": user.user_id,
            "type": "gplay_purchase",
            "product_id": pid,
            "plan_id": plan_id,
            "purchase_token": payload.purchase_token,
            "order_id": payload.order_id,
            "premium_until": new_until,
            "created_at": utcnow(),
        }
    )
    return {
        "ok": True,
        "premium_until": new_until.isoformat(),
        "plan_id": plan_id,
    }


@api_router.post("/billing/restore")
async def billing_restore(user: User = Depends(get_current_user)):
    """Re-syncs billing entitlement from the latest stored receipt.
    For Google Play, in production this would query the Play Developer API
    using the stored purchase_token. For MVP we return the current state."""
    user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    if not user_doc:
        raise HTTPException(status_code=404, detail="User not found")
    active = _is_premium_active(user_doc)
    until = user_doc.get("premium_until")
    if isinstance(until, datetime):
        until_iso = until.isoformat()
    else:
        until_iso = until
    return {
        "is_premium": active,
        "premium_until": until_iso,
        "premium_plan": user_doc.get("premium_plan"),
        "google_play_product_id": user_doc.get("google_play_product_id"),
    }


# ---------------------------------------------------------------------------
# WebSocket manager (real-time room messaging)
# ---------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self) -> None:
        self.active: Dict[str, List[WebSocket]] = {}

    async def connect(self, room_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self.active.setdefault(room_id, []).append(ws)

    def disconnect(self, room_id: str, ws: WebSocket) -> None:
        if room_id in self.active and ws in self.active[room_id]:
            self.active[room_id].remove(ws)
            if not self.active[room_id]:
                self.active.pop(room_id, None)

    async def broadcast(self, room_id: str, payload: Dict[str, Any]) -> None:
        for ws in list(self.active.get(room_id, [])):
            try:
                await ws.send_json(payload)
            except Exception:
                self.disconnect(room_id, ws)


ws_manager = ConnectionManager()


@app.websocket("/api/ws/room/{room_id}")
async def websocket_room(websocket: WebSocket, room_id: str, token: str = ""):
    if not token:
        await websocket.close(code=4401)
        return
    session = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not session:
        await websocket.close(code=4401)
        return
    user_doc = await db.users.find_one({"user_id": session["user_id"]}, {"_id": 0})
    if not user_doc:
        await websocket.close(code=4401)
        return
    room = await db.rooms.find_one(
        {"room_id": room_id, "members": user_doc["user_id"]}, {"_id": 0}
    )
    if not room:
        await websocket.close(code=4404)
        return

    await ws_manager.connect(room_id, websocket)
    try:
        await ws_manager.broadcast(
            room_id,
            {
                "type": "presence",
                "event": "join",
                "user_id": user_doc["user_id"],
                "name": user_doc.get("name"),
            },
        )
        while True:
            data = await websocket.receive_json()
            kind = data.get("type")
            if kind == "ping":
                await websocket.send_json({"type": "pong"})
            elif kind == "typing":
                await ws_manager.broadcast(
                    room_id,
                    {
                        "type": "typing",
                        "user_id": user_doc["user_id"],
                        "name": user_doc.get("name"),
                    },
                )
            elif kind == "screenshot_request":
                # Manual consent flow — sender announces intent, others may allow/deny.
                await ws_manager.broadcast(
                    room_id,
                    {
                        "type": "screenshot_request",
                        "user_id": user_doc["user_id"],
                        "name": user_doc.get("name"),
                        "request_id": data.get("request_id", ""),
                    },
                )
            elif kind == "screenshot_response":
                await ws_manager.broadcast(
                    room_id,
                    {
                        "type": "screenshot_response",
                        "user_id": user_doc["user_id"],
                        "name": user_doc.get("name"),
                        "request_id": data.get("request_id", ""),
                        "allow": bool(data.get("allow")),
                    },
                )
    except WebSocketDisconnect:
        pass
    finally:
        ws_manager.disconnect(room_id, websocket)
        await ws_manager.broadcast(
            room_id,
            {"type": "presence", "event": "leave", "user_id": user_doc["user_id"]},
        )


# ---------------------------------------------------------------------------
# Mount + CORS
# ---------------------------------------------------------------------------
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


async def _retention_sweeper():
    """Background loop that hard-deletes messages whose `delete_at` has
    elapsed (set by mark_message_read for time-based retention modes) and
    broadcasts a `deleted` event so live clients can drop them from view."""
    while True:
        try:
            now = utcnow()
            cursor = db.messages.find(
                {"delete_at": {"$lte": now}}, {"_id": 0, "message_id": 1, "room_id": 1}
            )
            stale = await cursor.to_list(500)
            for m in stale:
                rid = m.get("room_id")
                mid = m.get("message_id")
                if not rid or not mid:
                    continue
                await db.messages.delete_one({"message_id": mid, "room_id": rid})
                try:
                    await ws_manager.broadcast(
                        rid, {"type": "deleted", "message_id": mid}
                    )
                except Exception:
                    pass
        except Exception as exc:  # pragma: no cover — defensive
            logger.warning("retention sweeper error: %s", exc)
        await asyncio.sleep(30)


@app.on_event("startup")
async def startup():
    await db.users.update_many(
        {"email": SUPER_ADMIN_EMAIL}, {"$set": {"role": "super_admin"}}
    )
    await db.forensic_fragments.delete_many({"expires_at": {"$lt": utcnow()}})
    # Kick off the retention sweeper as a background task.
    asyncio.create_task(_retention_sweeper())
    logger.info("Consentalk backend ready. Super admin: %s", SUPER_ADMIN_EMAIL)


@app.on_event("shutdown")
async def shutdown():
    client.close()
