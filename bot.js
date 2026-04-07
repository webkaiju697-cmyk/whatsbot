const wppconnect = require('@wppconnect-team/wppconnect');
const { spawn } = require('child_process');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = 3000;

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
    db.run(`CREATE TABLE IF NOT EXISTS whatsapp_accounts (
        phone TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expiry_at INTEGER NOT NULL,
        status TEXT DEFAULT 'disconnected',
        settings TEXT DEFAULT '{}'
    )`);
    // Migrate existing tables that don't have the settings column yet
    db.run(`ALTER TABLE whatsapp_accounts ADD COLUMN settings TEXT DEFAULT '{}'`, () => {});
});

// Global state for session management
const activeSessions = new Map(); // phone -> BotSession instance

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    if (promise) console.error('Promise:', promise);
});

class BotSession {
    constructor(config) {
        this.phone = config.phone;
        this.name = config.name;
        this.sessionId = config.sessionId || `session_${String(this.phone || '').replace(/\D/g, '')}`;
        this.expiryAt = config.expiryAt;
        this.settings = config.settings || {}; // pre-connection bot settings
        this.client = null;
        this.status = 'Idle';
        this.qr = '';
        this.pairingCode = '';
        this._pairingRetryTimer = null;
        this._rateLimitRetryTimer = null;
        this._botStarted = false;
        
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
        
        // Define persistent paths
        this.paths = {
            defaulters: path.join(DATA_DIR, `defaulters_${this.sessionId}.json`),
            settings: path.join(DATA_DIR, `group_settings_${this.sessionId}.json`),
            schedules: path.join(DATA_DIR, `schedules_${this.sessionId}.json`),
            raidState: path.join(DATA_DIR, `raid_state_${this.sessionId}.json`),
            tokens: path.join(DATA_DIR, 'tokens')
        };
    }

