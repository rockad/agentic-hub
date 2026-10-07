# Google Workspace: Rules & Guidelines

This document governs email, calendar, and workspace actions for AI agents interacting with Google Workspace via the `google-workspace` plugin.

## 1. Safety & Communication Guardrails

- **Draft Replies Only**: Never call `send_gmail_message` automatically. Always use `draft_gmail_message` so the user can review and approve outgoing messages before transmission.
- **Explicit User Confirmation**: Sending emails, modifying existing calendar events, or altering mailbox labels must only occur after explicit user instruction and confirmation.
- **Preview Drafts**: Whenever a draft is created, display the recipient, subject line, and full body text clearly in the chat response.

## 2. Calendar Hygiene

- **Read Before Modify**: Check `get_events` and `query_freebusy` before proposing new calendar appointments or modifying schedules.
- **Preserve Existing Events**: Never overwrite, delete, or RSVP to events without clear confirmation from the user.

## 3. Privacy & Context Discipline

- **Targeted Retrieval**: Use specific search queries (`query`) and modest page limits (`page_size`) rather than downloading bulk mailboxes.
- **Privacy Protection**: Keep personal email bodies and sensitive calendar details private; avoid logging sensitive credentials or tokens in conversational transcripts.
