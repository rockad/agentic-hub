# Google Workspace: Rules & Guidelines

Governs email, calendar, and Drive actions via the `google-workspace` plugin.

- **Email & Confirmation Guardrails**: Never call `send_gmail_message` automatically; always use `draft_gmail_message` and display recipient, subject, and full body in chat for review. Modify calendar events, alter mailbox labels, or send emails only after explicit user confirmation.
- **Calendar Hygiene**: Read `get_events` and `query_freebusy` before proposing or modifying events; never overwrite, delete, or RSVP without clear user confirmation.
- **Targeted & Private Retrieval**: Use specific `query` filters and modest `page_size` limits instead of bulk downloads. Keep email/calendar details private and never log credentials or tokens.
