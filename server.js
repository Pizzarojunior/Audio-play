'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, randomBytes, scrypt: scryptCallback, timingSafeEqual, createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const Busboy = require('busboy');
const { ZipArchive } = require('archiver');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.ROOMTONE_DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const ARTWORK_DIR = path.join(DATA_DIR, 'artwork');
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_UPLOAD_SIZE = `${MAX_UPLOAD_BYTES / 1024 / 1024} MB`;
const MAX_ARTWORK_BYTES = 15 * 1024 * 1024;
const MAX_ARTWORK_SIZE = `${MAX_ARTWORK_BYTES / 1024 / 1024} MB`;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'roomtone_session';
const scrypt = promisify(scryptCallback);
const AUDIO_TYPES = new Map([
	['.aac', 'audio/aac'],
	['.flac', 'audio/flac'],
	['.m4a', 'audio/mp4'],
	['.mp3', 'audio/mpeg'],
	['.oga', 'audio/ogg'],
	['.ogg', 'audio/ogg'],
	['.opus', 'audio/opus'],
	['.wav', 'audio/wav'],
	['.webm', 'audio/webm']
]);
const ARTWORK_TYPES = new Map([
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.png', 'image/png'],
	['.webp', 'image/webp']
]);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(ARTWORK_DIR, { recursive: true });

const database = new DatabaseSync(path.join(DATA_DIR, 'roomtone.sqlite'));
database.exec(`
	PRAGMA journal_mode = WAL;
	CREATE TABLE IF NOT EXISTS tracks (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		artist TEXT NOT NULL,
		owner_artist_id TEXT,
		original_name TEXT NOT NULL,
		mime_type TEXT NOT NULL,
		size_bytes INTEGER NOT NULL,
		created_at TEXT NOT NULL,
		release_title TEXT NOT NULL DEFAULT '',
		release_date TEXT NOT NULL DEFAULT '',
		genre TEXT NOT NULL DEFAULT '',
		language TEXT NOT NULL DEFAULT '',
		explicit_content INTEGER NOT NULL DEFAULT 0,
		songwriter TEXT NOT NULL DEFAULT '',
		label_name TEXT NOT NULL DEFAULT '',
		copyright_holder TEXT NOT NULL DEFAULT '',
		phonogram_holder TEXT NOT NULL DEFAULT '',
		isrc TEXT NOT NULL DEFAULT '',
		upc TEXT NOT NULL DEFAULT '',
		rights_confirmed_at TEXT NOT NULL DEFAULT '',
		artwork_extension TEXT,
		artwork_mime TEXT
	);
	CREATE TABLE IF NOT EXISTS artists (
		id TEXT PRIMARY KEY,
		display_name TEXT NOT NULL,
		email TEXT NOT NULL UNIQUE COLLATE NOCASE,
		password_hash TEXT NOT NULL,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS sessions (
		token_hash TEXT PRIMARY KEY,
		artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
		expires_at INTEGER NOT NULL
	);
`);

const trackColumns = new Set(database.prepare('PRAGMA table_info(tracks)').all().map(column => column.name));
const trackMigrations = {
	owner_artist_id: 'TEXT REFERENCES artists(id)',
	release_title: "TEXT NOT NULL DEFAULT ''",
	release_date: "TEXT NOT NULL DEFAULT ''",
	genre: "TEXT NOT NULL DEFAULT ''",
	language: "TEXT NOT NULL DEFAULT ''",
	explicit_content: 'INTEGER NOT NULL DEFAULT 0',
	songwriter: "TEXT NOT NULL DEFAULT ''",
	label_name: "TEXT NOT NULL DEFAULT ''",
	copyright_holder: "TEXT NOT NULL DEFAULT ''",
	phonogram_holder: "TEXT NOT NULL DEFAULT ''",
	isrc: "TEXT NOT NULL DEFAULT ''",
	upc: "TEXT NOT NULL DEFAULT ''",
	rights_confirmed_at: "TEXT NOT NULL DEFAULT ''",
	artwork_extension: 'TEXT',
	artwork_mime: 'TEXT'
};
for (const [column, definition] of Object.entries(trackMigrations)) {
	if (!trackColumns.has(column)) database.exec(`ALTER TABLE tracks ADD COLUMN ${column} ${definition}`);
}

