const path = require('path');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0';

// 基础配置
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- 核心：静态资源指向根目录，支持成品平铺 ---
app.use(express.static(__dirname));

const DB_PATH = path.resolve(process.cwd(), 'ledger-db.json');
const QUOTA_DB_PATH = path.resolve(process.cwd(), 'ledger-quota.json');

// --- 数据库存取逻辑 ---
const readDb = () => {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch {
    return [];
  }
};
const writeDb = (data) => fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

const readQuota = () => {
  try {
    return JSON.parse(fs.readFileSync(QUOTA_DB_PATH, 'utf-8'));
  } catch {
    return {};
  }
};
const writeQuota = (data) => fs.writeFileSync(QUOTA_DB_PATH, JSON.stringify(data, null, 2));
const OTP_TTL_MS = 5 * 60 * 1000;
const otpStore = new Map();

// --- 郵件發送（Gmail App Password，走環境變數） ---
const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_PASS || '';
const MAIL_TO = process.env.MAIL_TO || MAIL_USER;

let mailer = null;
if (MAIL_USER && MAIL_PASS) {
  mailer = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: MAIL_USER,
      pass: MAIL_PASS,
    },
  });
}

// --- 核心 API ---
app.get('/api/test', (req, res) => res.json({ ok: true, service: 'shanji-ledger' }));

app.get('/api/records', (req, res) => res.json(readDb()));

app.post('/api/records', (req, res) => {
  const rows = readDb();
  const next = { ...req.body, internalId: req.body.internalId || Date.now().toString() };
  const merged = [next, ...rows.filter((r) => r.internalId !== next.internalId)];
  writeDb(merged);
  res.status(201).json({ ok: true, record: next });
});

app.get('/api/user/quota', (req, res) => {
  const db = readQuota();
  const userId = req.query.userId || 'default_user';
  const q = db[userId] || { used: 0, total: 10 };
  res.json({ ok: true, used: q.used, total: q.total, remaining: Math.max(0, q.total - q.used) });
});

app.post('/api/notify', async (req, res) => {
  if (!mailer) {
    return res.status(500).json({ ok: false, error: 'MAIL_NOT_CONFIGURED' });
  }
  const subject = req.body?.subject || 'Flash Ledger payment notice';
  const text =
    req.body?.text ||
    'A new Flash Ledger payment or quota event occurred. Please check your dashboard.';
  try {
    await mailer.sendMail({
      from: MAIL_USER,
      to: MAIL_TO || MAIL_USER,
      subject,
      text,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[MAIL_ERROR]', err);
    res.status(500).json({ ok: false, error: 'MAIL_SEND_FAILED' });
  }
});

app.post('/api/verify/send', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const lang = String(req.body?.lang || 'zh').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
  }
  if (!mailer) {
    return res.status(500).json({ ok: false, error: 'MAIL_NOT_CONFIGURED' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  otpStore.set(email, { code, expireAt: Date.now() + OTP_TTL_MS });
  const templates = {
    zh: {
      subject: '闪记验证码',
      text: `您的验证码是：${code}。5 分钟内有效。`,
    },
    ko: {
      subject: '번개장부 인증 코드',
      text: `인증 코드는 ${code} 입니다. 5분 내에 입력해 주세요.`,
    },
    jp: {
      subject: '閃記 認証コード',
      text: `認証コードは ${code} です。5分以内に入力してください。`,
    },
    en: {
      subject: 'Flash Ledger Verification Code',
      text: `Your verification code is ${code}. It expires in 5 minutes.`,
    },
  };
  const t = templates[lang] || templates.zh;
  const recipients = Array.from(new Set([email, MAIL_TO].filter(Boolean)));
  try {
    await mailer.sendMail({
      from: MAIL_USER,
      to: recipients.join(','),
      subject: t.subject,
      text: t.text,
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[VERIFY_SEND_ERROR]', err);
    return res.status(500).json({ ok: false, error: 'MAIL_SEND_FAILED' });
  }
});

app.post('/api/verify/check', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const entry = otpStore.get(email);
  if (!entry) return res.status(400).json({ ok: false, error: 'CODE_NOT_FOUND' });
  if (Date.now() > entry.expireAt) {
    otpStore.delete(email);
    return res.status(400).json({ ok: false, error: 'CODE_EXPIRED' });
  }
  if (entry.code !== code) return res.status(400).json({ ok: false, error: 'CODE_INVALID' });
  otpStore.delete(email);
  return res.json({ ok: true, verified: true });
});

app.get('/health', (req, res) => res.json({ status: 'OK', service: 'shanji-ledger' }));

// --- 网页兜底：用 '(.*)'，避免原始 PathError，又確保 SPA 任意路徑回 index.html ---
app.get('(.*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`[闪记] 启动成功，监听端口: ${PORT}`);
});
