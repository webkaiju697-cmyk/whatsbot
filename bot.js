const wppconnect = require('@wppconnect-team/wppconnect');
const { spawn } = require('child_process');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const app = express();
app.use(cookieParser());

const port = 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_kaiju_key_123';

// Centralized Data Directory for Persistence
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Multer Setup for worker node assets
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(DATA_DIR, 'worker_sessions');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

// Database Setup
const db = new sqlite3.Database(path.join(DATA_DIR, 'bot_data.db'));
db.serialize(() => {
    // Users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT DEFAULT 'user',
        created_at INTEGER NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS whatsapp_accounts (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expiry_at INTEGER NOT NULL,
        status TEXT DEFAULT 'disconnected',
        settings TEXT DEFAULT '{}',
        user_id INTEGER NOT NULL DEFAULT 1
    )`);
    // Migrate existing tables
    db.run(`ALTER TABLE whatsapp_accounts ADD COLUMN settings TEXT DEFAULT '{}'`, () => {});
    db.run(`ALTER TABLE whatsapp_accounts ADD COLUMN user_id INTEGER DEFAULT 1`, () => {});
});

// Global state for session management
const activeSessions = new Map(); // phone -> BotSession instance
const pendingOperations = new Set(); // phone numbers currently being connected or deleted

class BotSession {
    constructor(config) {
        this.phone = config.phone;
        this.name = config.name;
        this.sessionId = config.sessionId;
        this.expiryAt = config.expiryAt;
        this.settings = config.settings || {}; // pre-connection bot settings
        this.userId = config.userId;
        this.isPersisted = config.isPersisted || false;
        
        this.client = null;
        this.status = 'Idle';
        this.qr = '';
        this.pairingCode = '';
        this.botStarted = false;
        this.pendingBotStart = false;
        
        // Raid State (Per Session)
        this.raidState = {
            active: false,
            groupId: null,
            participants: new Set(),
            participantMap: new Map(),
            linkToSenderMap: new Map(),
            firstMsgId: null,
            lastMsgId: null,
            links: new Set(),
            startTime: null,
            submissionEndTime: null,
            engagementEndTime: null,
            phase: 0,
            submissionTimer: null,
            engagementTimer: null,
            warningTimer: null,
            hostId: null
        };
        
        this.dailySchedules = [];
        this.groupSettings = {};
        this.defaulters = {};
        this.activeTimers = new Map();
        this.manualCodeRequested = false;
        
        // Define persistent paths
        this.paths = {
            defaulters: path.join(DATA_DIR, `defaulters_${this.sessionId}.json`),
            settings: path.join(DATA_DIR, `group_settings_${this.sessionId}.json`),
            schedules: path.join(DATA_DIR, `schedules_${this.sessionId}.json`),
            raidState: path.join(DATA_DIR, `raid_state_${this.sessionId}.json`),
            tokens: path.join(DATA_DIR, 'tokens')
        };
    }

    async safeSendText(to, text, options = {}) {
        try {
            if (!text) return;
            if (this.client) {
                return await this.client.sendText(to, text, options);
            }
        } catch (e) {
            console.error(`[${this.phone}] Failed to send message to ${to}:`, e.message);
        }
    }

    async init() {
        console.log(`[${this.phone}] Initializing session for ${this.name}...`);
        
        try {
            // Create a timeout promise that rejects after 5 minutes
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection timeout: WhatsApp session took too long to initialize (>5 min)')), 5 * 60 * 1000)
            );

            const startBotWhenReady = async () => {
                if (this.botStarted) return;
                if (!this.client) {
                    this.pendingBotStart = true;
                    return;
                }
                this.startBot();
            };

            const createPromise = wppconnect.create({
                session: this.sessionId,
                mkdirFolderToken: this.paths.tokens,
                logQR: false,
                autoClose: 0,
                disableWelcome: true,
                createBrowserDevice: true,
                waitForLogin: false,
                headless: true,
                autoDownload: {
                    image: false,
                    video: false,
                    audio: false,
                    document: false,
                },
                puppeteerOptions: {
                    executablePath: undefined,
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-extensions',
                        '--no-first-run',
                        '--no-zygote'
                    ]
                },
                onQRCode: (base64) => {
                    this.qr = base64;
                    this.status = 'Waiting for QR Scan';
                    console.log(`[${this.phone}] QR code generated. Awaiting scan...`);
                },
                statusFind: async (status) => {
                    this.status = status;
                    this.updateDbStatus(status);
                    console.log(`[${this.phone}] Status: ${status}`);
                    if ((status === 'isLogged' || status === 'inChat') && !this.botStarted) {
                        await startBotWhenReady();
                    }
                    if (status === 'inChat') {
                        this.status = 'Connected';
                        this.updateDbStatus('Connected');
                    }
                    if (status === 'browserClose') {
                        console.log(`[${this.phone}] Browser closed. Checking if connected...`);
                        // Don't terminate immediately, check if we can reconnect
                        if (this.botStarted) {
                            this.status = 'Browser Closed';
                            this.updateDbStatus('Browser Closed');
                            // Perhaps add a timeout to stop after a delay
                            setTimeout(() => {
                                if (this.status === 'Browser Closed') {
                                    console.log(`[${this.phone}] Browser still closed after delay. Terminating.`);
                                    this.stop();
                                }
                            }, 10000); // 10 seconds delay
                        }
                        return;
                    }
                    if (status === 'desconnectedMobile' || (status === 'notLogged' && this.botStarted)) {
                        console.log(`[${this.phone}] Logout detected from phone. Terminating session.`);
                        this.updateDbStatus('Logged Out');
                        await this.stop();
                    }
                }
            });

            // Race between connection and timeout
            this.client = await Promise.race([createPromise, timeoutPromise]);

            // If login status arrived before client assignment, start the bot now
            if (this.pendingBotStart && !this.botStarted) {
                this.pendingBotStart = false;
                this.startBot();
            }

            // Listen for browser disconnect
            if (this.client && this.client.browser) {
                this.client.browser.on('disconnected', () => {
                    console.log(`[${this.phone}] Browser disconnected.`);
                    this.status = 'Browser Closed';
                    this.updateDbStatus('Browser Closed');
                });
            }

            this.status = 'Connected';
            this.qr = '';
            this.updateDbStatus('Connected');
            if (!this.botStarted) this.startBot();
        } catch (error) {
            console.error(`[${this.phone}] Failed to init:`, error.message);
            this.status = 'Error';
        }
    }

    async initWithPairing() {
        console.log(`[${this.phone}] Starting session with pairing for ${this.name}...`);
        this.pairingCode = '';
        
        try {
            // Create a timeout promise that rejects after 5 minutes
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Connection timeout: Pairing took too long (>5 min)')), 5 * 60 * 1000)
            );

            const startBotWhenReady = async () => {
                if (this.botStarted) return;
                if (!this.client) {
                    this.pendingBotStart = true;
                    return;
                }
                this.startBot();
            };

            const createPromise = wppconnect.create({
                session: this.sessionId,
                mkdirFolderToken: this.paths.tokens,
                phoneNumber: this.phone,
                logQR: false,
                autoClose: 0,
                disableWelcome: true,
                createBrowserDevice: true,
                waitForLogin: false,
                headless: true,
                autoDownload: {
                    image: false,
                    video: false,
                    audio: false,
                    document: false,
                },
                puppeteerOptions: {
                    executablePath: undefined,
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-extensions',
                        '--no-first-run',
                        '--no-zygote'
                    ]
                },
                catchLinkCode: (code) => {
                    this.pairingCode = code;
                    this.status = 'Waiting for Pairing Code';
                    this.updateDbStatus('Waiting for Pairing Code');
                    console.log(`[${this.phone}] Pairing Code generated (via catchLinkCode): ${code}`);
                },
                statusFind: async (status) => {
                    this.status = status;
                    this.updateDbStatus(status);
                    console.log(`[${this.phone}] Status: ${status}`);
                    
                    if ((status === 'isLogged' || status === 'inChat') && !this.botStarted) {
                        await startBotWhenReady();
                    }

                    if (status === 'inChat') {
                        this.status = 'Connected';
                        this.updateDbStatus('Connected');
                    }

                    if (status === 'browserClose') {
                        console.log(`[${this.phone}] Browser closed. Checking if connected...`);
                        // Don't terminate immediately, check if we can reconnect
                        if (this.botStarted) {
                            this.status = 'Browser Closed';
                            this.updateDbStatus('Browser Closed');
                            // Perhaps add a timeout to stop after a delay
                            setTimeout(() => {
                                if (this.status === 'Browser Closed') {
                                    console.log(`[${this.phone}] Browser still closed after delay. Terminating.`);
                                    this.stop();
                                }
                            }, 10000); // 10 seconds delay
                        }
                        return;
                    }

                    if (status === 'isLogged' || status === 'qrReadSuccess' || status === 'inChat') {
                        this.pairingCode = '';
                        this.qr = '';
                    }

                    if (status === 'desconnectedMobile' || (status === 'notLogged' && this.botStarted)) {
                        console.log(`[${this.phone}] Logout detected from phone. Terminating session.`);
                        this.updateDbStatus('Logged Out');
                        await this.stop();
                    }

                    if (status === 'notLogged' && !this.botStarted && !this.manualCodeRequested) {
                        // Attempt to force code if not received yet (only during initial setup)
                        this.manualCodeRequested = true;
                        setTimeout(async () => {
                            // Only try to force a code if we still don't have one and we aren't already waiting for it
                            if (!this.pairingCode && this.client && this.status !== 'Connected') {
                                console.log(`[${this.phone}] No pairing code after 30s. Attempting manual generation...`);
                                try {
                                    this.pairingCode = await this.client.getPairingCode(this.phone);
                                    this.status = 'Waiting for Pairing Code';
                                    console.log(`[${this.phone}] Manual pairing code: ${this.pairingCode}`);
                                } catch (e) {
                                    if (e.message && e.message.includes('RateOverlimit')) {
                                        console.warn(`[${this.phone}] Rate limit hit for pairing code. Please wait a few minutes.`);
                                        this.status = 'Rate Limited (Wait)';
                                    } else {
                                        console.error(`[${this.phone}] Manual pairing code failed:`, e.message);
                                    }
                                    this.manualCodeRequested = false; // Allow retry later
                                }
                            } else {
                                this.manualCodeRequested = false;
                            }
                        }, 30000); // Increased to 30s to allow library more time and avoid aggressive requests
                    }
                }
            });

            // Race between connection and timeout
            this.client = await Promise.race([createPromise, timeoutPromise]);

            if (this.pendingBotStart && !this.botStarted) {
                this.pendingBotStart = false;
                this.startBot();
            }

            // Listen for browser disconnect
            if (this.client && this.client.browser) {
                this.client.browser.on('disconnected', () => {
                    console.log(`[${this.phone}] Browser disconnected.`);
                    this.status = 'Browser Closed';
                    this.updateDbStatus('Browser Closed');
                });
            }

            // Once wppconnect.create resolves, the client is logged in and ready.
            if (this.client) {
                this.status = 'Connected';
                this.pairingCode = '';
                this.qr = '';
                this.updateDbStatus('Connected');
                if (!this.botStarted) this.startBot();
            }

        } catch (error) {
            console.error(`[${this.phone}] Failed to init with pairing:`, error.message);
            this.status = 'Error';
        }
    }



    async updateDbStatus(status) {
        if (!this.isPersisted && ['Connected', 'isLogged', 'qrReadSuccess'].includes(status)) {
            const createdAt = Date.now();
            const settingsJson = JSON.stringify(this.settings || {});
            db.run(`INSERT OR REPLACE INTO whatsapp_accounts (phone, name, session_id, created_at, expiry_at, status, settings, user_id) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, 
                    [this.phone, this.name, this.sessionId, createdAt, this.expiryAt, status, settingsJson, this.userId], (err) => {
                if (!err) {
                    this.isPersisted = true;
                    console.log(`[${this.phone}] Successfully created persistent record on connection success.`);
                }
            });
        } else if (this.isPersisted) {
            db.run('UPDATE whatsapp_accounts SET status = ? WHERE phone = ?', [status, this.phone]);
        }
    }

    startBot() {
        console.log(`[${this.phone}] Starting bot logic...`);
        this.botStarted = true;
        this.loadSettings();
        this.loadSchedules();
        this.loadRaidState();
        this.loadDefaulters();
        this.setupMessageListener();
        this.applyPreConnectionSettings();
    }

    applyPreConnectionSettings() {
        const s = this.settings;
        if (!s || !s.autoRaidEnabled) return;

        // "s.schedules" is now an array: [{time: "HH:mm", subDuration: 30, engDuration: 360}]
        let schedules = s.schedules || [];
        
        // Backward compatibility for old single-raid settings
        if (schedules.length === 0 && s.raidHour !== undefined) {
            schedules.push({
                time: `${String(s.raidHour).padStart(2,'0')}:${String(s.raidMinute).padStart(2,'0')}`,
                subDuration: 30,
                engDuration: 360
            });
        }

        const hasGroup = s.groupId && s.groupId.trim();
        if (!hasGroup) return;

        const groupId = s.groupId.trim();
        const timezone = s.timezone || 'UTC';
        const hostId = s.hostId || '';

        schedules.forEach(sch => {
            if (!sch.time) return;
            const parts = sch.time.split(':');
            const hours = parseInt(parts[0]);
            const minutes = parseInt(parts[1]);
            const subDelta = (parseInt(sch.subDuration) || 30) * 60 * 1000;
            const engDelta = (parseInt(sch.engDuration) || 360) * 60 * 1000;

            // Avoid duplicating an already-loaded schedule
            const alreadyScheduled = this.dailySchedules.some(
                s_ => s_.groupId === groupId && s_.hours === hours && s_.minutes === minutes
            );
            if (alreadyScheduled) return;

            const scheduleId = Date.now() + Math.floor(Math.random() * 1000);
            const entry = { id: scheduleId, groupId, hours, minutes, hostId, subDelta, engDelta };
            this.dailySchedules.push(entry);
            this.saveSchedules();

            // Override group timezone
            if (!this.groupSettings[groupId]) this.groupSettings[groupId] = {};
            this.groupSettings[groupId].timezone = timezone;
            this.saveSettings();

            this.scheduleDailyRaid(groupId, hours, minutes, hostId, scheduleId, subDelta, engDelta);
            console.log(`[${this.phone}] Auto-scheduled: ${sch.time} (Sub: ${sch.subDuration}m, Eng: ${sch.engDuration}h)`);
        });
    }

    async stop() {
        console.log(`[${this.phone}] Stopping session...`);

        // Clear all active raid schedule timers and warning timers
        if (this.activeTimers) {
            for (const [groupId, timers] of this.activeTimers) {
                if (timers) {
                    for (const scheduleTimers of Object.values(timers)) {
                        if (scheduleTimers.raidTimer) clearTimeout(scheduleTimers.raidTimer);
                        if (scheduleTimers.warningTimer) clearTimeout(scheduleTimers.warningTimer);
                    }
                }
            }
            this.activeTimers.clear();
        }

        // Clear active raid phase timers
        if (this.raidState) {
            if (this.raidState.submissionTimer) clearTimeout(this.raidState.submissionTimer);
            if (this.raidState.engagementTimer) clearTimeout(this.raidState.engagementTimer);
            if (this.raidState.warningTimer) clearTimeout(this.raidState.warningTimer);
            this.raidState.submissionTimer = null;
            this.raidState.engagementTimer = null;
            this.raidState.warningTimer = null;
        }

        if (this.client) {
            try {
                // Ensure browser is closed and all processes terminated
                await this.client.close();
                console.log(`[${this.phone}] Client closed successfully.`);
            } catch (e) {
                console.warn(`[${this.phone}] Close error (possibly already closed):`, e.message);
            } finally {
                this.client = null;
            }
        }
        
        this.status = 'Disconnected';
        this.botStarted = false;
        // NOTE: We don't automatically update DB status to 'Disconnected' here anymore.
        // This allows 'Connected' sessions to persist in the DB so they can be resumed on restart.
    }

    // Helper functions moved inside the class
    parseDelta(text) {
        if (!text) return null;
        const match = text.match(/^(\d+)([mhd])$/);
        if (!match) return null;
        const value = parseInt(match[1], 10);
        const unit = match[2];
        if (unit === 'm') return value * 60 * 1000;
        if (unit === 'h') return value * 60 * 60 * 1000;
        if (unit === 'd') return value * 24 * 60 * 60 * 1000;
        return null;
    }

    saveDefaulters() {
        fs.writeFileSync(this.paths.defaulters, JSON.stringify(this.defaulters, null, 2));
    }

    loadDefaulters() {
        if (fs.existsSync(this.paths.defaulters)) {
            try { this.defaulters = JSON.parse(fs.readFileSync(this.paths.defaulters, 'utf8')); } catch (e) {}
        }
    }

    saveSettings() {
        fs.writeFileSync(this.paths.settings, JSON.stringify(this.groupSettings, null, 2));
    }

    loadSettings() {
        if (fs.existsSync(this.paths.settings)) {
            try { this.groupSettings = JSON.parse(fs.readFileSync(this.paths.settings, 'utf8')); } catch (e) {}
        }
    }

    saveRaidState() {
        const stateToSave = {
            ...this.raidState,
            participants: Array.from(this.raidState.participants || []),
            participantMap: Array.from(this.raidState.participantMap ? this.raidState.participantMap.entries() : []),
            linkToSenderMap: Array.from(this.raidState.linkToSenderMap ? this.raidState.linkToSenderMap.entries() : []),
            links: Array.from(this.raidState.links || [])
        };
        delete stateToSave.submissionTimer;
        delete stateToSave.engagementTimer;
        delete stateToSave.warningTimer;
        fs.writeFileSync(this.paths.raidState, JSON.stringify(stateToSave, null, 2));
    }

    loadRaidState() {
        if (fs.existsSync(this.paths.raidState)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.paths.raidState, 'utf8'));
                data.participants = new Set(data.participants || []);
                data.participantMap = new Map(data.participantMap || []);
                data.linkToSenderMap = new Map(data.linkToSenderMap || []);
                data.links = new Set(data.links || []);
                Object.assign(this.raidState, data);
            } catch (e) {}
        }
    }

    saveSchedules() {
        fs.writeFileSync(this.paths.schedules, JSON.stringify(this.dailySchedules, null, 2));
    }

    loadSchedules() {
        if (fs.existsSync(this.paths.schedules)) {
            try {
                this.dailySchedules = JSON.parse(fs.readFileSync(this.paths.schedules, 'utf8'));
                this.dailySchedules.forEach(s => {
                    if (!s.id) s.id = Date.now() + Math.floor(Math.random() * 1000);
                    this.scheduleDailyRaid(s.groupId, s.hours, s.minutes, s.hostId, s.id);
                });
            } catch (e) {}
        }
    }

    scheduleDailyRaid(groupId, hours, minutes, hostId, scheduleId, subDelta, engDelta) {
        const settings = this.groupSettings[groupId] || { timezone: 'UTC' };
        const tz = settings.timezone;
        const now = new Date();
        const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz === 'Lagos' ? 'Africa/Lagos' : 'UTC', year: 'numeric', month: 'numeric', day: 'numeric', hour12: false });
        const p = {}; formatter.formatToParts(now).forEach(part => p[part.type] = part.value);
        
        let target;
        if (tz === 'Lagos') {
            const dateStr = `${p.year}-${p.month.padStart(2,'0')}-${p.day.padStart(2,'0')}T${hours.toString().padStart(2,'0')}:${minutes.toString().padStart(2,'0')}:00+01:00`;
            target = new Date(dateStr);
        } else {
            target = new Date(Date.UTC(parseInt(p.year), parseInt(p.month)-1, parseInt(p.day), hours, minutes, 0, 0));
        }
        
        if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
        const msUntil = target.getTime() - now.getTime();

        const timerId = setTimeout(() => {
            this.startScheduledRaid(groupId, hostId, subDelta, engDelta);
            this.scheduleDailyRaid(groupId, hours, minutes, hostId, scheduleId, subDelta, engDelta);
        }, msUntil);

        const warningMsUntil = msUntil - (30 * 60 * 1000);
        let warningTimerId = null;
        if (warningMsUntil > 0) {
            warningTimerId = setTimeout(async () => {
                const h = hours % 12 || 12;
                const m = minutes.toString().padStart(2, '0');
                const ampm = hours >= 12 ? 'PM' : 'AM';
                const timeStr = `${h}:${m}${ampm}`;
                const subMins = (subDelta || 1800000) / 60000;
                const engHours = (engDelta || 21600000) / 3600000;
                
                let closeHours = hours, closeMinutes = minutes + subMins;
                while (closeMinutes >= 60) { closeHours = (closeHours + 1) % 24; closeMinutes -= 60; }
                const ch = closeHours % 12 || 12, cm = closeMinutes.toString().padStart(2, '0'), campm = closeHours >= 12 ? 'PM' : 'AM';
                let mentions = [];
                try { const parts = await this.client.getGroupMembers(groupId); mentions = parts.map(p => p.id._serialized || p.id); } catch (e) {}
                const msg = `Prepare your post for ${timeStr} Link Submissions.

*Group Opens by ${timeStr} and closes by ${ch}:${cm}${campm}*

❗Don't drop your link if you have account issues!! 

❗You must Comment meaningfully!!! *Nonsense comments will make you a defaulter* Emoji and one phrase comment isn't a comment it will get you removed


❗You must like ALL posts

❗No selective engagement. *Engage on ALL POSTS* @all`;
                await this.safeSendText(groupId, msg, { mentions });
            }, warningMsUntil);
        }

        if (!this.activeTimers.has(groupId)) this.activeTimers.set(groupId, {});
        this.activeTimers.get(groupId)[scheduleId] = { raidTimer: timerId, warningTimer: warningTimerId };
    }

    async startScheduledRaid(groupId, hostId, subDelta, engDelta) {
        if (this.raidState.active) return;
        const subMs = subDelta || (30 * 60 * 1000);
        const engMs = engDelta || (6 * 60 * 60 * 1000);
        
        Object.assign(this.raidState, {
            active: true, phase: 1, groupId, participants: new Set(), participantMap: new Map(),
            linkToSenderMap: new Map(), firstMsgId: null, lastMsgId: null, links: new Set(),
            startTime: Date.now(), submissionEndTime: Date.now() + subMs, engagementEndTime: Date.now() + subMs + engMs, hostId
        });
        try { await this.client.setGroupProperty(groupId, 'announcement', false); } catch (e) {}
        
        const subMins = subMs / 60000;
        const engHours = engMs / 3600000;
        const msg = `Session started

Post your X.com links below.

Specify alt accounts with 

Alt - x.com/username

⏰ Submission Ends: in ${subMins}m
🏁 Engagement Ends: in ${engHours}h after that.`;
        await this.safeSendText(groupId, msg);
        this.raidState.submissionTimer = setTimeout(() => this.startPhaseTwo(), subMs);
        this.saveRaidState();
    }

    async startPhaseTwo() {
        if (!this.raidState.active || this.raidState.phase !== 1) return;
        this.raidState.phase = 2;
        try { await this.client.setGroupProperty(this.raidState.groupId, 'announcement', true); } catch (e) {}
        
        const linksArr = Array.from(this.raidState.links);
        const mentions = [];
        try {
            const parts = await this.client.getGroupMembers(this.raidState.groupId);
            parts.forEach(p => mentions.push(p.id._serialized || p.id));
        } catch(e) {}
        
        const phase2Msg = `*${linksArr.length} LINKS*

❌ NO SELECTIVE ENGAGEMENT. Engage on ALL POSTS

_MODE OF ENGAGEMENT 👇_

1. LIKE 👍
2. COMMENT MEANINGFULLY!! 📝 

*SEE YOU BY ${new Date(this.raidState.engagementEndTime).toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' })} (Lagos)* @all`;
        
        await this.safeSendText(this.raidState.groupId, phase2Msg, { mentions });
        this.saveRaidState();
        
        const engRemaining = Math.max(0, this.raidState.engagementEndTime - Date.now());
        this.raidState.engagementTimer = setTimeout(() => this.endRaid(), engRemaining);
    }

    async endRaid() {
        if (!this.raidState.active) return;
        this.raidState.phase = 3;
        try { await this.client.setGroupProperty(this.raidState.groupId, 'announcement', false); } catch (e) {}
        
        await this.client.sendText(this.raidState.groupId, `⏳ Engagement Phase Ended! Vetting defaulters now... Please wait.`);

        // Call the vetting logic
        const linksArray = Array.from(this.raidState.links);
        const participantHandles = Array.from(this.raidState.participants);
        this.runVetting(linksArray, participantHandles, async (vettingResult) => {
            if (vettingResult.error) {
                await this.safeSendText(this.raidState.groupId, `⚠ Error during vetting: ${vettingResult.error}`);
            } else {
                const defaulters = vettingResult.defaulters || [];
                const winners = participantHandles.filter(p => !defaulters.includes(p));
                
                let report = `✅ *Vetting Result* (Checked ${linksArray.length} links)

*Found in ${linksArray.length} of ${linksArray.length}:*
${winners.map(w => `@${w.split('@')[0]}`).join('\n') || 'None'}

*Found in NONE:*
${defaulters.map(d => `@${d.split('@')[0]}`).join('\n') || 'None'}`;

                if (defaulters.length > 0) {
                    report += `\n\n⚠️ *DEFAULTERS LIST* ⚠️
━━━━━━━━━━━━━━━━━━━━━━
${defaulters.map(d => `@${d.split('@')[0]} - Strike 1 (24h ban)`).join('\n')}
━━━━━━━━━━━━━━━━━━━━━━`;
                }

                const admins = await this.client.getGroupAdmins(this.raidState.groupId);
                const adminIds = admins.map(a => (typeof a === 'string') ? a : (a.id ? a.id._serialized : a.user+'@c.us'));
                await this.safeSendText(this.raidState.groupId, report, { mentions: [...participantHandles, ...adminIds] });
            }
            // Reset raid state
            this.raidState.active = false;
            this.raidState.phase = 0;
            this.raidState.links.clear();
            this.raidState.linkToSenderMap.clear();
            this.raidState.participants.clear();
            this.saveRaidState();
        });
    }

    async isUserAdmin(groupId, authorId) {
        try {
            const admins = await this.client.getGroupAdmins(groupId);
            for (let admin of admins) {
                if (typeof admin === 'string' && admin === authorId) return true;
                if (admin.id && admin.id._serialized === authorId) return true;
                if (admin.user && authorId.startsWith(admin.user)) return true;
            }
            return false;
        } catch (e) { return false; }
    }

    setupMessageListener() {
        this.client.onAnyMessage(async (message) => {
            if (!message.body) return;
            
            // 1. FILTER: Ignore status updates and automated broadcast noise
            if (message.from === 'status@broadcast' || message.from.includes('broadcast')) return;

            const isCommand = message.body.startsWith('.');
            const isRaidRelevant = this.raidState.active && message.from === this.raidState.groupId;
            
            
            
            // Admin Check
            if (message.isGroupMsg) {
                const adminCommands = ['.startraid', '.endraid', '.ongoingraid', '.mute', '.unmute', '.schedule', '.delete', '.test'];
                if (adminCommands.some(cmd => message.body.startsWith(cmd))) {
                    const isAdmin = await this.isUserAdmin(message.from, message.author || message.from);
                    if (!isAdmin) {
                        await this.client.sendText(message.from, '⚠ Only group admins can use this command.');
                        return;
                    }
                    
                    // Handle admin commands
                    if (message.body.startsWith('.startraid')) {
                        if (this.raidState.active) {
                            await this.client.sendText(message.from, '⚠ A raid is already active!');
                        } else {
                            this.startScheduledRaid(message.from, message.author || message.from, 30 * 60 * 1000, 6 * 60 * 60 * 1000);
                        }
                    }
                    if (message.body.startsWith('.endraid')) {
                        if (!this.raidState.active) {
                            await this.client.sendText(message.from, '⚠ No active raid to end.');
                        } else {
                            if (this.raidState.submissionTimer) clearTimeout(this.raidState.submissionTimer);
                            if (this.raidState.engagementTimer) clearTimeout(this.raidState.engagementTimer);
                            this.endRaid();
                        }
                    }
                    if (message.body.startsWith('.mute')) {
                        await this.client.setGroupProperty(message.from, 'announcement', true);
                        await this.safeSendText(message.from, 'Group muted.');
                    }
                    if (message.body.startsWith('.unmute')) {
                        await this.client.setGroupProperty(message.from, 'announcement', false);
                        await this.safeSendText(message.from, 'Group unmuted.');
                    }
                }
            }

            if (message.body === '.menu') {
                const menu = `📋 *BOT MENU* 📋
━━━━━━━━━━━━━━━━━━━━━━
*.startraid <sub_time> <eng_time>*
> Starts a raid. Example: .startraid 30m 2h

*.ongoingraid*
> Shows active raid progress & links

*.endraid*
> Skips the current raid phase early

*.mute*
> Locks the group manually

*.unmute*
> Unlocks the group manually

*.menu*
> Shows this command list

*.schedule*
> View automated raid schedules

*.test*
> Shows all bot messages demo
━━━━━━━━━━━━━━━━━━━━━━`;
                await this.safeSendText(message.from, menu);
            }

            if (message.body === '.ongoingraid') {
                if (!this.raidState.active) {
                    await this.safeSendText(message.from, '❌ No active raid found.');
                    return;
                }
                const remaining = Math.max(0, (this.raidState.phase === 1 ? this.raidState.submissionEndTime : this.raidState.engagementEndTime) - Date.now());
                const minsLeft = Math.ceil(remaining / 60000);
                const linksArr = Array.from(this.raidState.links);
                
                const status = `🚀 *Active Raid Status* 🚀

*Current Phase:* Phase ${this.raidState.phase}: ${this.raidState.phase === 1 ? 'Link Submission' : 'Engagement'}
*Time Until Next Phase:* ${minsLeft}m left

*Collected Links (${linksArr.length} total):*
${linksArr.map((l, i) => `${i + 1}. ${l}`).join('\n') || 'None yet'}`;
                await this.safeSendText(message.from, status);
            }

            if (message.body === '.test') {
                const demoMessages = [
                    `🕒 *Current Times:*
    
🇳🇬 Lagos: ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' })}
🌐 UTC: ${new Date().toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' })}

📍 *Group Setting:* Lagos`,
                    `Prepare your post for 9:00 PM Link Submissions.

*Group Opens by 9:00 PM and closes by 9:30 PM*

❗Don't drop your link if you have account issues!! 

❗You must Comment meaningfully!!! *Nonsense comments will make you a defaulter* Emoji and one phrase comment isn't a comment it will get you removed


❗You must like ALL posts

❗No selective engagement. *Engage on ALL POSTS* @all`,
                    `Session started

Post your X.com links below.

Specify alt accounts with 

Alt - x.com/username

⏰ Submission Ends: in 30m
🏁 Engagement Ends: in 2h after that.`,
                    `*21 LINKS*

❌ NO SELECTIVE ENGAGEMENT. Engage on ALL POSTS

_MODE OF ENGAGEMENT 👇_

1. LIKE 👍
2. COMMENT MEANINGFULLY!! 📝 

*SEE YOU BY 9:00 PM (Lagos)* @all`,
                    `⚠️ *30 MINUTES LEFT!* ⚠️

This is your final call to engage on all submitted links. 

*Verification by 9:0s0pm*.`,
                    `🛑 *Engagement Time Over!*

Starting verification for all participants... This may take a few minutes.`,
                    `✅ *Vetting Result* (Checked 10 links)

*Found in 10 of 10:*
@user1
@user2

*Found in NONE:*
@user3`,
                    `⚠️ *DEFAULTERS LIST* ⚠️
━━━━━━━━━━━━━━━━━━━━━━
@user3 - Strike 1 (24h ban)
@user4 - Strike 4 (REMOVED FROM GROUP)
━━━━━━━━━━━━━━━━━━━━━━`,
                    `🚀 *Active Raid Status* 🚀

*Current Phase:* Phase 1: Link Submission
*Time Until Next Phase:* 15m left

*Collected Links (3 total):*
1. https://x.com/user/status/123
2. https://x.com/user/status/456
3. https://x.com/user/status/789`,
                    `📅 *Scheduled Daily Raids (Lagos):*

🆔 *ID:* 1234
⏰ *Time:* 9:00 PM

To remove a raid, use: .delete ID`
                ];
                for (const msg of demoMessages) {
                    await this.safeSendText(message.from, msg);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            if (message.body === '.schedule') {
                if (this.dailySchedules.length === 0) {
                    await this.client.sendText(message.from, '📅 No automated raids scheduled for this account.');
                    return;
                }
                
                const formatTime = (h, m) => {
                    const hour = parseInt(h);
                    const min = String(m).padStart(2, '0');
                    const ampm = hour >= 12 ? 'PM' : 'AM';
                    const h12 = hour % 12 || 12;
                    return `${h12}:${min} ${ampm}`;
                };

                let res = `📅 *Scheduled Daily Raids (Lagos):*\n\n`;
                this.dailySchedules.forEach((s, i) => {
                    res += `🆔 *ID:* ${s.id}\n⏰ *Time:* ${formatTime(s.hours, s.minutes)}\n\n`;
                });
                res += `To remove a raid, use: \`.delete ID\``;
                await this.safeSendText(message.from, res);
            }

            if (message.body.startsWith('.delete ')) {
                const idToRemove = message.body.split(' ')[1];
                if (!idToRemove) return;

                const index = this.dailySchedules.findIndex(s => String(s.id) === String(idToRemove));
                if (index === -1) {
                    await this.safeSendText(message.from, `❌ Raid ID ${idToRemove} not found.`);
                    return;
                }

                const removed = this.dailySchedules.splice(index, 1)[0];
                this.saveSchedules();
                
                // Clear any running timers for THIS specific schedule ID
                for (const [groupId, timers] of this.activeTimers) {
                    const t = timers[removed.id];
                    if (t) {
                        if (t.raidTimer) clearTimeout(t.raidTimer);
                        if (t.warningTimer) clearTimeout(t.warningTimer);
                        delete timers[removed.id];
                    }
                }

                await this.safeSendText(message.from, `✅ Removed raid for ${removed.hours}:${String(removed.minutes).padStart(2,'0')} (ID: ${idToRemove})`);
            }
            
            // Handle raids, link collection, etc. (logic using 'this.raidState')
            if (this.raidState.active && this.raidState.phase === 1 && message.from === this.raidState.groupId) {
                const urlRegex = /(https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/status\/[0-9]+)/g;
                const matches = message.body.match(urlRegex);
                if (matches) {
                    // Logic to add links to this.raidState.links...
                    matches.forEach(url => {
                        this.raidState.links.add(url);
                        this.raidState.linkToSenderMap.set(url, message.author || message.from);
                        this.saveRaidState();
                    });
                }
            }
        });
    }

    runVetting(links, participants, callback) {
        const scriptPath = path.join(__dirname, 'vetting_bridge.py');
        const pythonExecutable = process.env.PYTHON_EXECUTABLE || 'python3';
        let output = '';
        let callbackCalled = false;

        const startPython = (command) => {
            const pythonProcess = spawn(command, [scriptPath]);

            pythonProcess.stdout.on('data', (data) => output += data.toString());
            pythonProcess.stderr.on('data', (data) => console.error(`[vetting_bridge] ${data.toString().trim()}`));

            pythonProcess.on('error', (err) => {
                if (err.code === 'ENOENT' && command === 'python3') {
                    console.warn('[vetting_bridge] python3 not found, falling back to python');
                    return startPython('python');
                }
                if (!callbackCalled) {
                    callbackCalled = true;
                    callback({ error: `Python execution error: ${err.message}` });
                }
            });

            pythonProcess.on('close', (code) => {
                if (callbackCalled) return;
                callbackCalled = true;

                if (code !== 0) {
                    return callback({ error: `Python process exited with code ${code}` });
                }

                try {
                    callback(JSON.parse(output));
                } catch (e) {
                    callback({ error: 'Failed to parse vetting response' });
                }
            });

            pythonProcess.stdin.write(JSON.stringify({ target_links: links, participant_handles: participants }));
            pythonProcess.stdin.end();
        };

        startPython(pythonExecutable);
    }
}

    app.use(express.static(path.join(__dirname, 'dashboard')));
app.use(express.json());

// Middleware to verify JWT
const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden' });
        req.user = user;
        next();
    });
};

