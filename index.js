require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');

const cfg = {
    token: (process.env.DISCORD_TOKEN || '').trim(),
    logChannelId: (process.env.LOG_CHANNEL_ID || '').trim(),
};

if (!cfg.token || !cfg.logChannelId) {
    console.error('Missing DISCORD_TOKEN or LOG_CHANNEL_ID in .env file. Fill them in and restart.');
    process.exit(1);
}

const parts = cfg.token.split('.');
if (parts.length !== 3 || cfg.token.length < 60) {
    console.error(`Token malformed: ${parts.length} segments, ${cfg.token.length} chars`);
    process.exit(1);
}
console.log(`Token loaded: length=${cfg.token.length}, prefix=${cfg.token.slice(0, 8)}...`);

// ========== TELEGRAM ALERT SYSTEM ==========
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn('Telegram not configured, skipping alert.');
        return;
    }
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML' // Allows bold/italic formatting
            })
        });

        if (!response.ok) {
            console.error('Telegram alert failed:', response.status);
        } else {
            console.log('✅ Telegram alert sent');
        }
    } catch (err) {
        console.error('Failed to send Telegram alert:', err.message);
    }
}

// ========== CRASH & SHUTDOWN HANDLERS ==========
const AUTH_COOLDOWN_MS = 3 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let isShuttingDown = false;

async function handleShutdown(reason, details = '') {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error(`[Shutdown] ${reason}: ${details}`);
    await sendTelegramAlert(`🛑 <b>BOT STOPPED!</b>\n\n<b>Reason:</b> ${reason}\n${details ? `<code>${details}</code>` : ''}`);
    process.exit(1);
}

async function fatalAuth(reason, details = '') {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.error(`[Fatal auth] ${reason}: ${details}`);
    await sendTelegramAlert(
        `🚨 <b>TOKEN DEAD — cooling down 3 min</b>\n${reason}\n<code>${details}</code>`
    );
    await sleep(AUTH_COOLDOWN_MS);
    process.exit(1);
}

// Handle termination signals from host/Discloud/PM2
process.on('SIGTERM', async () => {
    await handleShutdown('Host Server Stopped (SIGTERM)');
});

process.on('SIGINT', async () => {
    await handleShutdown('Host Server Interrupted (SIGINT)');
});

// Handle uncaught exceptions (crashes)
process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught Exception:', error);
    await sendTelegramAlert(`❌ <b>BOT CRASHED!</b>\n\n<code>${error.message}</code>\n\nStack trace:\n<code>${error.stack}</code>`);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', async (error) => {
    console.error('⚠️ Unhandled Rejection:', error);
    const msg = error?.message || `${error}`;
    if (msg.includes('invalid token') || msg.includes('TOKEN_INVALID')) {
        await fatalAuth('Invalid Discord Token', msg);
    } else {
        await sendTelegramAlert(`⚠️ <b>UNHANDLED REJECTION!</b>\n\n<code>${msg}</code>`);
    }
});
// ================================================

const client = new Client({
    checkUpdate: false,
    autoRedeemNitro: false,
    ws: {
        properties: {
            $os: 'Windows',
            $browser: 'Discord Client',
            $device: 'desktop'
        }
    }
});

const fmt = (unixSecs) => `<t:${unixSecs}:F> (<t:${unixSecs}:R>)`;

function displayTag(user) {
    if (user.tag) return user.tag;
    if (user.discriminator && user.discriminator !== '0') {
        return `${user.username}#${user.discriminator}`;
    }
    return user.username || `${user.id}`;
}

async function enrichUser(user) {
    let flagsArr = [];
    let bannerUrl = null;

    try {
        const flags = (typeof user.fetchFlags === 'function')
            ? await user.fetchFlags()
            : user.flags;
        if (flags && typeof flags.toArray === 'function') {
            flagsArr = flags.toArray();
        }
    } catch { }

    try {
        const fetched = (typeof user.fetch === 'function') ? await user.fetch(true) : null;
        if (fetched && typeof fetched.bannerURL === 'function') {
            bannerUrl = fetched.bannerURL({ size: 1024 }) || null;
        } else if (typeof user.bannerURL === 'function') {
            bannerUrl = user.bannerURL({ size: 1024 }) || null;
        }
    } catch { }

    return { flagsArr, bannerUrl };
}

