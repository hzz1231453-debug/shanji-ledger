const path = require('path');
const express = require('express');
const cors = require('cors');
const fs = require('fs');

const app = express();
/** 老字号：固定只监听 5000，不使用 process.env.PORT（避免出现 8080） */
const PORT = 5000;
const HOST = '0.0.0.0';

const RESEND_FROM = 'onboarding@resend.dev';
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || '').trim();
/** 營運通知信收件（選填）；驗證碼主要寄往使用者輸入的郵箱 */
const MAIL_TO = process.env.MAIL_TO || '';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use(express.static(__dirname));

const DB_PATH = path.resolve(process.cwd(), 'ledger-db.json');
const QUOTA_DB_PATH = path.resolve(process.cwd(), 'ledger-quota.json');

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

async function sendViaResend({ to, subject, text }) {
  const toList = Array.isArray(to) ? [...new Set(to.map((e) => String(e).trim()).filter(Boolean))] : [String(to).trim()];
  if (!toList.length) {
    const full = { type: 'NO_RECIPIENTS', resendResponse: { message: 'No recipients' } };
    console.error('[RESEND_ERROR_FULL]', JSON.stringify(full, null, 2));
    throw Object.assign(new Error('NO_RECIPIENTS'), { resendFull: full });
  }

  let res;
  let rawText;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: toList,
        subject,
        text,
      }),
    });
    rawText = await res.text();
  } catch (netErr) {
    const full = {
      type: 'FETCH_FAILED',
      message: netErr && netErr.message ? netErr.message : String(netErr),
      name: netErr && netErr.name,
    };
    console.error('[RESEND_ERROR_FULL]', JSON.stringify(full, null, 2));
    throw Object.assign(netErr, { resendFull: full });
  }
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    parsed = { raw: rawText };
  }

  if (!res.ok) {
    const full = {
      httpStatus: res.status,
      httpStatusText: res.statusText,
      resendResponse: parsed,
    };
    console.error('[RESEND_ERROR_FULL]', JSON.stringify(full, null, 2));
    const err = new Error('RESEND_API_FAILED');
    err.resendFull = full;
    throw err;
  }

  return parsed;
}

const resendReady = Boolean(RESEND_API_KEY);
console.log(
  '[RESEND] RESEND_API_KEY 已讀取: ' +
    (resendReady ? '是 | ' : '否 | ') +
    (resendReady ? 'length=' + RESEND_API_KEY.length + ' | ' : '') +
    'from=' +
    RESEND_FROM,
);
if (!resendReady) {
  console.warn('[RESEND] 未設定有效 RESEND_API_KEY，/api/verify/send 與 /api/notify 將回 500');
}

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
  if (!resendReady) {
    return res.status(500).json({ ok: false, error: 'MAIL_NOT_CONFIGURED' });
  }
  const subject = req.body?.subject || 'Flash Ledger payment notice';
  const text =
    req.body?.text ||
    'A new Flash Ledger payment or quota event occurred. Please check your dashboard.';
  const to = req.body?.to || MAIL_TO;
  if (!to) {
    return res.status(400).json({ ok: false, error: 'MISSING_RECIPIENT', hint: 'Set MAIL_TO or pass body.to' });
  }
  try {
    await sendViaResend({ to, subject, text });
    res.json({ ok: true });
  } catch (err) {
    if (err.resendFull) {
      console.error('[MAIL_ERROR]', JSON.stringify(err.resendFull, null, 2));
    } else {
      console.error('[MAIL_ERROR]', err);
    }
    res.status(500).json({ ok: false, error: 'MAIL_SEND_FAILED' });
  }
});

app.post('/api/verify/send', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const lang = String(req.body?.lang || 'zh').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'INVALID_EMAIL' });
  }
  if (!resendReady) {
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
    await sendViaResend({ to: recipients, subject: t.subject, text: t.text });
    return res.json({ ok: true });
  } catch (err) {
    const full = err.resendFull;
    if (full) {
      console.error('[VERIFY_SEND_ERROR]', JSON.stringify(full, null, 2));
    } else {
      console.error('[VERIFY_SEND_ERROR]', err);
    }
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

app.get('/health', (req, res) =>
  res.json({ status: 'OK', service: 'shanji-ledger', listenPort: PORT }),
);

app.get('(.*)', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`[闪记] 启动成功，老字号固定监听端口: ${PORT} (HOST=${HOST})`);
});