// Auth Routes
app.post('/api/auth/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const role = username.toLowerCase() === 'web3kaiju' ? 'admin' : 'user';
    try {
        const hash = await bcrypt.hash(password, 10);
        db.run('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)',
            [username, hash, role, Date.now()],
            function (err) {
                if (err) return res.status(400).json({ error: 'Username taken or error created' });
                res.json({ message: 'User created' });
            }
        );
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'User not found' });
        
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(403).json({ error: 'Invalid password' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
        res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.json({ message: 'Logged in', role: user.role });
    });
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
    res.json(req.user);
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: 'Logged out' });
});

// We protect the dashboard serving route - if no token, push them to login
app.get('/', (req, res) => {
    if (!req.cookies.token) {
        return res.redirect('/login.html');
    }
    res.sendFile(path.join(__dirname, 'dashboard', 'dashboard.html'));
});
app.get('/status', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.json({ accounts: [] });
    let accounts = [];
    const workerDir = path.join(DATA_DIR, 'worker_sessions');
    if (fs.existsSync(workerDir)) {
        const findJsons = (dir) => {
            let results = [];
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                const fullPath = path.join(dir, file);
                const stat = fs.statSync(fullPath);
                if (stat && stat.isDirectory()) results = results.concat(findJsons(fullPath));
                else if (file.endsWith('.json')) results.push(file);
            });
            return results;
        }
        accounts = findJsons(workerDir);
    }
    res.json({ accounts });
});