client.once('ready', async () => {
    console.log(`[Ready] Logged in as ${client.user.tag || client.user.username}`);

    // Verify only the target log channel exists
    let logChannelName = 'Unknown';
    try {
        const logChannel = client.channels.cache.get(cfg.logChannelId) ||
                           await client.channels.fetch(cfg.logChannelId).catch(() => null);
        if (logChannel) {
            logChannelName = `#${logChannel.name}`;
            console.log(`[Ready] Target log channel: #${logChannel.name} (${logChannel.guild?.name || 'Direct'})`);
        } else {
            console.warn(`[Warning] Could not find LOG_CHANNEL_ID: ${cfg.logChannelId}`);
        }
    } catch (err) {
        console.warn(`[Warning] Channel check failed: ${err.message}`);
    }

    // Send success alert to Telegram
    await sendTelegramAlert(
        `✅ <b>Bot Online & Stealth Active</b>\n\n` +
        `User: <code>${client.user.tag || client.user.username}</code>\n` +
        `Monitoring: <code>${client.guilds.cache.size}</code> servers\n` +
        `Log Channel: <code>${logChannelName}</code>`
    );
});

// ========== DISCORD CONNECTION & TOKEN MONITORS ==========
// Triggered if the Discord token is reset, revoked, or account password changed
client.on('invalidated', async () => {
    console.error(`❌ Session invalidated! WebSocket status: ${client.ws.status}`);
    await fatalAuth('Session invalidated', `Gateway status: ${client.ws.status}`);
});

// Triggered when Discord WebSocket drops
client.on('shardDisconnect', async (event, shardId) => {
    console.warn(`⚠️ Discord WebSocket disconnected (Shard ${shardId}). Code: ${event.code}`);
    await sendTelegramAlert(
        `⚠️ <b>Discord Disconnected!</b>\nShard: <code>${shardId}</code>\nCode: <code>${event.code}</code>\nReason: <code>${event.reason || 'Network drop'}</code>\nAttempting reconnection...`
    );
});

// Triggered when Discord WebSocket successfully reconnects
client.on('shardResume', async (shardId) => {
    console.log(`✅ Discord WebSocket resumed (Shard ${shardId})`);
    await sendTelegramAlert(`✅ <b>Discord Reconnected!</b>\nGateway session resumed successfully.`);
});

// Triggered on WebSocket network error
client.on('shardError', async (error, shardId) => {
    console.error(`❌ Discord Shard Error (${shardId}):`, error);
    await sendTelegramAlert(`⚠️ <b>Discord Gateway Error:</b>\n<code>${error.message}</code>`);
});
// ========================================================

client.on('guildCreate', async (guild) => {
    console.log(`[Guild] Joined new guild: ${guild.name} [${guild.id}]`);
    await sendTelegramAlert(`📥 <b>Joined New Server</b>\n\nName: ${guild.name}\nID: <code>${guild.id}</code>`);
});

client.on('guildMemberAdd', async (member) => {
    try {
        const guild = member.guild;

        if (!member.user && !guild.members.cache.has(member.id)) {
            await guild.members.fetch(member.id).catch(() => null);
        }

        const channel =
            client.channels.cache.get(cfg.logChannelId) ||
            (await client.channels.fetch(cfg.logChannelId).catch(() => null));
        if (!channel) return;

        const user = member.user;

        const dateObj = member.joinedTimestamp ? new Date(member.joinedTimestamp) : new Date();
        const formattedDate = dateObj.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'Africa/Lagos'
        });

        const formattedTime = dateObj.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
            timeZone: 'Africa/Lagos'
        });

        const createdDateObj = new Date(user.createdTimestamp || Date.now());
        const formattedCreatedDate = createdDateObj.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'Africa/Lagos'
        });

        const lines = [
            `🎉 New Member Joined!`,
            ``,
            `📆 Date: ${formattedDate}`,
            `🕐 Time: ${formattedTime}`,
            `👤 Username: \`${displayTag(user)}\``,
            `🆔 User ID: ${user.id}`,
            `🎂 Account Created: ${formattedCreatedDate}`,
            `🏠 Server: ${guild.name}`
        ];

        await channel.send(lines.join('\n'));

    } catch (err) {
        console.error('Failed to log member join:', err?.message || err);
    }
});

client.login(cfg.token).catch((err) => {
    fatalAuth('Login failed', err.message);
});