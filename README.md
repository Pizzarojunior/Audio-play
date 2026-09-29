# Roomtone local backend

Roomtone stores track details in SQLite and uploaded audio files on disk.

## Run locally

Requires Node.js 22.5 or newer. From this folder, run:

```powershell
npm.cmd install
npm.cmd start
```

Open <http://127.0.0.1:3000>. The first start creates `data/roomtone.sqlite` and stores audio in `data/uploads/`. Those generated files are excluded from Git.

Uploads are limited to 200 MB per track and cover art to 15 MB. The library API is `GET /api/tracks`; authenticated `POST /api/tracks` accepts release metadata, an audio file, optional cover art, and a rights-confirmation field. The artist name is taken from the signed-in account. Audio is streamed from `/audio/:id` with byte-range support for seeking.

Artists can download an owner-only release kit from `GET /api/tracks/:id/release-kit`. Each ZIP contains the original audio, optional cover image, `metadata.csv`, `release-metadata.json`, and a `START-HERE.txt` distributor checklist. Uploads represent one track per release. The kit is for manual delivery; it does not upload music directly to Spotify, Apple Music, or other platforms. Release fields are added to existing SQLite databases automatically when the server starts.

Artists can create accounts with an artist name, email, and password. Passwords are stored as scrypt hashes; login sessions are random, HTTP-only cookies whose hashes are stored in SQLite and expire after 30 days. `POST /api/auth/signup` and `POST /api/auth/login` accept JSON; `GET /api/auth/me` checks the current session; `POST /api/auth/logout` ends it. Uploads require an artist session and are saved under that account.

## Deploy on Render

`render.yaml` defines a Node web service and a 1 GB persistent disk mounted at `/var/data`. The SQLite database, audio uploads, and artwork are stored on that disk. In Render, create a Blueprint connected to this repository and review the service and disk before applying it. The service and persistent disk may incur charges; check Render's current pricing before provisioning. Use the generated `onrender.com` URL, not a Static Site, because signup and uploads require the Node API.

Before opening registration publicly, add email verification, account recovery, and abuse protections; configure backups for the persistent disk. Membership is simulated and does not process payments.