app.post('/upload-auth', authenticateToken, upload.array('authFiles'), (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    res.json({ message: 'Files uploaded successfully' });
});

app.post('/delete-auth', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    const { filename } = req.body;
    const workerDir = path.join(DATA_DIR, 'worker_sessions');
    const findAndDelete = (dir) => {
        const list = fs.readdirSync(dir);
        list.forEach(file => {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat && stat.isDirectory()) findAndDelete(fullPath);
            else if (file === filename) fs.unlinkSync(fullPath);
        });
    }
    if (fs.existsSync(workerDir)) findAndDelete(workerDir);
    res.json({ message: 'Account deleted' });
});


// API: Admin View Users
app.get('/api/admin/users', authenticateToken, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    db.all('SELECT id, username, role, created_at FROM users ORDER BY created_at DESC', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// API: Get all accounts
app.get('/api/accounts', authenticateToken, (req, res) => {
    let sql = 'SELECT * FROM whatsapp_accounts';
    let params = [];
    if (req.user.role !== 'admin') {
        sql += ' WHERE user_id = ?';
        params.push(req.user.id);
    }
    db.all(sql, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const dbAccountPhones = new Set(rows.map(r => r.phone));
        const results = rows.map(row => {
            let settings = {};
            try { settings = JSON.parse(row.settings || '{}'); } catch (e) {}
            return {
                ...row,
                settings,
                currentStatus: activeSessions.get(row.phone)?.status || 'Offline',
                pairingCode: activeSessions.get(row.phone)?.pairingCode || '',
                qr: activeSessions.get(row.phone)?.qr || '',
                isPersisted: true
            };
        });

        // Add in-memory sessions that haven't hit the DB yet (for pairing visibility)
        activeSessions.forEach((session, phone) => {
            if (!dbAccountPhones.has(phone)) {
                results.push({
                    phone: session.phone,
                    name: session.name,
                    session_id: session.sessionId,
                    expiry_at: session.expiryAt,
                    status: session.status,
                    currentStatus: session.status,
                    pairingCode: session.pairingCode,
                    qr: session.qr,
                    settings: session.settings,
                    isPersisted: false
                });
            }
        });

        res.json(results);
    });
});

// API: Connect new account
app.post('/api/connect', authenticateToken, async (req, res) => {
    const { name, phone, settings } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and Phone are required' });

    if (pendingOperations.has(phone)) {
        return res.status(409).json({ error: 'An operation is already in progress for this phone number. Please wait.' });
    }

    pendingOperations.add(phone);

    try {
        const sessionId = `session_${phone.replace(/\D/g, '')}`;
        const createdAt = Date.now();
        const expiryAt = createdAt + (30 * 24 * 60 * 60 * 1000); // 30 days
        
        // Stop any existing session
        let session = activeSessions.get(phone);
        if (session) {
            await session.stop();
            activeSessions.delete(phone);
        }

        // Initialize in memory ONLY
        session = new BotSession({ 
            phone, 
            name, 
            sessionId, 
            expiryAt, 
            settings: settings || {}, 
            userId: req.user.id,
            isPersisted: false 
        });
        activeSessions.set(phone, session);
        
        // Start initialization in background
        session.initWithPairing();
        res.json({ message: 'Connection initiated', phone });

    } catch (e) {
        pendingOperations.delete(phone);
        console.error(`[${phone}] Connect setup error:`, e);
        if (!res.headersSent) res.status(500).json({ error: e.message });
    } finally {
        pendingOperations.delete(phone);
    }
});

// API: Delete account
app.post('/api/delete', authenticateToken, async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });

    if (pendingOperations.has(phone)) {
        return res.status(409).json({ error: 'An operation is already in progress for this phone number.' });
    }
    
    pendingOperations.add(phone);

    // Fetch session record first so we have sessionId for file cleanup
    db.get('SELECT * FROM whatsapp_accounts WHERE phone = ?', [phone], async (err, row) => {
        if (err) {
            pendingOperations.delete(phone);
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            pendingOperations.delete(phone);
            return res.status(404).json({ error: 'Not found' });
        }
        if (req.user.role !== 'admin' && row.user_id !== req.user.id) {
            pendingOperations.delete(phone);
            return res.status(403).json({ error: 'Forbidden' });
        }

        try {
            // Stop the active in-memory session (clears timers, logs out, closes browser)
            const session = activeSessions.get(phone);
            if (session) {
                await session.stop();
                activeSessions.delete(phone);
                // Give the OS a moment to release file handles
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            // Delete wppconnect token/session folder from disk
            if (row) {
                const tokenDir = path.join(__dirname, 'tokens', row.session_id);
                if (fs.existsSync(tokenDir)) {
                    let attempts = 0;
                    const maxAttempts = 3;
                    while (attempts < maxAttempts) {
                        try {
                            fs.rmSync(tokenDir, { recursive: true, force: true });
                            console.log(`[${phone}] Deleted token folder: ${tokenDir}`);
                            break;
                        } catch (e) {
                            attempts++;
                            if (attempts === maxAttempts) {
                                console.warn(`[${phone}] Failed to delete token folder after ${maxAttempts} attempts:`, e.message);
                            } else {
                                console.log(`[${phone}] Token folder locked, retrying in 2s... (Attempt ${attempts}/${maxAttempts})`);
                                await new Promise(resolve => setTimeout(resolve, 2000));
                            }
                        }
                    }
                }

                // Delete all sidecar JSON files for this session
                const sidecars = [
                    path.join(DATA_DIR, `defaulters_${row.session_id}.json`),
                    path.join(DATA_DIR, `group_settings_${row.session_id}.json`),
                    path.join(DATA_DIR, `schedules_${row.session_id}.json`),
                    path.join(DATA_DIR, `raid_state_${row.session_id}.json`)
                ];
                sidecars.forEach(filePath => {
                    try {
                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                            console.log(`[${phone}] Deleted sidecar: ${path.basename(filePath)}`);
                        }
                    } catch (e) {
                        console.warn(`[${phone}] Failed to delete sidecar ${path.basename(filePath)}:`, e.message);
                    }
                });
            }

            // Remove from database
            db.run('DELETE FROM whatsapp_accounts WHERE phone = ?', [phone], (err2) => {
                pendingOperations.delete(phone);
                if (err2) return res.status(500).json({ error: err2.message });
                res.json({ message: 'Account fully deleted' });
            });
        } catch (e) {
            pendingOperations.delete(phone);
            console.error(`[${phone}] Delete error:`, e);
            if (!res.headersSent) res.status(500).json({ error: e.message });
        }
    });
});

