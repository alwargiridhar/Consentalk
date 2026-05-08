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


class SessionDataInput(BaseModel):
    session_id: str


class VerificationInput(BaseModel):
    full_legal_name: str
    date_of_birth: str
    country: str
    phone: str
    consent_acknowledged: bool


class CreateRoomInput(BaseModel):
    name: str
    phrase: str
    pin: str
    room_type: str = "duo"


class SummonRoomInput(BaseModel):
    phrase: str
    pin: str


class InviteInput(BaseModel):
    email: str


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
    await db.users.update_one(
        {"user_id": user.user_id},
        {
            "$set": {
                "verified": True,
                "verification_data": {
                    "full_legal_name": payload.full_legal_name.strip(),
                    "date_of_birth": payload.date_of_birth.strip(),
                    "country": payload.country.strip(),
                    "phone": payload.phone.strip(),
                    "verified_at": utcnow().isoformat(),
                },
            }
        },
    )
    user_doc = await db.users.find_one({"user_id": user.user_id}, {"_id": 0})
    return User(**user_doc)


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
        result = await stt.transcribe(file=tmp.name, model="whisper-1", response_format="json")
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
    if not payload.pin or len(payload.pin) < 4:
        raise HTTPException(status_code=400, detail="PIN must be at least 4 digits")
    if payload.room_type not in ("duo", "circle"):
        raise HTTPException(status_code=400, detail="Invalid room type")

    room_id = f"room_{uuid.uuid4().hex[:14]}"
    await db.rooms.insert_one(
        {
            "room_id": room_id,
            "owner_user_id": user.user_id,
            "name": payload.name.strip() or "Untitled Room",
            "room_type": payload.room_type,
            "phrase_hash": hash_phrase(phrase_norm),
            "pin_hash": hash_pin(payload.pin),
            "members": [user.user_id],
            "status": "active",
            "session_active": False,
            "created_at": utcnow(),
            "last_active": utcnow(),
        }
    )
    return {"room_id": room_id, "name": payload.name, "room_type": payload.room_type}


@api_router.post("/rooms/summon")
async def summon_room(payload: SummonRoomInput, user: User = Depends(get_current_user)):
    if user.status in ("suspended", "blacklisted"):
        raise HTTPException(status_code=403, detail="Account restricted")
    p_hash = hash_phrase(payload.phrase)
    pin_hash = hash_pin(payload.pin)
    rooms_cursor = db.rooms.find(
        {
            "phrase_hash": p_hash,
            "pin_hash": pin_hash,
            "members": user.user_id,
            "status": "active",
        },
        {"_id": 0, "phrase_hash": 0, "pin_hash": 0},
    )
    rooms = await rooms_cursor.to_list(50)
    if rooms:
        await db.rooms.update_many(
            {"room_id": {"$in": [r["room_id"] for r in rooms]}},
            {"$set": {"last_active": utcnow(), "session_active": True}},
        )
    return {"rooms": rooms}


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

    invitee = await db.users.find_one({"email": payload.email.lower()}, {"_id": 0})
    invitation_id = f"inv_{uuid.uuid4().hex[:12]}"
    await db.invitations.insert_one(
        {
            "invitation_id": invitation_id,
            "room_id": room_id,
            "room_name": room.get("name"),
            "room_type": room.get("room_type"),
            "inviter_user_id": user.user_id,
            "inviter_name": user.name,
            "invited_email": payload.email.lower(),
            "invited_user_id": invitee["user_id"] if invitee else None,
            "status": "pending",
            "created_at": utcnow(),
        }
    )
    return {"invitation_id": invitation_id, "linked_user": bool(invitee)}


@api_router.get("/rooms/invitations")
async def my_invitations(user: User = Depends(get_current_user)):
    cursor = db.invitations.find(
        {
            "$or": [
                {"invited_user_id": user.user_id},
                {"invited_email": user.email.lower()},
            ],
            "status": "pending",
        },
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
    members = []
    for uid in room.get("members", []):
        u = await db.users.find_one({"user_id": uid}, {"_id": 0, "verification_data": 0})
        if u:
            members.append(
                {
                    "user_id": u["user_id"],
                    "name": u.get("name"),
                    "picture": u.get("picture"),
                    "verified": u.get("verified", False),
                    "is_owner": uid == room.get("owner_user_id"),
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
    return {"ok": True, "wiped": True}


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
    new_status = target_user.get("status", "active")
    if new_score >= 8 and new_status != "blacklisted":
        new_status = "suspended"
    elif new_score >= 5 and new_status == "active":
        new_status = "restricted"
    elif new_score >= 3 and new_status == "active":
        new_status = "warned"
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


@app.on_event("startup")
async def startup():
    await db.users.update_many(
        {"email": SUPER_ADMIN_EMAIL}, {"$set": {"role": "super_admin"}}
    )
    await db.forensic_fragments.delete_many({"expires_at": {"$lt": utcnow()}})
    logger.info("Consentalk backend ready. Super admin: %s", SUPER_ADMIN_EMAIL)


@app.on_event("shutdown")
async def shutdown():
    client.close()
