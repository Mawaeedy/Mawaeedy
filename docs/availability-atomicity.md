# Structured availability atomicity

The current runtime uses this interim authorization boundary:

```text
Browser
  → custom signed application session
  → Express requireAuth()
  → req.userId
  → server-side service-role Supabase client
  → replace_availability_intervals RPC
  → database verifies p_owner_id against the locked schedule owner
```

The RPC accepts `p_owner_id`, `p_schedule_id`, and `p_intervals` because the
current application identity is the Express session, not Supabase Auth. The
function locks the matching schedule with `SELECT ... FOR UPDATE`, validates
the complete JSON payload, then deletes and inserts intervals in one PostgreSQL
function invocation. A NULL or malformed payload is rejected; an empty array
intentionally clears all intervals.

The function is `SECURITY INVOKER`. It is granted only to `service_role`; it
is revoked from `PUBLIC`, `anon`, and `authenticated`. The service-role key
bypasses ordinary RLS and must remain server-only. It must never be included
in browser JavaScript, HTML, or API responses.

The future Supabase Auth architecture may use `auth.uid()` directly, but that
is outside this cutover.
