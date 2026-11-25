# FinMarket-Enterprise

**Financial Advisory Marketing and Client Acquisition Platform**

## 1. Project Overview

FinMarket-Enterprise is a full-stack web application designed to help financial advisory businesses automate marketing activities, manage prospective clients, and improve client acquisition.

The platform provides a centralized environment where financial advisors and marketing specialists can manage marketing campaigns, organize prospective clients, automate email communications, publish promotional content to authorized Facebook Pages, and monitor marketing performance.

The project focuses on reducing repetitive manual marketing tasks while improving operational efficiency, communication consistency, and lead management.

## 2. Business Case Definition

### 2.1 Business Problem

Marketing is an essential part of operating a financial advisory business. Financial advisors must regularly promote their services, communicate with potential clients, organize marketing campaigns, and follow up with interested prospects.

However, many of these activities are performed manually or through separate applications.

For example, a financial advisor may maintain contact information in spreadsheets, prepare promotional emails individually, publish marketing content on social media, and manually track client responses.

This approach creates several operational challenges:

- **Time-consuming processes:** Repetitive activities such as sending marketing emails and scheduling follow-ups require manual effort.
- **Fragmented information:** Client information, marketing campaigns, and communication history may be stored across different systems.
- **Missed opportunities:** Without automated reminders and follow-ups, potential clients may not receive timely communication.
- **Limited performance tracking:** Advisors may struggle to determine which marketing campaigns generate interest or lead to consultations.
- **Inconsistent marketing:** Manually managing campaigns across multiple communication channels increases the risk of inconsistent messaging.

These challenges demonstrate the need for a centralized marketing automation and client acquisition platform.

### 2.2 Proposed Solution

FinMarket-Enterprise provides a centralized web application that allows financial advisory businesses to manage marketing activities through a single platform.

The application supports:

1. **User and Advisor Management:** Create user accounts, manage advisor profiles, and assign access permissions.
2. **Lead Management:** Register prospective clients, maintain contact information, and track lead status.
3. **Marketing Campaign Management:** Create marketing campaigns, define target audiences, and manage reusable promotional templates.
4. **Email and Facebook Marketing:** Send authorized bulk marketing emails using Gmail SMTP and publish text-based promotional posts to authorized Facebook Pages through the Meta Graph API.
5. **Marketing Automation:** Configure rule-based actions that respond to business events, such as new leads or consultation requests.
6. **Marketing Analytics:** Monitor campaign activity, delivery results, lead status, and conversion performance.

By combining these capabilities, the platform aims to reduce manual marketing work and improve the process of attracting and converting prospective clients.

### 2.3 Business Objectives

The primary objectives of FinMarket-Enterprise are to:

- Automate repetitive marketing activities.
- Centralize lead and marketing campaign information.
- Improve communication between financial advisors and prospective clients.
- Support organized and timely follow-ups.
- Enable marketing activities across email and Facebook.
- Track potential clients through the acquisition process.
- Provide campaign performance information through a centralized dashboard.
- Protect business data through authentication, authorization, and backend validation.

### 2.4 Target Users and Access Roles

FinMarket-Enterprise supports three primary user roles.

| User Role | Responsibilities |
|---|---|
| Administrator | Manage user accounts, advisor access, platform permissions, and administrative settings. |
| Financial Advisor | Manage professional profiles, prospective clients, marketing campaigns, and consultation activities. |
| Marketing Specialist | Prepare marketing campaigns, manage approved promotional content, schedule communications, and monitor campaign results. |

Access permissions are enforced by the backend rather than relying only on frontend restrictions.

For example, a marketing specialist may be permitted to prepare campaign content but must not automatically receive permission to modify administrator accounts.

## 3. Core Business Modules

### 3.1 Identity and Advisor Management

This module manages user registration, authentication, roles, and financial advisor profiles.

Financial advisors can maintain professional information, including specialties and available consultation types.

Administrators are responsible for managing user access and ensuring that restricted operations are available only to authorized users.

### 3.2 Lead Management (CRM)

The Lead Management module provides a centralized system for organizing prospective clients.

A lead represents an individual who may be interested in receiving financial advisory services.

The module supports creating, retrieving, updating, searching, and filtering lead records.

Each lead may progress through the following lifecycle:

**NEW → CONTACTED → CONSULTATION_REQUESTED → CONVERTED**

Marketing consent is also recorded to determine whether a lead is eligible to receive promotional emails.

### 3.3 Marketing Campaign Management

Financial advisors and authorized marketing specialists can create and manage marketing campaigns.

Supported marketing strategies may include:

- Retirement planning promotions.
- Investment education campaigns.
- Financial planning webinars.
- Insurance awareness campaigns.
- Consultation invitations.
- Informational newsletters.

Each campaign contains relevant information such as its title, description, target audience, associated advisor, and status.

Reusable message templates help maintain consistency across marketing communications.

### 3.4 Email and Facebook Delivery

This module is responsible for delivering marketing communications through supported channels.

**Email marketing:** The platform supports Gmail SMTP using Nodemailer to send authorized marketing emails to eligible recipients. Email delivery supports basic queuing, rate limiting, and delivery tracking.

**Facebook marketing:** The platform supports the Meta Graph API to publish text-based promotional posts to authorized Facebook Pages, subject to the necessary access permissions and approval.

Delivery records allow authorized users to review successful and failed marketing operations.

### 3.5 Marketing Automation and Analytics

The Marketing Automation module executes predefined actions when supported business events occur.

For example, when a new lead is registered, an automation rule may schedule a welcome email.

When a prospective client requests a consultation, another rule may schedule a follow-up notification.

The analytics functionality summarizes relevant business information, including:

