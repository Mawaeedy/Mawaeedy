# Phase 1 schema reconciliation

This document records the additive migration from the legacy local state model to
the canonical Supabase/Postgres scheduling model. No legacy records are deleted
or copied by this migration.

| Entity | SQLite/JSON today | Supabase today | Target | Data migration | Breaking risk | Action |
|---|---|---|---|---|---|---|
| Users | `users[]` in `app_state` | `auth.users` | Supabase Auth UUID | Required, identity mapping needed | High | Keep legacy bridge; use authenticated UUID for new writes |
| Profiles | One global `profile` object | `profiles.id` references `auth.users`; `name`, `photo`, `slug` already exist | One profile per authenticated user using existing columns (`name`, `photo`, `slug`) plus `locale` | Required, only after identity mapping | Low | Reuse existing columns; add locale and ownership checks |
| Meeting types | Global `meetingTypes[]` | `meeting_types.owner_id` | Owner-scoped relational meeting types | Required | Medium | Extend existing table; no duplicate table |
| Availability | Display strings in `availability` | `availability_rules` rows | Schedule + interval + override tables | Required | Medium | Add structured tables; keep text rows as read-only bridge |
| Booking rules | `bookingRules` object | `booking_rules` | Owner-scoped relational booking rules | Required | Medium | Preserve existing table and constraints |
| Bookings | Global `bookings[]` with local date/time | `bookings` with `timestamptz` | Owner-scoped UTC bookings | Required | High | Extend existing table; migrate only classified records |
| Calendar connections | `integrations` flags + encrypted local token table | `integrations` mixed metadata/token table | `calendar_connections` metadata; secrets server-only | Required | High | Add metadata table; do not expose tokens |
| Team data | Global `teamMembers[]` | None in current schema | Deferred | Not in Phase 1 | Low | Leave legacy path untouched |

## Migration safety

- The migration is additive and uses `if not exists`/catalog checks.
- No table, column, row, or legacy state is deleted.
- Existing `profiles`, `meeting_types`, `availability_rules`, `booking_rules`,
  `bookings`, and `integrations` tables are extended rather than replaced.
- `availability_rules` and `integrations` remain legacy bridges until the service
  layer is moved in a later checkpoint.
- QA and ambiguous records are preserved for explicit classification.

## Canonical ownership rule

All new core rows use the authenticated Supabase user UUID. The application must
never infer ownership from the first profile, first user, global state, or a user
supplied owner ID.