const listTracks = database.prepare('SELECT * FROM tracks ORDER BY created_at DESC');
const findTrack = database.prepare('SELECT * FROM tracks WHERE id = ?');
const addTrack = database.prepare(`
	INSERT INTO tracks (
		id, title, artist, owner_artist_id, original_name, mime_type, size_bytes, created_at,
		release_title, release_date, genre, language, explicit_content, songwriter,
		label_name, copyright_holder, phonogram_holder, isrc, upc, rights_confirmed_at, artwork_extension, artwork_mime
	)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const findArtistByEmail = database.prepare('SELECT * FROM artists WHERE email = ? COLLATE NOCASE');
const addArtist = database.prepare('INSERT INTO artists (id, display_name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
const addSession = database.prepare('INSERT INTO sessions (token_hash, artist_id, expires_at) VALUES (?, ?, ?)');
const findSession = database.prepare(`
	SELECT artists.id, artists.display_name, artists.email
	FROM sessions JOIN artists ON artists.id = sessions.artist_id
	WHERE sessions.token_hash = ? AND sessions.expires_at > ?
`);
const removeSession = database.prepare('DELETE FROM sessions WHERE token_hash = ?');
const pruneSessions = database.prepare('DELETE FROM sessions WHERE expires_at <= ?');

function sendJson(response, statusCode, body) {
	response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(body));
}

function serializeTrack(row) {
	return {
		id: row.id,
		title: row.title,
		artist: row.artist,
		album: row.release_title || row.title,
		releaseTitle: row.release_title,
		releaseDate: row.release_date,
		genre: row.genre,
		language: row.language,
		explicit: Boolean(row.explicit_content),
		songwriter: row.songwriter,
		label: row.label_name,
		copyrightHolder: row.copyright_holder,
		phonogramHolder: row.phonogram_holder,
		isrc: row.isrc,
		upc: row.upc,
		rightsConfirmedAt: row.rights_confirmed_at,
		hasArtwork: Boolean(row.artwork_extension),
		artworkUrl: row.artwork_extension ? `/artwork/${row.id}` : null,
		originalName: row.original_name,
		mimeType: row.mime_type,
		sizeBytes: row.size_bytes,
		createdAt: row.created_at,
		artistId: row.owner_artist_id || null,
		audioUrl: `/audio/${row.id}`
	};
}

function serializeArtist(artist) {
	return { id: artist.id, displayName: artist.display_name, email: artist.email };
}

function hashToken(token) {
	return createHash('sha256').update(token).digest('hex');
}

function getSessionToken(request) {
	for (const cookie of (request.headers.cookie || '').split(';')) {
		const separator = cookie.indexOf('=');
		if (separator >= 0 && cookie.slice(0, separator).trim() === SESSION_COOKIE) return cookie.slice(separator + 1).trim();
	}
	return null;
}

function getAuthenticatedArtist(request) {
	const token = getSessionToken(request);
	if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
	return findSession.get(hashToken(token), Date.now()) || null;
}

function setSessionCookie(response, token, maxAgeSeconds) {
	const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
	response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearSessionCookie(response) {
	response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function startSession(response, artist) {
	pruneSessions.run(Date.now());
	const token = randomBytes(32).toString('hex');
	const expiresAt = Date.now() + SESSION_LIFETIME_MS;
	addSession.run(hashToken(token), artist.id, expiresAt);
	setSessionCookie(response, token, Math.floor(SESSION_LIFETIME_MS / 1000));
	return { artist: serializeArtist(artist) };
}

function makeError(message, statusCode = 400) {
	const error = new Error(message);
	error.statusCode = statusCode;
	return error;
}

async function readJson(request, maxBytes = 16 * 1024) {
	let size = 0;
	const chunks = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > maxBytes) throw makeError('Request is too large.', 413);
		chunks.push(chunk);
	}
	try {
		const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid JSON body.');
		return value;
	} catch {
		throw makeError('Send a valid JSON request.');
	}
}

async function createArtistAccount(body) {
	const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
	const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
	const password = typeof body.password === 'string' ? body.password : '';
	if (displayName.length < 2 || displayName.length > 60) throw makeError('Artist name must be between 2 and 60 characters.');
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw makeError('Enter a valid email address.');
	if (password.length < 10 || password.length > 128) throw makeError('Password must be between 10 and 128 characters.');
	if (findArtistByEmail.get(email)) throw makeError('An account with this email already exists.', 409);
	const salt = randomBytes(16);
	const passwordHash = await scrypt(password, salt, 64);
	const artist = {
		id: randomUUID(),
		display_name: displayName,
		email,
		password_hash: `scrypt:${salt.toString('hex')}:${Buffer.from(passwordHash).toString('hex')}`,
		created_at: new Date().toISOString()
	};
	try {
		addArtist.run(artist.id, artist.display_name, artist.email, artist.password_hash, artist.created_at);
	} catch (error) {
		if (String(error.message).includes('UNIQUE constraint failed')) throw makeError('An account with this email already exists.', 409);
		throw error;
	}
	return artist;
}

async function authenticateArtist(emailInput, password) {
	const email = typeof emailInput === 'string' ? emailInput.trim().toLowerCase() : '';
	if (email.length > 254 || typeof password !== 'string' || password.length > 128) throw makeError('Email or password is incorrect.', 401);
	const artist = findArtistByEmail.get(email);
	if (!artist) throw makeError('Email or password is incorrect.', 401);
	const [, saltHex, expectedHex] = artist.password_hash.split(':');
	const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), 64));
	const expected = Buffer.from(expectedHex, 'hex');
	if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw makeError('Email or password is incorrect.', 401);
	return artist;
}

function cleanOriginalName(filename) {
	return path.basename(String(filename || '').replace(/\\/g, '/'))
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.slice(0, 180) || 'audio-upload';
}

async function receiveUpload(request) {
	const fields = Object.create(null);
	const allowedFields = new Set([
		'title', 'releaseTitle', 'releaseDate', 'genre', 'language', 'explicit',
		'songwriter', 'label', 'copyrightHolder', 'phonogramHolder', 'isrc', 'upc', 'rightsConfirmed'
	]);
	const trackId = randomUUID();
	const uploadedFiles = [];
	const writes = [];
	let parseError = null;
	const parser = Busboy({
		headers: request.headers,
		limits: { fileSize: MAX_UPLOAD_BYTES, files: 3, fields: 14, parts: 16, fieldSize: 512 }
	});

	parser.on('field', (name, value, info) => {
		if (info.nameTruncated || info.valueTruncated) parseError ||= makeError('A form field is too long.');
		if (!allowedFields.has(name) || Object.hasOwn(fields, name)) {
			parseError ||= makeError('The release form contains an unexpected or repeated field.');
			return;
		}
		fields[name] = value.trim();
	});

	parser.on('file', (fieldName, file, info) => {
		if (fieldName === 'artwork' && !info.filename) {
			file.resume();
			return;
		}
		if (!['audio', 'artwork'].includes(fieldName) || uploadedFiles.some(upload => upload.fieldName === fieldName)) {
			parseError ||= makeError('Upload one audio file and at most one cover image.');
			file.resume();
			return;
		}

		const originalName = cleanOriginalName(info.filename);
		const extension = path.extname(originalName).toLowerCase();
		const isArtwork = fieldName === 'artwork';
		const mimeType = isArtwork
			? ARTWORK_TYPES.get(extension)
			: AUDIO_TYPES.get(extension) || (/^audio\/[a-z0-9.+-]+$/i.test(info.mimeType) ? info.mimeType : null);
		if (!mimeType) {
			parseError ||= makeError(isArtwork
				? 'Cover art must be a JPG, PNG, or WEBP image.'
				: 'Choose a supported audio file (MP3, WAV, M4A, AAC, OGG, FLAC, OPUS, or WEBM).');
			file.resume();
			return;
		}

		const filePath = isArtwork
			? path.join(ARTWORK_DIR, `${trackId}${extension}`)
			: path.join(UPLOAD_DIR, trackId);
		const upload = { id: trackId, fieldName, filePath, originalName, mimeType, extension, sizeBytes: 0 };
		uploadedFiles.push(upload);
		file.on('data', chunk => {
			upload.sizeBytes += chunk.length;
			if (isArtwork && upload.sizeBytes > MAX_ARTWORK_BYTES) parseError ||= makeError(`Cover art must be smaller than ${MAX_ARTWORK_SIZE}.`, 413);
		});
		file.on('limit', () => { parseError ||= makeError(`Each uploaded file must be smaller than ${MAX_UPLOAD_SIZE}.`, 413); });
		writes.push(pipeline(file, fs.createWriteStream(filePath, { flags: 'wx' })).catch(error => {
			parseError ||= error;
		}));
	});

	parser.on('filesLimit', () => { parseError ||= makeError('Upload one audio file and at most one cover image.'); });
	parser.on('fieldsLimit', () => { parseError ||= makeError('The release form contains too many fields.'); });
	parser.on('partsLimit', () => { parseError ||= makeError('The upload form has too many fields.'); });

	try {
		await pipeline(request, parser);
		await Promise.all(writes);
		if (parseError) throw parseError;
		if (!fields.title || fields.title.length > 80) throw makeError('Enter a track title of 1 to 80 characters.');
		if (!fields.releaseTitle || fields.releaseTitle.length > 120) throw makeError('Enter a release title of 1 to 120 characters.');
		const releaseDate = new Date(`${fields.releaseDate}T00:00:00.000Z`);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.releaseDate || '') || Number.isNaN(releaseDate.getTime()) || releaseDate.toISOString().slice(0, 10) !== fields.releaseDate) throw makeError('Choose a valid release date.');
		if (!fields.genre || fields.genre.length > 60) throw makeError('Choose a genre for this release.');
		if (!fields.language || fields.language.length > 60) throw makeError('Enter the release language.');
		if (fields.rightsConfirmed !== 'yes') throw makeError('Confirm that you own or have permission to distribute this music.');
		if (fields.songwriter && fields.songwriter.length > 180) throw makeError('Songwriter details must be 180 characters or fewer.');
		if (fields.label && fields.label.length > 120) throw makeError('Label name must be 120 characters or fewer.');
		if (fields.copyrightHolder && fields.copyrightHolder.length > 120) throw makeError('Copyright holder must be 120 characters or fewer.');
		if (fields.phonogramHolder && fields.phonogramHolder.length > 120) throw makeError('Phonogram holder must be 120 characters or fewer.');
		const isrc = (fields.isrc || '').replace(/[-\s]/g, '').toUpperCase();
		if (isrc && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc)) throw makeError('Enter an ISRC with 12 letters and numbers, or leave it blank.');
		if (fields.upc && !/^\d{12,13}$/.test(fields.upc)) throw makeError('UPC/EAN must contain 12 or 13 digits, or be left blank.');
		const audioFile = uploadedFiles.find(upload => upload.fieldName === 'audio');
		if (!audioFile || audioFile.sizeBytes === 0) throw makeError('Choose an audio file to upload.');
		const artworkFile = uploadedFiles.find(upload => upload.fieldName === 'artwork');
		return {
			...audioFile,
			title: fields.title,
			releaseTitle: fields.releaseTitle,
			releaseDate: fields.releaseDate,
			genre: fields.genre,
			language: fields.language,
			explicit: fields.explicit === 'yes',
			songwriter: fields.songwriter || '',
			label: fields.label || '',
			copyrightHolder: fields.copyrightHolder || '',
			phonogramHolder: fields.phonogramHolder || '',
			isrc,
			upc: fields.upc || '',
			artwork: artworkFile || null
		};
	} catch (error) {
		await Promise.allSettled(writes);
		await Promise.all(uploadedFiles.map(upload => fs.promises.rm(upload.filePath, { force: true })));
		throw error;
	}
}

function safePackageName(value) {
	return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 70) || 'release';
}

function csvCell(value) {
	return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function streamReleaseKit(response, row) {
	const slug = safePackageName(row.release_title || row.title);
	const audioName = cleanOriginalName(row.original_name);
	const audioPath = path.join(UPLOAD_DIR, row.id);
	const artworkName = row.artwork_extension ? `${slug}-cover${row.artwork_extension}` : null;
	const artworkPath = row.artwork_extension ? path.join(ARTWORK_DIR, `${row.id}${row.artwork_extension}`) : null;
	if (!fs.existsSync(audioPath) || (artworkPath && !fs.existsSync(artworkPath))) {
		sendJson(response, 404, { error: 'Audio or cover art for this release is unavailable.' });
		return;
	}

	const metadata = {
		format: 'roomtone-release-kit-v1',
		generatedAt: new Date().toISOString(),
		release: {
			title: row.release_title,
			primaryArtist: row.artist,
			releaseDate: row.release_date,
			genre: row.genre,
			language: row.language,
			explicit: Boolean(row.explicit_content),
			label: row.label_name || null,
			copyrightHolder: row.copyright_holder || null,
			phonogramHolder: row.phonogram_holder || null,
			upcEan: row.upc || null
		},
		tracks: [{
			title: row.title,
			primaryArtist: row.artist,
			songwriter: row.songwriter || null,
			isrc: row.isrc || null,
			audioFile: `audio/${audioName}`
		}],
		coverArtFile: artworkName ? `artwork/${artworkName}` : null,
		rightsDeclaration: {
			artistConfirmedDistributionRightsAt: row.rights_confirmed_at
		}
	};
	const csvRows = [
		['Field', 'Value'],
		['Release title', row.release_title],
		['Primary artist', row.artist],
		['Track title', row.title],
		['Release date', row.release_date],
		['Genre', row.genre],
		['Language', row.language],
		['Explicit content', row.explicit_content ? 'Yes' : 'No'],
		['Songwriter', row.songwriter],
		['Label', row.label_name],
		['Copyright holder', row.copyright_holder],
		['Phonogram holder', row.phonogram_holder],
		['ISRC', row.isrc],
		['UPC/EAN', row.upc],
		['Audio file', `audio/${audioName}`],
		['Cover art file', artworkName ? `artwork/${artworkName}` : 'Not provided']
	];
	const instructions = [
		`${row.release_title} - Release Kit`,
		'',
		'This package prepares your artist-provided audio and release details for manual submission to a music distributor. Roomtone does not deliver this release to streaming services.',
		'',
		'PACKAGE CONTENTS',
		'- metadata.csv: fields for copying into your distributor submission form.',
		'- release-metadata.json: the same release details in a structured format.',
		`- audio/${audioName}: the original audio file you uploaded; it has not been converted or mastered.`,
		...(artworkName ? [`- artwork/${artworkName}: the cover image you uploaded.`] : ['- No cover art was provided. Add artwork using the distributor\'s current specifications.']),
		'',
		'BEFORE SUBMITTING',
		'- Confirm the distributor accepts the audio format and meets its current technical requirements.',
		'- Check the selected service\'s cover-art dimensions, format, and content rules.',
		'- Verify the release date, credits, explicit-content setting, and rights for both recording and composition.',
		'- Use only ISRC/UPC codes you are authorized to use. If blank, ask the distributor about code assignment.',
		'- Review the distributor\'s territory, pricing, and takedown terms before delivery.'
	].join('\n');
	const archive = new ZipArchive({ zlib: { level: 6 } });
	archive.on('error', error => {
		console.error('Release kit archive failed:', error);
		if (!response.headersSent) sendJson(response, 500, { error: 'Could not create this release kit.' });
		else response.destroy(error);
	});
	response.writeHead(200, {
		'Content-Type': 'application/zip',
		'Content-Disposition': `attachment; filename="${slug}-release-kit.zip"`,
		'Cache-Control': 'private, no-store',
		'X-Content-Type-Options': 'nosniff'
	});
	archive.pipe(response);
	archive.file(audioPath, { name: `audio/${audioName}` });
	if (artworkPath) archive.file(artworkPath, { name: `artwork/${artworkName}` });
	archive.append(JSON.stringify(metadata, null, 2), { name: 'release-metadata.json' });
	archive.append(`${csvRows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`, { name: 'metadata.csv' });
	archive.append(`${instructions}\n`, { name: 'START-HERE.txt' });
	archive.finalize().catch(error => {
		console.error('Release kit finalization failed:', error);
		if (!response.destroyed) response.destroy(error);
	});
}

function serveAudio(request, response, trackId) {
	const row = findTrack.get(trackId);
	if (!row) {
		sendJson(response, 404, { error: 'Track not found.' });
		return;
	}

	const filePath = path.join(UPLOAD_DIR, row.id);
	let start = 0;
	let end = row.size_bytes - 1;
	let statusCode = 200;
	const rangeHeader = request.headers.range;
	if (rangeHeader) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
		if (!match || (!match[1] && !match[2])) {
			response.writeHead(416, { 'Content-Range': `bytes */${row.size_bytes}` });
			response.end();
			return;
		}
		if (!match[1]) {
			const suffixLength = Number(match[2]);
			start = Math.max(row.size_bytes - suffixLength, 0);
		} else {
			start = Number(match[1]);
			if (match[2]) end = Math.min(Number(match[2]), end);
		}
		if (start >= row.size_bytes || end < start) {
			response.writeHead(416, { 'Content-Range': `bytes */${row.size_bytes}` });
			response.end();
			return;
		}
		statusCode = 206;
	}

	const contentLength = end - start + 1;
	const headers = {
		'Accept-Ranges': 'bytes',
		'Cache-Control': 'private, max-age=3600',
		'Content-Length': contentLength,
		'Content-Type': row.mime_type,
		'Content-Disposition': 'inline',
		'X-Content-Type-Options': 'nosniff'
	};
	if (statusCode === 206) headers['Content-Range'] = `bytes ${start}-${end}/${row.size_bytes}`;
	response.writeHead(statusCode, headers);
	if (request.method === 'HEAD') {
		response.end();
		return;
	}
	const stream = fs.createReadStream(filePath, { start, end });
	stream.on('error', error => {
		console.error('Audio stream error:', error);
		if (!response.headersSent) sendJson(response, 404, { error: 'Audio file is unavailable.' });
		else response.destroy(error);
	});
	stream.pipe(response);
}

const server = http.createServer(async (request, response) => {
	const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

	if (request.method === 'GET' && url.pathname === '/api/health') {
		sendJson(response, 200, { status: 'ok', database: 'sqlite' });
		return;
	}

	if (request.method === 'GET' && url.pathname === '/api/auth/me') {
		const artist = getAuthenticatedArtist(request);
		sendJson(response, 200, { artist: artist ? serializeArtist(artist) : null });
		return;
	}

	if (request.method === 'POST' && ['/api/auth/signup', '/api/auth/login'].includes(url.pathname)) {
		try {
			const body = await readJson(request);
			const artist = url.pathname.endsWith('/signup')
				? await createArtistAccount(body)
				: await authenticateArtist(body.email, body.password);
			sendJson(response, url.pathname.endsWith('/signup') ? 201 : 200, startSession(response, artist));
		} catch (error) {
			sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : 'Could not create the artist session.' });
		}
		return;
	}

	if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
		const token = getSessionToken(request);
		if (token && /^[a-f0-9]{64}$/.test(token)) removeSession.run(hashToken(token));
		clearSessionCookie(response);
		sendJson(response, 200, { artist: null });
		return;
	}

	if (request.method === 'GET' && url.pathname === '/api/tracks') {
		sendJson(response, 200, listTracks.all().map(serializeTrack));
		return;
	}

	if (request.method === 'POST' && url.pathname === '/api/tracks') {
		const artist = getAuthenticatedArtist(request);
		if (!artist) {
			request.resume();
			sendJson(response, 401, { error: 'Sign in to an artist account before uploading.' });
			return;
		}
		let uploadedFile;
		try {
			uploadedFile = await receiveUpload(request);
			const createdAt = new Date().toISOString();
			addTrack.run(
				uploadedFile.id,
				uploadedFile.title,
				artist.display_name,
				artist.id,
				uploadedFile.originalName,
				uploadedFile.mimeType,
				uploadedFile.sizeBytes,
				createdAt,
				uploadedFile.releaseTitle,
				uploadedFile.releaseDate,
				uploadedFile.genre,
				uploadedFile.language,
				uploadedFile.explicit ? 1 : 0,
				uploadedFile.songwriter,
				uploadedFile.label,
				uploadedFile.copyrightHolder,
				uploadedFile.phonogramHolder,
				uploadedFile.isrc,
				uploadedFile.upc,
				new Date().toISOString(),
				uploadedFile.artwork?.extension || null,
				uploadedFile.artwork?.mimeType || null
			);
			const track = serializeTrack(findTrack.get(uploadedFile.id));
			sendJson(response, 201, track);
		} catch (error) {
			if (uploadedFile) {
				await fs.promises.rm(uploadedFile.filePath, { force: true });
				if (uploadedFile.artwork) await fs.promises.rm(uploadedFile.artwork.filePath, { force: true });
			}
			console.error('Track upload failed:', error.message);
			sendJson(response, error.statusCode || 400, { error: error.statusCode ? error.message : 'The track could not be saved.' });
		}
		return;
	}

	const releaseKitMatch = /^\/api\/tracks\/([0-9a-f-]{36})\/release-kit$/i.exec(url.pathname);
	if (request.method === 'GET' && releaseKitMatch) {
		const artist = getAuthenticatedArtist(request);
		if (!artist) {
			sendJson(response, 401, { error: 'Sign in to download your release kit.' });
			return;
		}
		const track = findTrack.get(releaseKitMatch[1]);
		if (!track || track.owner_artist_id !== artist.id) {
			sendJson(response, 404, { error: 'Release not found.' });
			return;
		}
		streamReleaseKit(response, track);
		return;
	}

	const audioMatch = /^\/audio\/([0-9a-f-]{36})$/i.exec(url.pathname);
	if (audioMatch && ['GET', 'HEAD'].includes(request.method)) {
		serveAudio(request, response, audioMatch[1]);
		return;
	}

	const artworkMatch = /^\/artwork\/([0-9a-f-]{36})$/i.exec(url.pathname);
	if (request.method === 'GET' && artworkMatch) {
		const track = findTrack.get(artworkMatch[1]);
		if (!track || !track.artwork_extension) {
			sendJson(response, 404, { error: 'Cover art not found.' });
			return;
		}
		response.writeHead(200, {
			'Content-Type': track.artwork_mime,
			'Cache-Control': 'private, max-age=3600',
			'X-Content-Type-Options': 'nosniff'
		});
		fs.createReadStream(path.join(ARTWORK_DIR, `${track.id}${track.artwork_extension}`)).pipe(response);
		return;
	}

	if (request.method === 'GET' && ['/', '/index.html'].includes(url.pathname)) {
		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		fs.createReadStream(path.join(__dirname, 'index.html')).pipe(response);
		return;
	}

	sendJson(response, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
	console.log(`Roomtone is running at http://${HOST}:${PORT}`);
	console.log(`SQLite database: ${path.join(DATA_DIR, 'roomtone.sqlite')}`);
	console.log(`Audio uploads: ${UPLOAD_DIR}`);
});

function shutdown() {
	server.close(() => {
		database.close();
		process.exit(0);
	});
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);