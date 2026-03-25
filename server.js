const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.use(cors());

// Allow image uploads up to 10MB
app.use(express.json({ limit: '10mb' }));

// --- Binance API Settings ---
const BINANCE_API_KEY = "UhdBEOE49VlvFHR8sFWjWa55e1CFw3rc8SIZ0gn9c7fc2bPT5SHpbXucz9lFO7WK";
const BINANCE_SECRET_KEY = "Sf3dsh5HktbeX8nHCwF5LmyBdJfU2dM3p2wC0VSktukUDA12LlrCneAQuNRe4VDc";

// Function to verify Binance deposit
async function verifyBinanceDeposit(txId) {
    const timestamp = Date.now();
    const queryString = `coin=USDT&txId=${txId}&timestamp=${timestamp}`;
    const signature = crypto.createHmac('sha256', BINANCE_SECRET_KEY).update(queryString).digest('hex');

    try {
        const response = await axios.get(`https://api.binance.com/sapi/v1/capital/deposit/hisrec?${queryString}&signature=${signature}`, {
            headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }
        });
        
        const deposits = response.data;
        if (deposits && deposits.length > 0) {
            const deposit = deposits.find(d => d.txId === txId);
            if (deposit) {
                return {
                    found: true,
                    status: deposit.status, 
                    amount: parseFloat(deposit.amount), 
                    coin: deposit.coin
                };
            }
        }
        return { found: false };
    } catch (error) {
        console.error("Binance API Error:", error.message);
        throw new Error("Failed to connect to Binance servers.");
    }
}

// --- Cloud Database Setup (Supabase / PostgreSQL) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || "postgresql://postgres.ecmeqqipjyglfrvfivew:3vYRn4Q1MmyaGYCw@aws-1-eu-west-1.pooler.supabase.com:6543/postgres",
    ssl: { rejectUnauthorized: false }
});

