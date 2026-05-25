#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  Iteration 7 — Frontend wiring of the new backend features completed in Iteration 6:
  1. Wire up full-screen Image Viewer (pinch-to-zoom, swipe to close) in chat room.
  2. Wire up Google Play Billing UI in premium screen, with a 3-day free trial CTA before charging.
  3. Surface Light vs Deep mode + Join Approval workflow inside the room (owner sees pending requests with name+email and approves/rejects).
  4. Add live voice-to-text dictation directly into the chat input (in addition to voice notes).
  5. Confirm Android package name is com.consentalk.app (already set).
  6. Fix pricing text on profile to ₹99/mo.

frontend:
  - task: "Premium screen — 3-day free trial CTA + IAP wiring"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/premium.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Rebuilt premium screen with explicit 3-day free trial CTA via /billing/start-trial; subscription buttons call iap.purchaseSubscription which falls back to /billing/subscribe on web; status banner shows trial vs paid; restorePurchases wired."

  - task: "Full-screen Image Viewer in chat"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/room/[id].tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Wrapped image bubbles in Pressable to open ImageViewer modal (already created). Pinch/double-tap zoom + swipe-down close on native, double-tap+× on web."

  - task: "Join Approval banner — owner sees pending requests"
    implemented: true
    working: "NA"
    file: "/app/frontend/src/components/JoinRequestsBanner.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "New banner inside the room (owner only) that lists pending join requests with name + email, approve / reject buttons; refreshes on WS join_request events."

  - task: "Voice dictation into chat input"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/room/[id].tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Added dictate-to-text button in composer (web + native). Transcribes via /api/voice/transcribe and appends text to draft."

  - task: "Pricing copy fix on profile"
    implemented: true
    working: "NA"
    file: "/app/frontend/app/(tabs)/profile.tsx"
    stuck_count: 0
    priority: "low"
    needs_retesting: true
    status_history:
      - working: "NA"
        agent: "main"
        comment: "Changed caption to '3-day free trial · then ₹99/mo or ₹999/yr'."

backend:
  - task: "Backend endpoints for Iteration 6 (already complete & tested 83/83 in prior session)"
    implemented: true
    working: true
    file: "/app/backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "main"
        comment: "Light/Deep modes, /billing/start-trial, /billing/subscribe, /billing/google-play/verify-purchase, /rooms/{id}/request-join, /rooms/{id}/join-requests, /decision, and free-tier quotas all green from previous iteration."

metadata:
  created_by: "main_agent"
  version: "7.0"
  test_sequence: 5
  run_ui: false

test_plan:
  current_focus:
    - "Premium screen — 3-day free trial CTA + IAP wiring"
    - "Full-screen Image Viewer in chat"
    - "Join Approval banner — owner sees pending requests"
    - "Voice dictation into chat input"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: "Iteration 7 frontend wiring complete. Please test the four high-priority items end-to-end. Backend is already at 83/83 from prior iteration."