- Number of registered leads.
- Number of active campaigns.
- Marketing delivery results.
- Consultation requests.
- Lead conversion rates.

## 4. Business Workflows

### 4.1 Identity and authentication

1. An Advisor or Marketing Specialist registers with a unique email. Passwords are hashed using Node.js `scrypt`; Advisor registration creates the user and profile in one MongoDB transaction.
2. Login validates credentials and account activity and returns a signed HS256 JWT. Protected requests send `Authorization: Bearer <token>`.
3. The shared middleware verifies signature, expiry, issuer, audience, account activity and token version, and resolves the Advisor profile from the authenticated user.
4. All roles can maintain their own account. Changing a password invalidates existing tokens; changing an email requires the current password.
5. Administrators are provisioned through a trusted CLI, not public registration. They can inspect permissions and deactivate/reactivate accounts; deactivation invalidates previous JWTs.

### 4.2 Advisor and specialist collaboration

An Advisor invites an active Marketing Specialist by user ID or email. The intended Specialist accepts or declines the pending invitation. Accepted relationships permit subsequent campaign assignment by the owning Advisor. The Specialist must have both an accepted relationship and a campaign assignment to access restricted campaign resources. The Advisor or Administrator can revoke an accepted relationship; revocation removes relationship-based access without deleting history.

### 4.3 Lead and campaign workflow

1. The authenticated Advisor creates a Lead; ownership is derived from the JWT. Lead status progresses `NEW → CONTACTED → CONSULTATION_REQUESTED → CONVERTED`.
2. Marketing consent is recorded explicitly. Withdrawal records an unsubscribe timestamp; re-consent clears it.
3. The Advisor creates a channel-specific reusable template and campaign, defining the strategy and audience.
4. Campaign activation validates the template and eligible recipients. Specialists assigned to a campaign can edit only permitted content fields and cannot independently activate campaigns.
5. Authorized callers queue deliveries for an active campaign. Eligibility and consent are checked again when processing; results and attempts are persisted.

### 4.4 Automation and analytics

Business events are recorded with unique event IDs. Enabled rules match supported triggers and create durable execution records. Due executions are claimed atomically; delayed follow-ups survive restarts. Email actions queue work through Delivery, not directly through SMTP. HTTP simulation produces simulated executions without sending messages. Analytics aggregate persisted business and automation data within the caller's authorized scope.

## 5. Business Rules and Data Requirements

- Normalized unique account emails; password hashes and token versions are not exposed in public user responses.
- Trusted identity and server-side authorization govern ownership; client-supplied IDs cannot grant access.
- Fixed role permissions are defined in code. Administration can inspect effective permissions but does not offer arbitrary runtime role/permission editing.
- Lead email uniqueness is scoped to each Advisor; consent is checked at audience selection, delivery queueing and dispatch.
- Campaign ownership cannot be changed through the API. State transitions, template ownership and channel compatibility are validated.
- Delivery jobs use atomic claims, explicit failure retries and optional idempotency keys. Automation prevents duplicate events and executions using unique indexes.
- MongoDB stores all business records persistently. Validation failures return structured errors; health checks report database availability.

## 6. Technology Stack

| Component | Technology |
|---|---|
| Backend | Node.js 22+, Express 5, ES modules |
| Database | MongoDB 7, single-node replica set `rs0`, Mongoose 9 |
| Security | Node.js scrypt, jsonwebtoken (HS256), Helmet, CORS |
| Delivery | Mock providers by default; Nodemailer Gmail SMTP and Meta Graph API adapters |
| Infrastructure | Docker Compose, NGINX 1.29 Alpine, named MongoDB volume |
| Testing | Node.js `node:test`, Postman, GitHub Actions |
| Frontend | React 19 / Vite scaffold; full integration is Phase III |
| Version control | Git and GitHub |

Backend layering: Route → authentication/authorization → Controller → Service → Repository → Mongoose Model → MongoDB. Cross-module services and adapters coordinate business operations. The backend runs as a non-root container user.

## 7. Project Development Phases

| Phase | Scope | Current status |
|---|---|---|
| I | Business case, schemas, initial in-memory APIs | Historical foundation |
| II | Persistent database, JWT, role/ownership checks, collaboration, delivery and automation | Implemented in current backend |
| III | Integrated React UI and deployment | Future work; frontend scaffold exists |

## 8. Team Responsibilities and Infrastructure

| Member | Module | Responsibility |
|---|---|---|
| 1 | Identity and Advisors | Shared infrastructure, authentication, account management, roles, Advisor profiles and relationships |
| 2 | Lead Management | CRM, lifecycle, consent, owner-scoped lead queries |
| 3 | Marketing Campaigns | Campaigns, templates, audiences, specialist assignments |
| 4 | Marketing Delivery | Queue, providers, eligibility, processing and history |
| 5 | Automation and Analytics | Events, rules, durable executions, follow-ups and analytics |

### 8.1 Infrastructure

```text
Client / Postman
       |
       v
NGINX :8080 (host) -> :80 (container)
       |
       v
Express backend :3001 (internal)
       |
       v
MongoDB :27017 (internal) -> mongodb_data
          replica set rs0
```

The current `docker-compose.yml` contains only `nginx`, `backend` and `mongodb`. MongoDB's health check initializes `rs0` if necessary and waits until the node becomes writable. There is no separate `mongo-init` service. Backend startup waits for MongoDB health; NGINX waits for backend health. The MongoDB port is not published to the host. The frontend is not served by this Compose stack.

### 8.2 First-time setup

Prerequisites: Git, Docker Desktop or Docker Engine with Compose v2; Postman for HTTP tests. Node.js 22+ is needed only for running Node commands outside Docker.

