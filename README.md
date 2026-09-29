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

This is a local development backend. It does not yet provide remote hosting, account recovery, backups, production-grade abuse protection, or real subscription payments. Use HTTPS and add email verification and account recovery before opening registration to the public.