    async init() {
        console.log(`[${this.phone}] Initializing session for ${this.name}...`);
        
        try {
            this.client = await wppconnect.create({
                session: this.sessionId,
                mkdirFolderToken: this.paths.tokens,
                logQR: false,
                autoClose: 0,
                disableWelcome: true, 
                createBrowserDevice: true,
                autoDownload: {
                    image: false,
                    video: false,
                    audio: false,
                    document: false,
                },
                puppeteerOptions: {
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-extensions',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-web-security',
                        '--disable-features=VizDisplayCompositor',
                        '--disable-ipc-flooding-protection',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding',
                        ...(process.env.HTTP_PROXY ? [`--proxy-server=${process.env.HTTP_PROXY}`] : []),
                        ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`] : []),
                        '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    ],
                    ignoreHTTPSErrors: true,
                    ignoreDefaultArgs: ['--disable-extensions'],
                    headless: 'new'
                },
                onQRCode: (base64) => {
                    this.qr = base64;
                    this.status = 'Waiting for QR Scan';
                },
                statusFind: (status) => {
                    this.status = status;
                    this.updateDbStatus(status);
                }
            });

            this.status = 'Connected';
            this.qr = '';
            this.updateDbStatus('Connected');
            this.startBot();
        } catch (error) {
            console.error(`[${this.phone}] Failed to init:`, error);
            this.status = 'Error';
        }
    }

    async initWithPairing() {
        console.log(`[${this.phone}] Starting session with pairing for ${this.name}...`);
        this.pairingCode = '';
        
        try {
            this.client = await wppconnect.create({
                session: this.sessionId,
                mkdirFolderToken: this.paths.tokens,
                phoneNumber: this.phone,
                logQR: false,
                autoClose: 0,
                disableWelcome: true,
                createBrowserDevice: true,
                autoDownload: {
                    image: false,
                    video: false,
                    audio: false,
                    document: false,
                },
                puppeteerOptions: {
                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-extensions',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-web-security',
                        '--disable-features=VizDisplayCompositor',
                        '--disable-ipc-flooding-protection',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding',
                        ...(process.env.HTTP_PROXY ? [`--proxy-server=${process.env.HTTP_PROXY}`] : []),
                        ...(process.env.HTTPS_PROXY ? [`--proxy-server=${process.env.HTTPS_PROXY}`] : []),
                        '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    ],
                    ignoreHTTPSErrors: true,
                    ignoreDefaultArgs: ['--disable-extensions'],
                    headless: 'new'
                },
                onQRCode: (base64) => {
                    console.log(`[${this.phone}] QR callback fired - received QR data`);
                    this.qr = base64;
                    this.status = 'Waiting for QR Scan';
                    this.updateDbStatus('Waiting for QR Scan');
                    console.log(`[${this.phone}] QR code received for pairing.`);
                },
                catchLinkCode: (code) => {
                    console.log(`[${this.phone}] Pairing code callback fired - received code: ${code}`);
                    this.pairingCode = code;
                    this.status = 'Waiting for Pairing Code';
                    this.updateDbStatus('Waiting for Pairing Code');
                    console.log(`[${this.phone}] Pairing Code generated (via catchLinkCode): ${code}`);
                },
                onReady: () => {
                    console.log(`[${this.phone}] WhatsApp client is ready`);
                    if (!this._botStarted) {
                        this._botStarted = true;
                        this.startBot();
                    }
                },
                statusFind: async (status) => {
                    this.status = status;
                    this.updateDbStatus(status);
                    if (status === 'isLogged' || status === 'qrReadSuccess' || status === 'Connected') {
                        this.pairingCode = '';
                        this.qr = '';
                        if (this._pairingRetryTimer) {
                            clearTimeout(this._pairingRetryTimer);
                            this._pairingRetryTimer = null;
                        }
                        if (this._rateLimitRetryTimer) {
                            clearTimeout(this._rateLimitRetryTimer);
                            this._rateLimitRetryTimer = null;
                        }
                        // Delay startBot to ensure client is fully ready
                        setTimeout(() => {
                            if (this.client && !this._botStarted) {
                                this._botStarted = true;
                                this.startBot();
                            } else if (!this.client) {
                                console.error(`[${this.phone}] startBot still skipped after delay: client is null`);
                            }
                        }, 2000);
                    }
                    if (status === 'notLogged') {
                        // Pairing code is now forced immediately after client init
                        console.log(`[${this.phone}] Status changed to notLogged - pairing should already be initiated`);
                    }
                }
            });

            // Initial check after some delay to allow hooks to fire
            setTimeout(async () => {
                if (this.client) {
                    const logged = await this.client.isLoggedIn();
                    if (logged) {
                        this.status = 'Connected';
                        this.updateDbStatus('Connected');
                        this.startBot();
                    } else {
                        // Force pairing code generation since callbacks aren't firing
                        console.log(`[${this.phone}] Forcing pairing code generation...`);
                        try {
                            this.pairingCode = await this.client.getPairingCode(this.phone);
                            this.status = 'Waiting for Pairing Code';
                            this.updateDbStatus('Waiting for Pairing Code');
                            console.log(`[${this.phone}] Forced pairing code: ${this.pairingCode}`);
                        } catch (e) {
                            console.warn(`[${this.phone}] Forced pairing code failed:`, e.message || e);
                            if (String(e).includes('RateOverlimit') || (e?.name && e?.name.includes('IQErrorRateOverlimit'))) {
                                this.schedulePairingRetry(60000, 'rate limit during force');
                            }
                        }
                    }
                }
            }, 10000);

        } catch (error) {
            console.error(`[${this.phone}] Failed to init with pairing:`, error);
            if (String(error).includes('RateOverlimit') || (error?.name && error?.name.includes('IQErrorRateOverlimit'))) {
                this.schedulePairingRetry(60000, 'rate limit during init');
            } else {
                this.status = 'Error';
                this.updateDbStatus(this.status);
            }
        }
    }

    schedulePairingRetry(delayMs, reason) {
        if (this._rateLimitRetryTimer) return;
        console.warn(`[${this.phone}] Scheduling pairing retry in ${delayMs / 1000}s (${reason})`);
        this.status = 'Retrying pairing';
        this.updateDbStatus(this.status);
        this._rateLimitRetryTimer = setTimeout(async () => {
            this._rateLimitRetryTimer = null;
            try {
                if (!this.client) {
                    await this.initWithPairing();
                } else if (!this.pairingCode && !this.qr) {
                    this.pairingCode = await this.client.getPairingCode(this.phone);
                    this.status = 'Waiting for Pairing Code';
                    this.updateDbStatus(this.status);
                    console.log(`[${this.phone}] Recovered manual pairing code: ${this.pairingCode}`);
                }
            } catch (err) {
                console.error(`[${this.phone}] Pairing retry failed:`, err);
                if (String(err).includes('RateOverlimit') || (err?.name && err?.name.includes('IQErrorRateOverlimit'))) {
                    this.schedulePairingRetry(Math.min(delayMs * 2, 120000), 'rate limit');
                }
            }
        }, delayMs);
    }

    async updateDbStatus(status) {
        db.run('UPDATE whatsapp_accounts SET status = ? WHERE phone = ?', [status, this.phone]);
    }

    startBot() {
        if (!this.client) {
            console.error(`[${this.phone}] startBot aborted: client is null or unavailable`);
            return;
        }
        console.log(`[${this.phone}] Starting bot logic...`);
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
        for (const [groupId, timers] of this.activeTimers) {
            for (const scheduleTimers of Object.values(timers)) {
                if (scheduleTimers.raidTimer) clearTimeout(scheduleTimers.raidTimer);
                if (scheduleTimers.warningTimer) clearTimeout(scheduleTimers.warningTimer);
            }
        }
        this.activeTimers.clear();

        // Clear active raid phase timers
        if (this.raidState.submissionTimer) clearTimeout(this.raidState.submissionTimer);
        if (this.raidState.engagementTimer) clearTimeout(this.raidState.engagementTimer);
        if (this.raidState.warningTimer) clearTimeout(this.raidState.warningTimer);
        this.raidState.submissionTimer = null;
        this.raidState.engagementTimer = null;
        this.raidState.warningTimer = null;

        if (this.client) {
            try {
                await this.client.logout(); // Revoke WhatsApp session on device
            } catch (e) {
                console.warn(`[${this.phone}] Logout failed (may already be disconnected):`, e.message);
            }
            try {
                await this.client.close();
            } catch (e) {
                console.warn(`[${this.phone}] Close failed:`, e.message);
            }
            this.client = null;
        }
        this.status = 'Disconnected';
        this.updateDbStatus('Disconnected');
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

    saveRaidState() {
        fs.writeFileSync(this.paths.raidState, JSON.stringify(this.raidState, null, 2));
    }

    loadRaidState() {
        if (fs.existsSync(this.paths.raidState)) {
            try {
                const loaded = JSON.parse(fs.readFileSync(this.paths.raidState, 'utf8'));
                // Merge loaded state with current raidState, preserving non-serializable properties
                Object.assign(this.raidState, loaded);
                // Clear timers since they can't be restored from JSON
                this.raidState.submissionTimer = null;
                this.raidState.engagementTimer = null;
                this.raidState.warningTimer = null;
            } catch (e) {
                console.warn(`[${this.phone}] Failed to load raid state:`, e.message);
            }
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
                const msg = `Prepare your post for ${timeStr} Link Submissions.\n\n*Group Opens by ${timeStr} and closes by ${ch}:${cm}${campm}*\n\n❗Don't drop your link if you have account issues!!... @all`;
                await this.client.sendText(groupId, msg, { mentions });
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
        await this.client.sendText(groupId, `Session started... Sub ends in ${subMins}m, Eng ends in ${engHours}h.`);
        this.raidState.submissionTimer = setTimeout(() => this.startPhaseTwo(), subMs);
        this.saveRaidState();
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
        if (!this.client || typeof this.client.onAnyMessage !== 'function') {
            console.warn(`[${this.phone}] setupMessageListener skipped: client unavailable or missing onAnyMessage`);
            return;
        }

        this.client.onAnyMessage(async (message) => {
            if (!message.body) return;
            
            // Admin Check
            if (message.isGroupMsg) {
                const adminCommands = ['.startraid', '.endraid', '.mute', '.unmute', '.schedule', '.delete'];
                if (adminCommands.some(cmd => message.body.startsWith(cmd))) {
                    const isAdmin = await this.isUserAdmin(message.from, message.author || message.from);
                    if (!isAdmin) {
                        await this.client.sendText(message.from, '⚠ Only group admins can use this command.');
                        return;
                    }
                }
            }

            if (message.body === '.menu') {
                const menu = `📋 *BOT MENU* (User: ${this.name})

*Raid Control:*
• \`.startraid\` - Manually start a raid
• \`.endraid\` - Force end active raid
• \`.mute\` / \`.unmute\` - Toggle group chat
• \`.schedule\` - View scheduled raids
• \`.delete [ID]\` - Remove a raid by ID

*Dashboard:*
• Use the web dashboard at http://localhost:3000 to manage automated raid schedules, durations, and timezones.

*Subscription:*
• Expiry: ${new Date(this.expiryAt).toLocaleDateString()}`;
                await this.client.sendText(message.from, menu);
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

                let res = `📅 *SCHEDULED RAIDS*\n\n`;
                this.dailySchedules.forEach((s, i) => {
                    const subMins = (s.subDelta || 1800000) / 60000;
                    const engHours = (s.engDelta || 21600000) / 3600000;
                    res += `${i + 1}. *ID: ${s.id}*\n   Time: ${formatTime(s.hours, s.minutes)}\n   Duration: ${subMins}m sub, ${engHours}h eng\n\n`;
                });
                res += `To remove a raid, use: \`.delete ID\``;
                await this.client.sendText(message.from, res);
            }

            if (message.body.startsWith('.delete ')) {
                const idToRemove = message.body.split(' ')[1];
                if (!idToRemove) return;

                const index = this.dailySchedules.findIndex(s => String(s.id) === String(idToRemove));
                if (index === -1) {
                    await this.client.sendText(message.from, `❌ Raid ID ${idToRemove} not found.`);
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

                await this.client.sendText(message.from, `✅ Removed raid for ${removed.hours}:${String(removed.minutes).padStart(2,'0')} (ID: ${idToRemove})`);
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
        const pythonProcess = spawn('python', ['vetting_bridge.py']);
        let output = '';
        pythonProcess.stdout.on('data', (data) => output += data.toString());
        pythonProcess.on('close', () => {
            try { callback(JSON.parse(output)); } catch (e) { callback({ error: 'Failed to parse' }); }
        });
        pythonProcess.stdin.write(JSON.stringify({ target_links: links, participant_handles: participants }));
        pythonProcess.stdin.end();
    }
}

    app.use(express.static(path.join(__dirname, 'dashboard')));
    app.use(express.json());

    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'support.html')));
    app.get('/status', (req, res) => {
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

    app.post('/upload-auth', upload.array('authFiles'), (req, res) => {
        res.json({ message: 'Files uploaded successfully' });
    });

    app.post('/delete-auth', (req, res) => {
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

// API: Get all accounts
app.get('/api/accounts', (req, res) => {
    db.all('SELECT * FROM whatsapp_accounts', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const results = rows.map(row => {
            let settings = {};
            try { settings = JSON.parse(row.settings || '{}'); } catch (e) {}
            return {
                ...row,
                settings,
                currentStatus: activeSessions.get(row.phone)?.status || 'Offline',
                pairingCode: activeSessions.get(row.phone)?.pairingCode || '',
                qr: activeSessions.get(row.phone)?.qr || ''
            };
        });
        res.json(results);
    });
});

// API: Connect new account
app.post('/api/connect', async (req, res) => {
    const { name, phone, settings } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and Phone are required' });

    const sessionId = `session_${phone.replace(/\D/g, '')}`;
    const createdAt = Date.now();
    const expiryAt = createdAt + (30 * 24 * 60 * 60 * 1000); // 30 days
    const settingsJson = JSON.stringify(settings || {});

    db.run(`INSERT OR REPLACE INTO whatsapp_accounts (phone, name, session_id, created_at, expiry_at, status, settings) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`, [phone, name, sessionId, createdAt, expiryAt, 'Connecting', settingsJson], async (err) => {
        if (err) return res.status(500).json({ error: err.message });

        let session = activeSessions.get(phone);
        if (session) await session.stop();

        session = new BotSession({ phone, name, sessionId, expiryAt, settings: settings || {} });
        activeSessions.set(phone, session);
        
        // Start initialization in background
        session.initWithPairing().catch(e => console.error(`[${phone}] Session init failed:`, e));
        res.json({ message: 'Connection initiated', phone });
    });
});

// API: Delete account
app.post('/api/delete', async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone is required' });

    // Fetch session record first so we have sessionId for file cleanup
    db.get('SELECT * FROM whatsapp_accounts WHERE phone = ?', [phone], async (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        // Stop the active in-memory session (clears timers, logs out, closes browser)
        const session = activeSessions.get(phone);
        if (session) {
            await session.stop();
            activeSessions.delete(phone);
        }

        // Delete wppconnect token/session folder from disk
        if (row) {
            const tokenDir = path.join(__dirname, 'tokens', row.session_id);
            if (fs.existsSync(tokenDir)) {
                fs.rmSync(tokenDir, { recursive: true, force: true });
                console.log(`[${phone}] Deleted token folder: ${tokenDir}`);
            }

            // Delete all sidecar JSON files for this session
            const sidecars = [
                this.paths.defaulters,
                this.paths.settings,
                this.paths.schedules,
                this.paths.raidState
            ];
            sidecars.forEach(filePath => {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`[${phone}] Deleted sidecar: ${path.basename(filePath)}`);
                }
            });
        }

        // Remove from database
        db.run('DELETE FROM whatsapp_accounts WHERE phone = ?', [phone], (err2) => {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ message: 'Account fully deleted' });
        });
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

// Initialize existing accounts on startup
function initAllSessions() {
    db.all('SELECT * FROM whatsapp_accounts WHERE status != ?', ['Expired'], async (err, rows) => {
        if (err) return console.error('Init sessions error:', err);
        console.log(`Found ${rows.length} accounts to initialize...`);
        for (const row of rows) {
            try {
                let settings = {};
                try { settings = JSON.parse(row.settings || '{}'); } catch (e) {}
                const sessionId = row.session_id && row.session_id.trim()
                    ? row.session_id
                    : `session_${String(row.phone || '').replace(/\D/g, '')}`;

                const session = new BotSession({
                    phone: row.phone,
                    name: row.name,
                    sessionId,
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

// End of file