Clone the repository using its GitHub URL (repository access is required), enter the project root, then:

```bash
cp .env.example .env
openssl rand -hex 32
```

On PowerShell use `Copy-Item .env.example .env`; generate a cryptographically random secret using an available secure generator. Put the generated secret into `.env` as `JWT_SECRET` (at least 32 bytes). Keep the default MongoDB replica-set URI and mock delivery providers for local tests.

| Variable | Local setting / purpose |
|---|---|
| `NODE_ENV` | `development` |
| `PORT` | `3001` (Compose fixes backend port at 3001) |
| `NGINX_PORT` | `8080` (host-facing port) |
| `CORS_ORIGIN` | `http://localhost:8080` |
| `MONGO_URI` | `mongodb://mongodb:27017/finmarket_enterprise?replicaSet=rs0` |
| `JWT_SECRET` | Generate a new secret; never commit it |
| `JWT_EXPIRES_IN` | `1h` |
| `JWT_ISSUER` | `finmarket-enterprise` |
| `JWT_AUDIENCE` | `finmarket-api` |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | CLI provisioning inputs; default demo email `admin@example.com`, demo password `Password123!` |
| `DELIVERY_EMAIL_PROVIDER` | `mock` or `gmail` |
| `DELIVERY_FACEBOOK_PROVIDER` | `mock` or `meta` |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Required for real Gmail mode |
| `META_PAGE_ID`, `META_ACCESS_TOKEN` | Required for real Meta mode |

The example Administrator password is for disposable local demonstration only. Use different strong credentials elsewhere. Keep `.env` out of Git; `.env.example` is the shareable configuration template.

```bash
docker compose up -d --build
docker compose ps -a
curl http://localhost:8080/api/v1/health
```

Expected: three running healthy services and HTTP 200 with `data.database` equal to `CONNECTED`. The first startup can take longer while the replica set is elected.

### 8.3 Provision the Administrator (once per database)

The Compose backend does not automatically import `ADMIN_*` into the service environment. Pass these variables explicitly. The following values match the bundled local demo collection:

```bash
docker compose exec \
  -e ADMIN_NAME="Platform Administrator" \
  -e ADMIN_EMAIL="admin@example.com" \
  -e ADMIN_PASSWORD='Password123!' \
  backend npm run admin:provision
```

Expected: `Administrator account provisioned.` The script requires a password of at least 12 characters, validates the email, hashes the password, and rejects an existing email without modifying the account. For a non-demo account supply a different password privately. Changing `.env` or Postman variables does not update a stored password; use `PATCH /auth/me/password` while authenticated. Never provision an Administrator through `/auth/register`.

### 8.4 MongoDB access and persistence

```bash
docker compose exec mongodb mongosh --quiet --eval 'db.hello().isWritablePrimary'
docker compose exec mongodb mongosh finmarket_enterprise
```

Expected first output: `true`. In the shell use `show collections` and `db.leads.find().limit(5)`. MongoDB Compass cannot connect directly via a host port in the default Compose configuration. Database authentication and TLS are not configured for this local isolated development stack.

### 8.5 Running outside Docker (optional)

