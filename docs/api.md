# API reference

All `/bills` routes require the session cookie, and every query filters by the signed-in user's ID.

| Method | Route | |
|---|---|---|
| POST | `/auth/signup`, `/auth/login`, `/auth/logout` | bcrypt-hashed passwords, JWT in an httpOnly cookie, rate-limited |
| GET | `/auth/me` | current user |
| PATCH | `/account/name` | change display name |
| PATCH | `/account/email` | change email (requires current password) |
| PATCH | `/account/password` | change password (requires current password; signs out other sessions) |
| DELETE | `/account` | delete the account, its bills, and uploaded files (requires current password) |
| GET | `/bills` | dashboard list |
| POST | `/bills` | create bill, returns presigned upload URL |
| POST | `/bills/:id/uploaded` | queue extraction |
| GET | `/bills/:id` | status, line items, findings (polled) |
| PUT | `/bills/:id/review` | confirm items and admission answer, queue audit |
| DELETE | `/bills/:id` | delete bill and its files |
| POST | `/bills/:id/eobs` | add an insurance statement, returns presigned upload URL |
| POST | `/bills/:id/eobs/:eobId/uploaded` | queue statement extraction |
| DELETE | `/bills/:id/eobs/:eobId` | remove a statement and re-run the comparison |