// Auto-create tables in Supabase on startup
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                balance NUMERIC DEFAULT 0.0,
                role VARCHAR(50) DEFAULT 'user',
                cid_count INTEGER DEFAULT 0,
                check_count INTEGER DEFAULT 0
            );
        
            CREATE TABLE IF NOT EXISTS recharge_requests (
                id SERIAL PRIMARY KEY,
                "userId" INTEGER,
                username VARCHAR(255),
                amount NUMERIC,
                "trxId" VARCHAR(255) UNIQUE,
                status VARCHAR(50) DEFAULT 'pending', 
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS operation_history (
                id SERIAL PRIMARY KEY,
                "userId" INTEGER,
                tool VARCHAR(100),
                input_data TEXT,
                product_name VARCHAR(255),
                result_code VARCHAR(255),
                status VARCHAR(50),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS promo_codes (
                id SERIAL PRIMARY KEY,
                code VARCHAR(50) UNIQUE NOT NULL,
                amount NUMERIC NOT NULL,
                is_used BOOLEAN DEFAULT false,
                used_by INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                used_at TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS downloads (
                id SERIAL PRIMARY KEY,
                category VARCHAR(255) NOT NULL,
                product_name VARCHAR(255) NOT NULL,
                language VARCHAR(100) DEFAULT 'Global',
                url TEXT NOT NULL,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key VARCHAR(255) UNIQUE;`);
        console.log("✅ Database Tables Verified on Supabase");
    } catch (err) {
        console.error("❌ Database Initialization Error:", err.message);
    }
};await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(255) UNIQUE;`);
initDB();

const MY_TOKEN = "ed0002c02e888376f59dccb780e958e7";
const BASE_URL = "http://api.get-cid.com/api";
const CID_COST = 0.07;

// --- Helper function to log operations (History) ---
async function logOperation(userId, tool, input_data, product_name, result_code, status) {
    try {
        await pool.query(
            `INSERT INTO operation_history ("userId", tool, input_data, product_name, result_code, status) VALUES ($1, $2, $3, $4, $5, $6)`, 
            [userId, tool, input_data, product_name, result_code, status]
        );
    } catch (err) { console.error("History Log Error:", err.message); }
}

// --- User & Authentication Routes ---
app.post('/api/register', async (req, res) => {
    const { username, email, password } = req.body;
    try {
        await pool.query(`INSERT INTO users (username, email, password) VALUES ($1, $2, $3)`, [username, email, password]);
        res.json({ status: "success", msg: "Registration successful, please sign in." });
    } catch (err) {
        res.status(400).json({ status: "failed", msg: "Username or Email is already taken." });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT id, username, email, balance, role, cid_count, check_count FROM users WHERE (username = $1 OR email = $1) AND password = $2`, [username, password]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            user.balance = parseFloat(user.balance);
            res.json({ status: "success", user: user });
        } else {
            res.status(401).json({ status: "failed", msg: "Invalid login credentials." });
        }
    } catch (err) { res.status(500).json({ status: "failed", msg: "Database Error." }); }
});

app.get('/api/me', async (req, res) => {
    try {
        const result = await pool.query(`SELECT id, username, email, balance, role, cid_count, check_count FROM users WHERE id = $1`, [req.query.userId]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            user.balance = parseFloat(user.balance);
            res.json({ status: "success", user: user });
        } else {
            res.status(404).json({ status: "failed", msg: "User not found." });
        }
    } catch (err) { res.status(500).json({ status: "failed" }); }
});

// --- Email Sending Setup (Nodemailer) ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'thebeta2016@gmail.com', 
        pass: 'bzzd mrhr uawb zgav' 
    }
});

app.post('/api/forgot-password', async (req, res) => {
    const { email } = req.body;
    try {
        const result = await pool.query(`SELECT id, username FROM users WHERE email = $1`, [email]);
        if (result.rows.length > 0) {
            const user = result.rows[0];
            const resetLink = `http://localhost:3000/index.html?userId=${user.id}`;
            const mailOptions = {
                from: '"Microserial Support" <thebeta2016@gmail.com>',
                to: email,
                subject: 'Password Reset Request - Microserial',
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: auto; background-color: #f8fafc; border-radius: 10px;">
                        <div style="text-align: center; margin-bottom: 20px;">
                            <h2 style="color: #0f172a;">Hello ${user.username},</h2>
                        </div>
                        <div style="background-color: white; padding: 30px; border-radius: 8px; text-align: center; border: 1px solid #e2e8f0;">
                            <p style="color: #475569; font-size: 16px;">We received a request to reset your password for your Microserial account.</p>
                            <a href="${resetLink}" style="display: inline-block; padding: 12px 25px; background-color: #0066cc; color: white; text-decoration: none; border-radius: 5px; margin: 25px 0; font-weight: bold;">Reset Password Now</a>
                            <p style="color: #94a3b8; font-size: 12px;">If you didn't request a password reset, please ignore this email. Your account remains secure.</p>
                        </div>
                    </div>
                `
            };
            transporter.sendMail(mailOptions, (error, info) => {
                if (error) return res.status(500).json({ status: "failed", msg: "Error sending email. Please check server settings." });
                res.json({ status: "success", msg: "Password reset link sent to your email successfully! (Please check your inbox and spam folder)." });
            });
        } else {
            res.status(404).json({ status: "failed", msg: "This email is not registered in our system." });
        }
    } catch (err) { res.status(500).json({ status: "failed", msg: "Database error occurred." }); }
});

app.post('/api/reset-password', async (req, res) => {
    const { userId, newPassword } = req.body;
    try {
        await pool.query(`UPDATE users SET password = $1 WHERE id = $2`, [newPassword, userId]);
        res.json({ status: "success", msg: "Password changed successfully! You can now sign in." });
    } catch (err) { res.status(500).json({ status: "failed", msg: "Database error occurred." }); }
});

// --- Service Routes (OCR, CID, Check) ---
app.post('/api/ocr', async (req, res) => {
    const { mime_type, image_base64 } = req.body;
    if (!mime_type || !image_base64) return res.status(400).json({ status: "failed", msg: "Image data is missing." });
    try {
        const response = await axios.post(`${BASE_URL}/ocr`, { token: MY_TOKEN, mime_type, image_base64 }, { timeout: 30000 });
        res.json(response.data);
    } catch (e) {
        res.status(500).json({ status: "failed", msg: "Failed to connect to OCR server. Please try again later." });
    }
});

app.get('/api/get-cid', async (req, res) => {
    const { userId, iid } = req.query;
    try {
        const userRes = await pool.query(`SELECT balance, cid_count FROM users WHERE id = $1`, [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ status: "failed", msg: "User not found." });
        const user = userRes.rows[0];
        if (parseFloat(user.balance) < CID_COST) {
            logOperation(userId, 'Get CID', iid, 'CID Service', 'Insufficient Balance', 'Failed');
            return res.status(400).json({ status: "failed", errormsg: "Insufficient CID Balance." });
        }
        const response = await axios.get(`${BASE_URL}/getcid`, { params: { token: MY_TOKEN, iid } });
        if (response.data.cid) {
            const newBalance = parseFloat(user.balance) - CID_COST;
            const newCount = user.cid_count + 1;
            await pool.query(`UPDATE users SET balance = $1, cid_count = $2 WHERE id = $3`, [newBalance, newCount, userId]);
            logOperation(userId, 'Get CID', iid, 'CID Service', 'Generated', 'Success');
            return res.json({ ...response.data, newBalance, cid_count: newCount });
        }
        logOperation(userId, 'Get CID', iid, 'CID Service', response.data.errormsg || 'Error', 'Failed');
        res.json(response.data);
    } catch (e) { res.status(500).json({ status: "failed", errormsg: "Error connecting to service provider." }); }
});

app.get('/api/check-key', async (req, res) => {
    const { userId, key } = req.query;
    try {
        const response = await axios.get(`${BASE_URL}/checkkey`, { params: { token: MY_TOKEN, key } });
        if (userId && response.data.status !== "failed") {
            await pool.query(`UPDATE users SET check_count = check_count + 1 WHERE id = $1`, [userId]);
            logOperation(userId, 'Check Key', key, response.data.prd || 'Unknown Product', response.data.errorcode || 'Valid', 'Success');
        } else if (userId) {
            logOperation(userId, 'Check Key', key, response.data.prd || 'Unknown Product', response.data.errorcode || 'Blocked', 'Failed');
        }
        res.json(response.data);
    } catch (e) { res.status(500).json({ status: "failed", errormsg: "Error connecting to checking system." }); }
});

// --- History & Recharge Routes ---
app.get('/api/history', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM operation_history WHERE "userId" = $1 ORDER BY id DESC`, [req.query.userId]);
        res.json(result.rows);
    } catch (err) { res.status(500).json([]); }
});

// --- Promo Code Redeem Route (For Users) ---
app.post('/api/redeem-promo', async (req, res) => {
    const { userId, code } = req.body;
    try {
        // نستخدم UPDATE ... RETURNING لضمان عدم استخدام الكود مرتين في نفس اللحظة (حماية من الهاكرز)
        const promoRes = await pool.query(
            `UPDATE promo_codes SET is_used = true, used_by = $1, used_at = CURRENT_TIMESTAMP WHERE code = $2 AND is_used = false RETURNING amount`,
            [userId, code]
        );

        if (promoRes.rows.length === 0) {
            return res.status(400).json({ status: "failed", msg: "Invalid or already used promo code." });
        }

        const amount = parseFloat(promoRes.rows[0].amount);

        // إضافة الرصيد للعميل
        await pool.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [amount, userId]);
        
        // تسجيل العملية في السجل
        logOperation(userId, 'Redeem', code, 'Promo Code', `+$${amount}`, 'Success');

        res.json({ status: "success", msg: `Success! $${amount} has been added to your balance.` });
    } catch (err) {
        res.status(500).json({ status: "failed", msg: "Database error occurred." });
    }
});
app.post('/api/history/clear', async (req, res) => {
    try {
        await pool.query(`DELETE FROM operation_history WHERE "userId" = $1`, [req.body.userId]);
        res.json({ status: "success" });
    } catch (err) { res.status(500).json({ status: "failed" }); }
});

app.post('/api/submit-recharge', async (req, res) => {
    const { userId, username, trxId } = req.body;
    try {
        const existingTx = await pool.query(`SELECT id FROM recharge_requests WHERE "trxId" = $1`, [trxId]);
        if (existingTx.rows.length > 0) return res.status(400).json({ status: "failed", msg: "This Transaction ID has already been used!" });

        const depositInfo = await verifyBinanceDeposit(trxId);
        if (!depositInfo.found) return res.status(400).json({ status: "failed", msg: "Transaction not found. If you just sent it, please wait a couple of minutes and try again." });
        if (depositInfo.coin !== 'USDT') return res.status(400).json({ status: "failed", msg: "Sorry, this transaction is not in USDT." });
        if (depositInfo.status !== 1) return res.status(400).json({ status: "failed", msg: "The transaction is still confirming on the blockchain. Please try again shortly." });

        const actualAmount = depositInfo.amount;
        await pool.query(`INSERT INTO recharge_requests ("userId", username, amount, "trxId", status) VALUES ($1, $2, $3, $4, 'approved')`, [userId, username, actualAmount, trxId]);
        await pool.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [actualAmount, userId]);
        logOperation(userId, 'Redeem', trxId, 'Auto USDT Top-up', `+$${actualAmount}`, 'Success');
        res.json({ status: "success", msg: `Transaction confirmed successfully! $${actualAmount} has been added to your balance.` });
    } catch (err) {
        if (err.message.includes("Binance")) res.status(500).json({ status: "failed", msg: err.message });
        else res.status(500).json({ status: "failed", msg: "A database error occurred, please try again later." });
    }
});

// --- Dynamic Downloads API Routes ---
app.get('/api/downloads', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM downloads ORDER BY category, product_name`);
        res.json(result.rows);
    } catch (err) { res.status(500).json([]); }
});

app.post('/api/admin/downloads', async (req, res) => {
    const { category, product_name, language, url } = req.body;
    try {
        await pool.query(`INSERT INTO downloads (category, product_name, language, url) VALUES ($1, $2, $3, $4)`, [category, product_name, language || 'Global', url]);
        res.json({ status: "success" });
    } catch (err) { res.status(500).json({ status: "failed" }); }
});

app.post('/api/admin/downloads/delete', async (req, res) => {
    try {
        await pool.query(`DELETE FROM downloads WHERE id = $1`, [req.body.id]);
        res.json({ status: "success" });
    } catch (err) { res.status(500).json({ status: "failed" }); }
});

// --- Admin Panel Routes ---
app.get('/api/admin/requests', async (req, res) => { 
    try {
        const result = await pool.query(`SELECT * FROM recharge_requests WHERE status = 'pending' ORDER BY timestamp DESC`);
        res.json(result.rows);
    } catch(err) { res.json([]); }
});
// --- Generate Promo Codes (For Admin) ---
app.post('/api/admin/generate-promo', async (req, res) => {
    const { amount, count } = req.body;
    try {
        let codes = [];
        for(let i=0; i<count; i++) {
            // توليد كود عشوائي احترافي مثل: MS-A1B2-C3D4
            const code = 'MS-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
            await pool.query(`INSERT INTO promo_codes (code, amount) VALUES ($1, $2)`, [code, amount]);
            codes.push(code);
        }
        res.json({ status: "success", codes, msg: `Successfully generated ${count} codes.` });
    } catch (err) {
        res.status(500).json({ status: "failed", msg: "Database error." });
    }
});
// ============================================================================
// --- MICROSERIAL PUBLIC API (For Users' Bots & Websites) ---
// ============================================================================

// 1. مسار لتوليد أو جلب مفتاح الـ API الخاص بالعميل للوحة التحكم
app.get('/api/user/apikey', async (req, res) => {
    const { userId } = req.query;
    try {
        const result = await pool.query(`SELECT api_key FROM users WHERE id = $1`, [userId]);
        if (result.rows.length === 0) return res.status(404).json({ status: "failed", msg: "User not found." });
        
        let apiKey = result.rows[0].api_key;
        if (!apiKey) {
            // توليد مفتاح جديد إذا لم يكن لديه واحد
            apiKey = 'mk_' + crypto.randomBytes(16).toString('hex');
            await pool.query(`UPDATE users SET api_key = $1 WHERE id = $2`, [apiKey, userId]);
        }
        res.json({ status: "success", api_key: apiKey });
    } catch (e) { res.status(500).json({ status: "failed", msg: "Database Error." }); }
});

app.post('/api/user/apikey/regenerate', async (req, res) => {
    const { userId } = req.body;
    const newKey = 'mk_' + crypto.randomBytes(16).toString('hex');
    try {
        await pool.query(`UPDATE users SET api_key = $1 WHERE id = $2`, [newKey, userId]);
        res.json({ status: "success", api_key: newKey, msg: "API Key regenerated successfully." });
    } catch (e) { res.status(500).json({ status: "failed" }); }
});

// 2. مسارات الـ API العامة (التي سيستخدمها العملاء في تطبيقاتهم)
const authenticateAPI = async (req, res, next) => {
    const apikey = req.query.apikey || req.headers['x-api-key'];
    if (!apikey) return res.status(401).json({ error: "API Key is missing." });
    
    try {
        const result = await pool.query(`SELECT id, username, balance FROM users WHERE api_key = $1`, [apikey]);
        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid API Key." });
        
        req.apiUser = result.rows[0]; // تمرير بيانات العميل للمسار التالي
        next();
    } catch (e) { res.status(500).json({ error: "Internal Server Error." }); }
};

// مسار جلب الرصيد عبر الـ API
app.get('/api/v1/balance', authenticateAPI, (req, res) => {
    res.json({
        success: true,
        username: req.apiUser.username,
        balance: parseFloat(req.apiUser.balance),
        currency: "USDT"
    });
});

// مسار استخراج الـ CID عبر الـ API
app.get('/api/v1/get-cid', authenticateAPI, async (req, res) => {
    const { iid } = req.query;
    const user = req.apiUser;

    if (!iid) return res.status(400).json({ error: "Missing 'iid' parameter." });
    if (parseFloat(user.balance) < CID_COST) {
        logOperation(user.id, 'API - Get CID', iid, 'CID Service', 'Insufficient Balance', 'Failed');
        return res.status(402).json({ error: "Insufficient Balance." });
    }

    try {
        const response = await axios.get(`${BASE_URL}/getcid`, { params: { token: MY_TOKEN, iid } });
        
        if (response.data.cid) {
            const newBalance = parseFloat(user.balance) - CID_COST;
            await pool.query(`UPDATE users SET balance = $1, cid_count = cid_count + 1 WHERE id = $2`, [newBalance, user.id]);
            logOperation(user.id, 'API - Get CID', iid, 'CID Service', 'Generated', 'Success');
            
            return res.json({
                success: true,
                iid: iid,
                cid: response.data.cid,
                cost: CID_COST,
                remaining_balance: newBalance
            });
        }
        
        logOperation(user.id, 'API - Get CID', iid, 'CID Service', response.data.errormsg || 'Error', 'Failed');
        res.status(400).json({ success: false, error: response.data.errormsg || "Failed to generate CID." });

    } catch (e) { res.status(500).json({ error: "Provider Connection Error." }); }
});
app.get('/api/v1/check-key', authenticateAPI, async (req, res) => {
    const { key } = req.query;
    const user = req.apiUser; // بيانات العميل القادمة من الـ API Key

    if (!key) return res.status(400).json({ error: "Missing 'key' parameter." });

    try {
        const response = await axios.get(`${BASE_URL}/checkkey`, { params: { token: MY_TOKEN, key } });
        
        if (response.data.status !== "failed") {
            await pool.query(`UPDATE users SET check_count = check_count + 1 WHERE id = $1`, [user.id]);
            logOperation(user.id, 'API - Check Key', key, response.data.prd || 'Unknown Product', response.data.errorcode || 'Valid', 'Success');
            
            return res.json({
                success: true,
                key: key,
                product: response.data.prd || 'Unknown',
                error_code: response.data.errorcode || 'N/A',
                details: response.data
            });
        }
        
        logOperation(user.id, 'API - Check Key', key, response.data.prd || 'Unknown Product', response.data.errorcode || 'Blocked', 'Failed');
        res.status(400).json({ success: false, error: "Key check failed or blocked.", details: response.data });

    } catch (e) { res.status(500).json({ error: "Provider Connection Error." }); }
});

// ============================================================================
app.post('/api/admin/approve', async (req, res) => {
    const { requestId, userId, amount } = req.body;
    try {
        await pool.query(`UPDATE recharge_requests SET status = 'approved' WHERE id = $1`, [requestId]);
        await pool.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [amount, userId]);
        logOperation(userId, 'Redeem', `Admin Approval`, 'Wallet Top-up', `+$${amount}`, 'Success');
        res.json({ status: "success" });
    } catch(err) { res.status(500).json({ status: "failed" }); }
});

app.post('/api/admin/reject', async (req, res) => { 
    try {
        await pool.query(`UPDATE recharge_requests SET status = 'rejected' WHERE id = $1`, [req.body.requestId]);
        res.json({ status: "success" });
    } catch(err) { res.status(500).json({ status: "failed" }); }
});

app.get('/api/admin/users', async (req, res) => { 
    try {
        const result = await pool.query(`SELECT id, username, email, balance, role, cid_count, check_count FROM users ORDER BY id DESC`);
        const users = result.rows.map(u => ({ ...u, balance: parseFloat(u.balance) }));
        res.json(users);
    } catch(err) { res.json([]); }
});

app.post('/api/admin/add-balance', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        await pool.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [amount, userId]);
        logOperation(userId, 'Redeem', `Admin Added`, 'Wallet Top-up', `+$${amount}`, 'Success');
        res.json({ status: "success", msg: `Successfully added $${amount}` });
    } catch(err) { res.status(500).json({ status: "failed" }); }
});
// =========================================================
// --- مسارات ربط بوت تليجرام (Telegram Auth) ---
// =========================================================
app.post('/api/telegram/link', async (req, res) => {
    const { chatId, apiKey } = req.body;
    try {
        const result = await pool.query(`SELECT id, username FROM users WHERE api_key = $1`, [apiKey]);
        if (result.rows.length === 0) return res.status(400).json({ status: "failed", msg: "Invalid API Key." });
        
        // ربط حساب تليجرام بهذا العميل
        await pool.query(`UPDATE users SET telegram_chat_id = $1 WHERE id = $2`, [chatId.toString(), result.rows[0].id]);
        res.json({ status: "success", username: result.rows[0].username, msg: "Account linked successfully!" });
    } catch (err) { res.status(500).json({ status: "failed", msg: "Database error." }); }
});

app.get('/api/telegram/user', async (req, res) => {
    const { chatId } = req.query;
    try {
        const result = await pool.query(`SELECT id, api_key FROM users WHERE telegram_chat_id = $1`, [chatId.toString()]);
        if (result.rows.length === 0) return res.status(404).json({ status: "failed", msg: "Not linked" });
        res.json({ status: "success", userId: result.rows[0].id, apiKey: result.rows[0].api_key });
    } catch (err) { res.status(500).json({ status: "failed" }); }
});
module.exports = app;