// Auto-expiry check every hour
setInterval(async () => {
    const now = Date.now();
    db.all('SELECT * FROM whatsapp_accounts WHERE expiry_at < ?', [now], async (err, rows) => {
        if (err) return console.error('Expiry check error:', err);
        for (const row of rows) {
            console.log(`[${row.phone}] Subscription expired. Terminating...`);
            const session = activeSessions.get(row.phone);
            if (session) {
                await session.stop();
                activeSessions.delete(row.phone);
            }
            db.run('UPDATE whatsapp_accounts SET status = ? WHERE phone = ?', ['Expired', row.phone]);
        }
    });
}, 60 * 60 * 1000);

async function initAllSessions() {
    // ONLY auto-start sessions that were successfully connected/logged in.
    // This prevents ghost pairing attempts from bothering the user on restart.
    db.all('SELECT * FROM whatsapp_accounts WHERE status IN ("Connected", "Disconnected")', async (err, rows) => {
        if (err) return console.error('Init sessions error:', err);
        if (rows.length > 0) console.log(`Found ${rows.length} active sessions to resume...`);
        for (const row of rows) {
            try {
                // Stagger initialization to avoid CPU/RAM spikes
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                let settings = {};
                try { settings = JSON.parse(row.settings || '{}'); } catch (e) {}
                const session = new BotSession({
                    phone: row.phone,
                    name: row.name,
                    sessionId: row.session_id,
                    expiryAt: row.expiry_at,
                    settings
                });
                activeSessions.set(row.phone, session);
                session.initWithPairing().catch(e => console.error(`[${row.phone}] Session init failed:`, e));
            } catch (e) {
                console.error(`[${row.phone}] Failed to create BotSession:`, e);
            }
        }
    });
}

const server = app.listen(port, () => {
    console.log(`🚀 Commercial Bot Dashboard running at http://localhost:${port}/`);
    initAllSessions();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log("\nGracefully shutting down all sessions...");
    for (const session of activeSessions.values()) {
        await session.stop();
    }
    db.close();
    process.exit(0);
});

// Global Error Handlers to prevent library-level crashes from killing the dashboard
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception thrown:', err);
});

// End of file
