# Baileys Railway Multi-Tenant Bot (starter)

Lightweight Node.js/Express dashboard, JSON license storage, isolated Baileys session folders, and bounded testing on the account's own paired number. **No SQLite.**

> This is a starter, not a verified production deployment. Baileys is an unofficial WhatsApp Web client. Delivery, pairing, and reconnect behavior may change. Use only with accounts you control and recipients who consent.

## Open on your laptop (Windows)

1. Download and extract the ZIP to a normal folder (do not open code inside the ZIP).
2. Install Node.js 20 or newer and VS Code.
3. Open VS Code > File > Open Folder > select `baileys-railway-bot`.
4. Open Terminal > New Terminal. Run `npm install`.
5. Copy `.env.example` to `.env`, then set a private admin username, a unique password (16+ characters), and a random cookie secret (32+ characters). **Do not publish `.env`.**
6. Run `npm start`, then visit `http://localhost:3000` in your laptop browser.
7. Log in as admin, create a license, then use the license to request a pairing code. Pairing requires a real WhatsApp account and may fail if WhatsApp changes its protocol.

The local folder `local-data/` is ignored by Git; it contains private customer and authentication data.

## Upload to GitHub

1. Create a **private** repository on github.com (for example `baileys-railway-bot`).
2. In the repository, choose **Add file > Upload files**. Upload the **contents of the extracted project folder**, including `server.js`, `package.json`, `railway.json`, `.gitignore`, `.env.example`, and `README.md`.
3. Never upload `.env`, `local-data/`, `node_modules/`, or any Baileys session credentials.
4. Commit the files. For later updates, upload changed files or use Git from VS Code.

## Deploy to Railway

1. Railway > New Project > Deploy from GitHub repo > choose your private repository.
2. Add a **persistent volume** and mount it at `/data`.
3. Under **Variables**, add:
   - `ADMIN_USER` — your private admin username
   - `ADMIN_PASSWORD` — unique password of at least 16 characters
   - `COOKIE_SECRET` — random secret of at least 32 characters
   - `DATA_DIR=/data`
   - `NODE_ENV=production`
4. Deploy. In Railway networking settings, generate a public domain for the service.
5. Visit the Railway HTTPS URL and log in. Railway provides `PORT`; do not hardcode it.
6. Run a **single replica**. JSON license storage and Baileys auth folders are not designed for concurrent replicas sharing writes.

Data on the volume looks like:

```text
/data/
  licenses.json
  customers/
    <customer-id>/
      customer.json
      session/
        creds.json
        (other Baileys auth files)
```

## Commands

- `.ping` — responds `Pong`.
- `.alive` — responds with bot-alive status.
- `.spam <own-paired-number> <count> <message>` — bounded notification test **only to the paired account owner's number**. Example: `.spam 2348012345678 3 Hello`.

### Where to edit message count and delay

At the **top of `server.js`**, find the comment `WHATSAPP MESSAGE TEST SETTINGS — EDIT THESE VALUES`:

- `MAX_TEST_MESSAGES = 10` — upper bound for a single test.
- `DEFAULT_MESSAGE_DELAY_MS = 1000` — interval used by the WhatsApp `.spam` command.
- `MIN_MESSAGE_DELAY_MS = 1000` and `MAX_MESSAGE_DELAY_MS = 60000` — delay bounds in the website test interface.

The WhatsApp command uses the default delay. The website test lets you choose a delay within the configured bounds. Tests are sequential and bounded; the app does not implement unlimited messaging or unsolicited message flooding.

**Message submission is not the same as delivery.** A resolved `sendMessage()` call only means the submission call succeeded; do not treat it as proof that the recipient received or read the message.

## License and admin notes

- The admin creates 15-, 20-, 30-, or 60-day licenses.
- Each license binds to one phone number.
- Expired or revoked licenses cannot access client routes; the server also disconnects expired sessions on its periodic check.
- There is no payment gateway; the admin handles subscription payment/renewal manually.
- For serious production use, add CSRF protections, HTTPS-only deployment, audit logs, backup/restore procedures, and file-locking/transactional JSON updates before allowing concurrent administrative actions.
