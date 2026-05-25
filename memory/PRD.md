# Consentalk — Product Requirements Document

## Vision
A privacy-first, consent-based, ephemeral communication mobile app where rooms are invisible by default and only appear when a member intentionally summons them with a phrase + PIN. Tagline: **"Private by Presence."**

## Status
**Iteration 7 complete** — Backend 83/83 + new iter-7 suite 10/10. Frontend wiring of Iter-6 backend features done (image viewer, IAP+free-trial-first, join approvals, voice dictation).

## Monetisation
- **Free tier** — 1 room/day, 3 images/day, Light mode only
- **Presence (premium)** — Unlimited rooms, unlimited images, Deep mode (phrase + PIN), priority support
  - **3-day free trial** auto-applied before any charge (cannot be re-used per account)
  - **₹99 / month** (Google Play `presence_monthly`) or **$1.99 / month** (US)
  - **₹999 / year** (Google Play `presence_yearly`) or **$19.99 / year** (US)
  - Admin / super-admin accounts have unlimited entitlement automatically

## Core principles
- Privacy by design — phrases & PINs stored only as one-way SHA-256 hashes; no plaintext chat retention
- Consent-first moderation — single reports never trigger instant bans
- Lawful accountability — encrypted forensic fragments retained 90 days for safety review
- Calm, premium, non-cyberpunk visual language

## Implemented Features
### Authentication
- Emergent-managed Google OAuth (web + mobile via expo-web-browser)
- 7-day session tokens, stored in localStorage (web) / AsyncStorage (mobile)
- Auto super-admin promotion for `alwargiridhar@gmail.com` on first login

### Rooms
- Voice-summon flow — record voice → OpenAI Whisper-1 transcribe → match phrase hash
- Type-fallback always available
- PIN entry with on-screen keypad, 4–6 digits
- Duo (1+1) and Circle (≤8) room types
- Phrase + PIN combination → unique room (different PIN = different room, even with same phrase)
- Owner-only invites by email
- Force-exit / End conversation — wipes plaintext, archives encrypted forensic fragments

### Messaging (ephemeral)
- Text bubbles
- Voice notes (base64 m4a)
- Image attachments (base64)
- Real-time delivery via WebSockets (`/api/ws/room/{id}?token=…`)
- All wiped when room ends

### Safety & Moderation
- User reporting (email + reason + details)
- Risk-score auto-escalation: 3→warned, 5→restricted, 8→suspended (super-admin can blacklist)
- Identity verification (full name, DOB, country, phone, consent) → `verified` badge
- Admin/Super-admin console: users, reports, role changes, audit log
- Super-admin only: blacklist, role promotion, encrypted forensic fragment review (90-day window)

### Transparency
- Active sessions, active rooms, plaintext-stored counter (always 0), forensic-window (90 days)
- Session/device history view

### FAQ / Trust & Safety screen
- 9 in-app explainers covering privacy, monitoring, anonymity, ephemerality

## Tech stack
- **Frontend:** React Native (Expo SDK 54, expo-router), TypeScript, react-native-reanimated (mic-orb breathing), expo-av (recording), expo-image-picker
- **Backend:** FastAPI, MongoDB (motor), httpx, websockets
- **AI:** OpenAI Whisper-1 via emergentintegrations (Emergent LLM key)
- **Auth:** Emergent Google OAuth

## Key files
- `/app/backend/server.py` — all API & WS routes
- `/app/frontend/app/*` — expo-router screens
- `/app/frontend/src/components/*` — Logo, MicrophoneOrb, AmbientBackground, PinDots, Button
- `/app/design_guidelines.json` — visual blueprint
- `/app/memory/test_credentials.md` — test user seeding instructions

## Future enhancements
- Real Signal-style E2EE in place of base64 fragment placeholder
- Voiceprint biometric verification (currently phrase-based only)
- Phone-number escalation tier
- Multi-language support
- Reduced-motion accessibility toggle for mic-orb breathing animation