Use an independently running reachable MongoDB replica set and export the configuration variables in the shell (Node's current scripts do not automatically load the root `.env`). Use a URI reachable from the host, not the Docker service hostname. From `backend/`, run `npm ci`, then `npm start` or `npm run dev`. The default direct API port is 3001. This path is not required for the Docker setup.

### 8.6 Shutdown, rebuild and troubleshooting

```bash
docker compose logs --tail=100 backend
docker compose logs --tail=100 mongodb
docker compose down
docker compose up -d --build
```

`down` retains the named database volume. Do not use `down -v` unless intentionally deleting all local database records. If port 8080 is occupied, change `NGINX_PORT`, adjust `CORS_ORIGIN` and Postman's `baseUrl`. A 503 health response indicates database unavailability. A 401 Administrator login after changing `.env` usually means the stored credentials differ; verify the actual account before changing any data.

### 8.7 Shared identity and identifier contracts

`authenticate`, `authorizeRoles`, `authorizePermissions`, `requireActiveUser` and Advisor ownership checks are implemented in shared middleware. `req.auth`/`req.user` contains trusted `userId`, `role`, `advisorId` (when applicable), name and email. `authorizationService` resolves active accepted relationships. `userId`, `specialistUserId` and automation `ownerId` identify `User._id`; `advisorId` identifies `AdvisorProfile._id`. `campaignId`, `leadId`, `templateId`, `deliveryJobId` and `automationRuleId` identify their respective documents. An invitation/relationship ID identifies an `AdvisorSpecialistAssignment`; it is not a user or campaign ID. `eventId` is a deduplication string, not the ActivityEvent ObjectId.

## 9. Project Scope and Limitations

The platform is an educational marketing and client-acquisition backend, not a financial transaction system, portfolio manager or investment recommendation engine. Use fictional or explicitly authorized data. Mock delivery does not prove real-world sending. Real Gmail/Meta operation requires credentials, external permissions and provider compliance. Production deployment, public database security, frontend integration and production-scale worker operations are outside the verified local setup.

The Automation worker is started by `server.js`; the Delivery worker implementation exists, but the current server entry point does not start it. Use the explicit delivery processing endpoint for demonstrations. Do not assume a queued or scheduled delivery is automatically sent, or that a scheduled campaign automatically changes status when its date arrives.

## 10. Persistent Data Models

| Collection | Model | Main data / references |
|---|---|---|
| `users` | User | name, email (unique), passwordHash, role, isActive, tokenVersion |
| `advisorProfiles` | AdvisorProfile | unique userId, specialties, consultationTypes, bio, isPublic |
| `advisorSpecialistAssignments` | AdvisorSpecialistAssignment | advisorId, specialistUserId, status, acceptedAt, revokedAt; unique active pair |
| `leads` | Lead | advisorId, contact data, interest, status, source, consent and unsubscribe timestamps; unique advisor/email |
| `campaigns` | Campaign | advisorId, title, description, strategy, channel, audience, templateId, assignedSpecialistIds, status, schedule/completion |
| `templates` | Template | advisorId, name, channel, subject, body, isActive |
| `deliveryJobs` | DeliveryJob | campaign/advisor/lead/user references, content, status, provider, schedule, attempts, result/error, idempotency key |
| `automationRules` | AutomationRule | ownerId, campaignId, name, trigger/action, delay, enabled, actionConfig, specialist toggle, execution counters |
| `activityEvents` | ActivityEvent | unique eventId, event/entity type and ID, ownerId, campaignId, metadata, source, processing status |
| `automationExecutions` | AutomationExecution | eventId, rule ID, unique event/rule pair, schedule, status, attempts, lease, result/error |

Model definitions are under `backend/src/modules/*/models/`. References are validated in services; an ObjectId alone does not establish that a related record exists or is accessible.

## 11. Authorization Matrix

A = Administrator (`ADMIN`), F = Financial Advisor (`ADVISOR`), S = Marketing Specialist (`MARKETING_SPECIALIST`). A dash means no access through that operation; all protected access requires an active authenticated account.

| Operation | A | F | S |
|---|---|---|---|
| Public directory/login | Public | Public | Public |
| Public registration | Not allowed for ADMIN | Yes | Yes |
| Own account/password | Own | Own | Own |
| Advisor profile edit | — | Own | — |
| Invite/revoke Advisor relationship | Admin revoke via admin API | Own | — |
| Accept/decline invitation | — | — | Own invitation |
| List invitations/accepted relationships | Admin relationship review | Own | Own |
| Admin user/status/permissions | Yes | — | — |
| Leads | — | Own | — |
| Create campaign/template | — | Own | — |
| Read campaign/template | — | Own | Assigned + accepted relationship |
| Update campaign | — | Own, validated fields | Assigned; title, description, audience, permitted template only |
| Preview audience | — | Owned recipients and count | Assigned count only |
| Manage campaign specialist assignments | — | Own | — |
| Queue/process/retry delivery | — | Own | Assigned + accepted relationship |
| Read delivery | All | Own | Assigned + accepted relationship |
| Create automation/simulate | — | Own | — |
| Read automation/events/executions | All | Own | Assigned campaign scope |
| Update automation | — | Own | Enabled toggle only if explicitly allowed |
| Analytics summary | Platform | Own | Assigned campaign scope; no private leads |

Fixed permission codes (`identityConstants.js`):

- ADMIN: `MANAGE_OWN_ACCOUNT`, `MANAGE_USERS`, `MANAGE_PERMISSIONS`, `MANAGE_PLATFORM`, `REVIEW_ASSIGNMENTS`.
- ADVISOR: `MANAGE_OWN_ACCOUNT`, `MANAGE_OWN_PROFILE`, `MANAGE_OWN_LEADS`, `MANAGE_OWN_CAMPAIGNS`, `MANAGE_OWN_DELIVERIES`, `MANAGE_OWN_AUTOMATIONS`, `INVITE_SPECIALISTS`, `REVOKE_OWN_ASSIGNMENTS`.
- MARKETING_SPECIALIST: `MANAGE_OWN_ACCOUNT`, `RESPOND_TO_INVITATIONS`, `VIEW_ASSIGNED_CAMPAIGNS`, `MANAGE_PERMITTED_DELIVERIES`.

Feature-specific service checks also apply. Administrator access is not a universal bypass.

## 12. Business Specifications

### 12.1 Identity

Registration: name 2–100 characters, valid normalized email (maximum 254), password at least 8 characters and maximum 1024 bytes, role `ADVISOR` or `MARKETING_SPECIALIST`. Only Advisors may supply `profile` (`specialties`, `consultationTypes`, `bio`, `isPublic`); consultation types are `ONLINE`, `IN_PERSON`, `PHONE`; bio maximum 1000 characters. Public directory exposes only active public profiles. Account updates accept name/email and require currentPassword for email changes; password updates require currentPassword and a different newPassword. Relationship statuses: `PENDING → ACCEPTED/DECLINED`, `ACCEPTED → REVOKED`. Duplicate pending/accepted pairs are rejected. Admin cannot deactivate itself. Inactive users have no effective permissions.

### 12.2 Leads

Required fields: name (2–100), email (max 254), interest (max 150). Optional phone (max 30), notes (max 2000), status, source (`WEBSITE`, `FACEBOOK`, `MANUAL`, `OTHER`), marketingConsent (boolean, default false). Default status `NEW`, source `MANUAL`. Status changes cannot skip stages or move backward; same-status updates are allowed. Server owns consent timestamps. `advisorId` compatibility input must match the authenticated profile. List defaults page 1, limit 20, max 100.

### 12.3 Campaigns and templates

Campaign title 3–150, description max 2000, strategy `NEWSLETTER`, `RETIREMENT_PLANNING`, `INVESTMENT_EDUCATION`, `WEBINAR`, `CONSULTATION_OFFER`, `OTHER`; channel `EMAIL` or `FACEBOOK`. Audience is `{interests: string[], leadStatuses: string[]}`; empty arrays impose no filter. Template name 2–100, subject max 200, body required max 10000, isActive defaults true. Template channel must match campaign; subject defaults to an empty string (supply a meaningful subject for email). Campaign status defaults `DRAFT`.

| Current | Allowed next |
|---|---|
| DRAFT | SCHEDULED, ACTIVE, CANCELLED |
| SCHEDULED | DRAFT, ACTIVE, CANCELLED |
| ACTIVE | COMPLETED, CANCELLED |
| COMPLETED / CANCELLED | No further status transition |

Same-status updates are permitted subject to validation. `SCHEDULED` requires a future `scheduledAt`; activation requires an owned active matching template and at least one consenting subscribed lead. Specialist assignment requires an active accepted relationship and does not replace it. Campaign updates use version checks to reject concurrent modifications.

### 12.4 Delivery

Channels `EMAIL` and `FACEBOOK`. Public queue body accepts `campaignId`, `channel`, `content`, optional matching `advisorId`, `leadId`, `recipientEmail`, `scheduledAt`, `idempotencyKey`. Email requires an eligible lead; content has `subject` and `body` as applicable. Facebook uses text body. Campaign must be active, channel matching, and caller authorized. Recipient address must match the lead; consent, unsubscribe state and audience membership are rechecked. Future jobs cannot be manually processed until due. Status lifecycle `PENDING → PROCESSING → SENT/FAILED`; `CANCELLED` exists in the model, and explicit retry returns eligible `FAILED` jobs to `PENDING` (up to three attempts). No public cancel endpoint. Atomic claims prevent concurrent double processing. Provider metadata distinguishes mock from actual delivery.

Real-provider adapters and rate-limit/worker options are documented in `backend/src/modules/delivery/README.md` and source. Optional runtime environment variables such as `META_GRAPH_API_VERSION`, `DELIVERY_RATE_LIMIT_MAX`, `DELIVERY_RATE_LIMIT_WINDOW_MS`, `DELIVERY_MAX_CONCURRENT_SENDS`, `DELIVERY_WORKER_INTERVAL_MS` are not all forwarded by the current Compose file; add explicit environment mappings when using them. Keep mock providers for all automated tests.

### 12.5 Automation and analytics

Rule creation requires `name`, `trigger`, `action`; optional `description`, `campaignId`, `delayMinutes` (integer 0–43200), `enabled` (default false), `actionConfig` (`subject`, `body`), `allowSpecialistToggle` (default false). `ownerId` is derived from JWT; supplied owner must match. Ownership cannot be changed.

Triggers: `LEAD_CREATED`, `LEAD_STATUS_CHANGED`, `CONSULTATION_REQUESTED`, `CAMPAIGN_CREATED`, `CAMPAIGN_ACTIVATED`, `CAMPAIGN_COMPLETED`, `DELIVERY_QUEUED`, `DELIVERY_SENT`, `DELIVERY_FAILED`.

Actions: `SEND_EMAIL`, `SCHEDULE_FOLLOW_UP`, `CREATE_NOTIFICATION`. Only lead triggers can use email-style actions; campaign/delivery triggers can only create notifications. Enabled email-style rules require a campaign. `AUTOMATION_EXECUTED` and `AUTOMATION_FAILED` are audit event types, not triggers. Entity types: `LEAD`, `CAMPAIGN`, `DELIVERY_JOB` (`DELIVERY` alias), `AUTOMATION_RULE`. Metadata rejects sensitive keys/values, unsafe object keys and oversized/deep objects.

Events have unique `eventId`, source `SIMULATION` or `INTERNAL`, processing status `RECEIVED`, `PROCESSING`, `PROCESSED`, `FAILED`. Execution statuses: `PENDING`, `PROCESSING`, `COMPLETED`, `FAILED`, `UNCERTAIN`, `SKIPPED`, `SIMULATED`. Atomic claims, idempotency and unique indexes prevent duplicate processing. Temporary execution failures may retry with backoff; uncertain outcomes are not retried automatically. The Automation worker defaults to 30-second polling. Optional runtime controls `AUTOMATION_WORKER_ENABLED`, `AUTOMATION_WORKER_INTERVAL_MS`, `AUTOMATION_SIMULATION_ENABLED` require explicit Compose environment forwarding when used. Simulation is restricted in production and never sends messages. Analytics report rule counts, event counts, simulated and actual execution outcomes, business lead/campaign/delivery metrics and conversion rate (converted / total × 100, zero when no leads). Specialists receive no private lead metrics.

## 13. Complete Phase II REST API Documentation

### 13.1 API conventions

Base URL: `http://localhost:8080/api/v1`. All routes below are relative to this base. JSON requests require `Content-Type: application/json`. Use the JWT returned by login for protected requests. IDs are 24-character hexadecimal ObjectIds unless specified otherwise. Identity objects use `id`; many Mongoose-backed business objects expose `_id`. Use the actual returned value.

```json
{"success":true,"data":{}}
```

```json
{"success":false,"error":{"code":"INVALID_REQUEST","message":"Description","details":[]}}
```

List responses may include `count` or `pagination` (page, limit, total, totalPages). Health has its own `data.status`, `application`, `database`, `timestamp` shape even on 503. Common statuses: 200 success; 201 created; 400 invalid input/unsupported transition; 401 missing/invalid JWT or credentials; 403 insufficient access; 404 missing/inaccessible resource; 409 duplicates or conflicts; 413 oversized JSON; 500 unexpected failure; 503 unavailable service/database. Error codes and access-denial status depend on the module. Responses never intentionally expose credential secrets. Route tables show successful status; validation and authorization failures remain possible.

### 13.2 Health, Identity and Advisors (9 endpoints)

| Method | Route | Access | Input / result | Success |
|---|---|---|---|---|
| GET | `/health` | Public | Database readiness and timestamp | 200 |
| POST | `/auth/register` | Public | name, email, password, role, optional Advisor profile; returns user and advisorProfile | 201 |
| POST | `/auth/login` | Public | email, password; returns user, token, tokenType and expiresIn | 200 |
| GET | `/auth/me` | All roles | Current user and advisorId | 200 |
| PATCH | `/auth/me` | All roles | name/email, currentPassword for email; updated account | 200 |
| PATCH | `/auth/me/password` | All roles | currentPassword, newPassword; sign in again afterward | 200 |
| GET | `/advisors` | Public | Active public directory | 200 |
| GET | `/advisors/:id` | Public | Public Advisor profile ID | 200 |
| PATCH | `/advisors/:id` | Advisor owner | specialties, consultationTypes, bio, isPublic | 200 |

Example registration:

```json
{"name":"Demo Advisor","email":"advisor@example.com","password":"ExamplePass123!","role":"ADVISOR","profile":{"specialties":["Retirement Planning"],"consultationTypes":["ONLINE"],"bio":"Financial planning","isPublic":true}}
```

Example login: `{"email":"advisor@example.com","password":"ExamplePass123!"}`. Save `data.token` and `data.user.id`; retrieve `data.advisorId` from `GET /auth/me` or `data.advisorProfile.id` from registration. For account updates send e.g. `{"name":"Updated Advisor"}`; password update: `{"currentPassword":"ExamplePass123!","newPassword":"NewExamplePass123!"}`.

### 13.3 Invitations and relationships (6 endpoints)

| Method | Route | Access | Input / result | Success |
|---|---|---|---|---|
| POST | `/advisor-invitations` | Advisor | specialistUserId or specialistEmail; pending invitation | 201 |
| GET | `/advisor-invitations` | Advisor / Specialist | Own invitations | 200 |
| POST | `/advisor-invitations/:id/accept` | Invited Specialist | Invitation ID; accepted relationship | 200 |
| POST | `/advisor-invitations/:id/decline` | Invited Specialist | Invitation ID; declined relationship | 200 |
| GET | `/advisor-assignments` | Advisor / Specialist | Own accepted relationships | 200 |
| DELETE | `/advisor-assignments/:id` | Owning Advisor | Accepted relationship ID; revoke, not hard delete | 200 |

Example invite: `{"specialistEmail":"specialist@example.com"}`. Register the Specialist first. Use the returned relationship ID in accept/decline/revoke calls; no JSON payload is needed for those operations.

### 13.4 Administration (7 endpoints)

All require Administrator JWT and the corresponding fixed platform permission.

| Method | Route | Input / result | Success |
|---|---|---|---|
| GET | `/admin/users` | List accounts | 200 |
| GET | `/admin/users/:id` | User ID; account details | 200 |
| PATCH | `/admin/users/:id/status` | User ID, `{"isActive":false}` or true | 200 |
| GET | `/admin/assignments` | Review relationship records | 200 |
| DELETE | `/admin/assignments/:id` | Revoke accepted relationship by ID | 200 |
| GET | `/admin/roles` | Role/permission definitions | 200 |
| GET | `/admin/users/:id/permissions` | Effective permission list for user | 200 |

Admin provisioning is a CLI operation (Section 8.3), not an HTTP endpoint. There are no public hard-delete user, role-edit or password-reset administration routes.

### 13.5 Leads CRM (4 endpoints)

All require owning Advisor JWT. Optional `advisorId` is compatibility-only and must match.

| Method | Route | Input / result | Success |
|---|---|---|---|
| POST | `/leads` | name, email, interest; optional phone, status, marketingConsent, source, notes, advisorId | 201 |
| GET | `/leads` | Query: advisorId, status, marketingConsent, source, interest, search, page, limit | 200 |
| GET | `/leads/:id` | Owned Lead ID | 200 |
| PATCH | `/leads/:id` | Editable contact/lifecycle/consent fields | 200 |

```json
{"name":"Jane Example","email":"jane@example.com","interest":"Retirement Planning","marketingConsent":true,"source":"MANUAL"}
```

Example filter: `/leads?status=NEW&marketingConsent=true&page=1&limit=20`. Update consent with `{"marketingConsent":false}`; do not supply server-managed timestamps.

### 13.6 Campaigns and templates (11 endpoints)

F = owning Advisor; S = assigned Specialist with active accepted relationship. Admin has no Campaign API bypass.

| Method | Route | Access | Input / result | Success |
|---|---|---|---|---|
| POST | `/campaigns/templates` | F | name, channel, body, subject as applicable, optional isActive/advisorId | 201 |
| GET | `/campaigns/templates` | F/S | Optional channel, matching advisorId for F only; scoped active templates | 200 |
| GET | `/campaigns/templates/:templateId` | F/S | Authorized active template | 200 |
| POST | `/campaigns` | F | title, strategy, channel; optional description, audience, templateId, status, scheduledAt, advisorId | 201 |
| GET | `/campaigns` | F/S | Optional status; matching advisorId for F only | 200 |
| GET | `/campaigns/:campaignId` | F/S | Authorized campaign | 200 |
| PATCH | `/campaigns/:campaignId` | F/S | F: title, description, strategy, channel, audience, templateId, status, scheduledAt; S: restricted content fields | 200 |
| GET | `/campaigns/:campaignId/audience` | F/S | F: recipients/count; S: count only | 200 |
| POST | `/campaigns/:campaignId/specialists` | F | specialistUserId; assign accepted Specialist | 201 |
| GET | `/campaigns/:campaignId/specialists` | F | Assigned user IDs and names | 200 |
| DELETE | `/campaigns/:campaignId/specialists/:userId` | F | Remove Specialist from campaign | 200 |

Template example:

```json
{"name":"Retirement Email","channel":"EMAIL","subject":"Plan your retirement","body":"Book a consultation to learn more."}
```

Campaign example (replace ID with actual returned template ID):

```json
{"title":"Retirement Planning Campaign","strategy":"RETIREMENT_PLANNING","channel":"EMAIL","templateId":"<templateId>","audience":{"interests":["Retirement Planning"],"leadStatuses":["NEW","CONTACTED"]}}
```

Activate with `{"status":"ACTIVE"}` using PATCH. Assign with `{"specialistUserId":"<userId>"}`. Advisor IDs are derived from trusted authentication; no owner query is required for campaign details or updates.

### 13.7 Delivery (5 endpoints)

F = owning Advisor; S = assigned Specialist with active accepted relationship; A = Administrator read-only.

| Method | Route | Access | Input / result | Success |
|---|---|---|---|---|
| POST | `/deliveries` | F/S | Queue validated job; see Section 12.4 | 201 |
| GET | `/deliveries` | F/S/A | Scoped filtered/paginated job history | 200 |
| GET | `/deliveries/:id` | F/S/A | Authorized DeliveryJob ID | 200 |
| POST | `/deliveries/:id/process` | F/S | Due pending job, no body required | 200 |
| POST | `/deliveries/:id/retry` | F/S | Eligible failed job, no body required | 200 |

History filters: `campaignId`, `leadId`, `channel`, `deliveryStatus`, `provider`, `advisorId` (Admin or matching Advisor only), `createdFrom`, `createdTo`, `scheduledFrom`, `scheduledTo`, `page`, `limit` (maximum 100).

```json
{"campaignId":"<activeCampaignId>","leadId":"<eligibleLeadId>","channel":"EMAIL","content":{"subject":"Retirement Planning","body":"Learn about our consultations."}}
```

Facebook example: `{"campaignId":"<activeFacebookCampaignId>","channel":"FACEBOOK","content":{"body":"Join our upcoming webinar."}}`. Queueing does not send; process the returned job ID explicitly. A successful processing HTTP response can contain a `FAILED` job; inspect the job's deliveryStatus and provider result. Mock `SENT` is a simulated result only.

### 13.8 Automation and Analytics (8 endpoints)

F = owning Advisor; S = assigned campaign Specialist with accepted relationship; A = read-only Administrator.

| Method | Route | Access | Input / result | Success |
|---|---|---|---|---|
| POST | `/automations` | F | Rule fields, Section 12.5 | 201 |
| GET | `/automations` | F/S/A | Scoped filtered rules | 200 |
| GET | `/automations/:id` | F/S/A | Rule ObjectId | 200 |
| PATCH | `/automations/:id` | F/S | F: rule fields except owner; S: enabled only if permitted | 200 |
| POST | `/automations/simulate-event` | F | JSON object; eventId, eventType, entityType, entityId, ownerId, metadata are optional/defaulted as applicable; simulation result | 201 |
| GET | `/automations/events` | F/S/A | Scoped events | 200 |
| GET | `/automations/executions` | F/S/A | Scoped executions | 200 |
| GET | `/analytics/summary` | F/S/A | Scoped aggregate summary | 200 |

Rules filters: `ownerId`, `campaignId`, `trigger`, `action`, `enabled`, `page`, `limit`. Events filters: `ownerId`, `campaignId`, `entityId`, `eventType`, `entityType`, `processingStatus`, `source`, `from`, `to`, `page`, `limit`. Executions filters: `ownerId`, `campaignId`, `automationRuleId`, `eventId`, `status`, `action`, `simulated`, `from`, `to`, `page`, `limit`. Defaults page 1/limit 20, maximum 100. Unknown/repeated query fields are rejected. Dates use ISO format.

Rule example:

```json
{"name":"Welcome new leads","trigger":"LEAD_CREATED","action":"SEND_EMAIL","campaignId":"<activeEmailCampaignId>","enabled":true,"delayMinutes":0,"actionConfig":{"subject":"Welcome","body":"Thank you for your interest."}}
```

Simulation example:

```json
{"eventId":"demo-event-001","eventType":"LEAD_CREATED","entityType":"LEAD","entityId":"<ownedLeadId>","metadata":{}}
```

For default Phase I-compatible simulation send `{}` as a JSON body, not a missing body. The response includes `event` and `simulatedActions`; duplicate event IDs conflict. The trusted `publishEvent` integration is an in-process API, not a public route. Analytics returns separate simulated/executed action statistics and business metrics.

### 13.9 End-to-end demonstration

Register/login Advisor and Specialist; invite and accept; create consenting lead; create template and draft campaign; assign Specialist; activate campaign and preview audience; queue and process mock delivery; create rule and simulate event; inspect events/executions and analytics; withdraw consent and verify delivery restrictions; revoke relationship and verify Specialist access is removed. Use separate JWTs and actual IDs throughout.

**Total: 50 HTTP method/path combinations**, including health. See the bundled complete Postman collection for concrete request bodies and assertions across all routes.

## 14. Testing, Verification and Planned Work

### 14.1 Run automated backend tests

Start the Docker stack first. All database-backed tests must use disposable test databases, never the application database. The following command supplies the three test URIs and mock delivery settings; suite helpers create isolated databases and clean them up. Use a test-only JWT secret.

```bash
docker compose exec \
  -e NODE_ENV=test \
  -e MONGO_URI='mongodb://mongodb:27017/finmarket_test?replicaSet=rs0' \
  -e DELIVERY_TEST_MONGO_URI='mongodb://mongodb:27017/finmarket_delivery_test?replicaSet=rs0' \
  -e CAMPAIGN_TEST_MONGO_URI='mongodb://mongodb:27017/finmarket_campaign_test?replicaSet=rs0' \
  -e JWT_SECRET='local-test-only-secret-at-least-32-bytes' \
  -e DELIVERY_EMAIL_PROVIDER=mock \
  -e DELIVERY_FACEBOOK_PROVIDER=mock \
  backend npm test
```

To run a specific module, keep the same environment arguments and replace `npm test` with one of the following:

| Command | Purpose |
|---|---|
| `npm run test:identity` | Identity, account security, relationships, admin and infrastructure |
| `npm run test:leads` | Lead ownership, consent, validation, persistence |
| `npm run test:campaigns` | Campaigns, templates, state and assignments |
| `npm run test:delivery` | Delivery eligibility, jobs, providers, processing and retry |
| `npm run test:automation` | Rules, events, execution, scheduling, analytics |
| `npm run test:integration` | Cross-module behavior |
| `npm run test:all` | All tests serially |

Model validation:

```bash
docker compose exec backend npm run validate:models
```

For saving a run report, append `2>&1 | tee backend-test-results.txt` to the test command on macOS/Linux (inspect the test summary; a pipeline may mask the test exit status unless pipefail is enabled).

### 14.2 Run Postman tests

1. Start Docker and verify health (Section 8.2).
2. Provision the Administrator once (Section 8.3) and confirm login returns 200.
3. Ensure both delivery providers are `mock` in `.env`; recreate backend if changing the runtime environment.
4. Import `postman/complete.postman_collection.json` into Postman. This is the current consolidated Phase II collection; the other collections in that directory are historical or module-specific.
5. Choose **No Environment**. In collection Variables, confirm `baseUrl` is `http://localhost:8080/api/v1`, `adminEmail` is `admin@example.com`, and `adminPassword` matches the provisioned local account (bundled demo default `Password123!`). Save. Do not export real credentials.
6. Click **Run collection**, select all folders in their original order and run one iteration. Do not randomize requests or run dependent requests in parallel. Generated identities, tokens and IDs are handled by the collection's scripts.
7. Review the assertion totals and export the JSON run report if required. A failed setup request can cause multiple dependent failures; inspect the first failure before changing backend code.

The collection contains 241 requests across eight top-level folders: setup, Identity, relationships, Leads, Campaigns, Delivery, Automation/Analytics, and Administration. It tests positive and negative scenarios against 50 HTTP endpoints. It creates persistent test data in the configured development database; use a disposable database for repeated demonstrations. No manual seeding of ordinary test accounts is required. Provisioning is the only required manual account setup.

### 14.3 Infrastructure verification

Confirm `docker compose ps -a` shows three healthy services. Check replica set readiness, health endpoint, and data persistence after `docker compose down` followed by `docker compose up -d`. For a controlled outage test, stop MongoDB, inspect `/health` and logs, then restart MongoDB and confirm recovery. Perform destructive/fresh-volume tests using a separate disposable Compose project/database. Never delete the working volume to fix a test assertion.

### 14.4 Continuous integration

`.github/workflows/ci.yaml` installs dependencies, initializes a MongoDB replica set for backend tests, validates models, runs automated tests, checks frontend build tasks where present, validates/builds Docker Compose and runs dependency audit checks. Local Postman execution is a separate verification activity. CI build validation is not equivalent to a live deployment or runtime health test.

### 14.5 Current status and verification evidence

| Area | Phase II status |
|---|---|
| Infrastructure | Three-service Compose, persistent MongoDB replica set, readiness and graceful shutdown |
| Identity | JWT, account self-service, token invalidation, fixed roles, administration and relationships |
| Leads | Persistent owner-scoped CRM, consent and lifecycle |
| Campaigns | Persistent campaigns/templates, scoped assignment and audience selection |
| Delivery | Persistent queue, mock/real provider adapters, explicit processing and retries |
| Automation | Durable events/rules/executions, running Automation worker, scoped analytics |
| Frontend and production deployment | Phase III work |

The team reported a successful complete Postman run using the corrected V3 collection after configuring the Administrator. The latest supplied source contains the complete collection and automated suites. No fresh Node test execution or independent final all-pass export is included in this README revision; record actual final run totals from the execution environment rather than treating historical Phase I results as Phase II evidence.

## 15. ChatGPT Use Acknowledgement

OpenAI ChatGPT was used as a development and documentation assistance tool during the Phase I work, including:

1. **README/business case generation and revision:** ChatGPT generated and organized the `README.md` business case using the *Course Project Specification Document: Modern Web Technologies* and the *FinMarket-Enterprise Team Project Guide*, including the business problem, user roles, workflows, architecture, phase boundaries, setup, and API descriptions.
2. **Postman collection generation:** ChatGPT generated a consolidated Phase I Postman collection with 157 API requests and automated response assertions. It also revised two assertions after a test run showed that the backend returned `400 ADVISOR_MISMATCH` for a cross-advisor Delivery scenario instead of the initially expected `404 CAMPAIGN_NOT_FOUND`.
3. **Automated test generation:** ChatGPT generated or helped revise Node.js `node:test` unit and cross-module integration tests covering Identity, Leads, Campaigns, Delivery, Automation, and business-rule validations. The latest local test run reported 55 of 55 passing tests.
4. **Code review and debugging assistance:** ChatGPT helped identify inconsistencies across modules, improve input and ownership checks, review status transitions and simulated delivery processing, and interpret test failures. Suggested modifications were incorporated into the working implementation by the development team.