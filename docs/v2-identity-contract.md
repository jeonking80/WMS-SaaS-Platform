# v2 identity API contract

All authenticated endpoints use the current Better Auth session and re-read active membership. Only admin manages identities; an account or key is listed and managed only when all its warehouse grants are inside the administrator’s explicit scope. Administrators can grant only their own warehouses. JSON mutations require Origin equal to BETTER_AUTH_URL. No public signup or tenant selection.

- `GET /api/v2/identity/context` → `{tenant:{id,name,isTest},environment:'test'|'production',idleLockMinutes:number,role,warehouseIds,warehouses:[{id,code,name}],assignees:[{userId,name,role,status,warehouseIds}],automationAccounts:[{userId,name,role,status,warehouseIds}]}`; allowed for all active users. Assignees share an allowed warehouse; only shared warehouse IDs are returned.
- `PATCH /api/v2/identity/settings` `{idleLockMinutes:integer 1..240}` → `{idleLockMinutes}`. Company administrator only; persisted in tenant settings and audited. Default 15 minutes.
- `GET /api/v2/identity/users` → `{users:[{userId,name,email,role,status,warehouseIds}],warehouses:[{id,code,name}]}`.
- `POST /api/v2/identity/users` `{name,email,role,warehouseIds,expiresInHours?}` → 201 `{userId,link,expiresAt}`. Link `/invitation?token=...` returned once only. Role `admin|supervisor|worker|viewer`. Status `invited|active|suspended|departed`.
- `PATCH /api/v2/identity/users/[id]` `{role?,status?:'active'|'suspended'|'departed',warehouseIds?}` → `{ok:true}`. Invited account activates only by accepting invitation. Departed accounts cannot reactivate. Last active administrator cannot be removed/demoted/suspended.
- `POST /api/v2/identity/users/[id]/link` `{kind:'invite'|'reset',expiresInHours?}` → `{link,expiresAt}`. Previous links invalidated. Default 24h, allowed 1–168h. Invite for invited users; reset for active users only.
- `DELETE /api/v2/identity/users/[id]/link` → `{ok:true}` cancels unconsumed links.
- `POST /api/v2/identity/accept` `{token,password}` → `{ok:true}`. Anonymous endpoint, same-origin required. Password 12–128 characters. Does not auto-login; navigate to `/login`. Token expired/consumed/revoked → `INVALID_LINK` 400. Password never returned.
- `GET /api/v2/identity/keys` → `{keys:[{id,name,sourceSystem,environment,kind,role,scopes,warehouseIds,expiresAt,revokedAt,createdAt,rotatedFrom}]}`; no secret/hash.
- `POST /api/v2/identity/keys` `{name,sourceSystem,environment:'test'|'production',kind:'integration'|'automation',role?:'worker'|'supervisor',scopes:string[],warehouseIds:string[],expiresAt?}` → 201 `{keyId,token}` once only. Keys require explicit nonempty warehouse scope. Integration scope examples `integration:event`, `integration:read`, `integration:process`, `master.write`, `read`; automation `read|write|approve|master.write`. Test keys require test server + tenant marked test. Automation always test-only. `approve` only automation supervisor role.
- `POST /api/v2/identity/keys/[id]/rotate` `{expiresAt?}` → 201 `{keyId,token}` once only; preserves source/scopes/warehouse settings, records `rotatedFrom`, and revokes the old key atomically. Already accepted events tied to the old key require an explicit authorized recovery after rotation.
- `DELETE /api/v2/identity/keys/[id]` → `{ok:true}`; next request denied.

Errors `{error:code}` with 400 invalid input/link, 401 unauthenticated, 403 forbidden/scope/environment, 404 missing, 409 conflict/last administrator. Responses no-store. Lists exclude token hashes.

Server: `requireV2Access(identity,warehouseId:string|null,permission:string):Promise<void>` exported from `src/server/v2/access.ts`. Permissions `read`, `write`, `approve`, `master.write`, `identity.manage`. `authenticateV2Machine(headers,permission,warehouseId?)` authenticates Bearer, returns Identity plus `{keyId,sourceSystem,environment,scopes,warehouseIds,kind}`. Call again for every request; no token cache. `environment` is WMS_ENVIRONMENT default production; test tenant flag is platform-controlled.

Lifecycle and key actions append immutable audit rows with actor, target, server request ID, safe permission metadata and processing time. No password, raw one-time token or request body is logged. Password hashes use the existing `better-auth/crypto` credential schema. Public signup remains disabled.

Shared terminals use two complementary idle limits: UI counts human input and signs out when `idleLockMinutes` elapses; server independently checks `session.last_protected_at` on each protected request, conditionally refreshes it, and deletes an idle session before returning 401. Auth-library get-session polling alone cannot extend this window. The server measures protected HTTP request activity; UI background polling does not replace the human-input timer.

`automationAccounts` is empty outside a test company and test server. Candidates are unrevoked, unexpired test automation keys with both read and write scopes; returned warehouse IDs are intersected with the current user’s grants. Integration keys and approval-only keys are excluded. The identifier is `machine:<key UUID>`; no token or digest is returned.
