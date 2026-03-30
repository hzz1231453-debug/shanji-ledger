import express from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
const PORT = 5000;
const HOST = '0.0.0.0';
const DB_PATH = path.resolve(process.cwd(), 'ledger-db.json');
const QUOTA_DB_PATH = path.resolve(process.cwd(), 'ledger-quota.json');
const DAILY_QUOTA_TOTAL = 10;

/** Pro 分類日限（階梯限流） */
const PRO_LIMIT_PHOTO = 20;
const PRO_LIMIT_VOICE = 50;
const PRO_LIMIT_MANUAL = 100;

/**
 * 強制走 Pro 分類限流（20/50/100）的測試用戶 ID（normalize 後比對）。
 * 可改成你的測試 ID；多個請用陣列展開進 Set。
 */
/** Pro 階梯限流白名單（逗號分隔 userId）；未設定時沿用開發預設 */
const PRO_QUOTA_UID_ALLOWLIST = new Set(
  String(process.env.LEDGER_PRO_QUOTA_UIDS ?? 'test_user')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const readDb = () => {
  try {
    if (!fs.existsSync(DB_PATH)) return [];
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeDb = (rows) => {
  fs.writeFileSync(DB_PATH, JSON.stringify(rows, null, 2), 'utf-8');
};

/** 伺服器本地日曆日 YYYY-MM-DD（每日 0 點以伺服器時區換日） */
const todayLocalIso = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const readQuotaDb = () => {
  try {
    if (!fs.existsSync(QUOTA_DB_PATH)) return {};
    const raw = fs.readFileSync(QUOTA_DB_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
};

const writeQuotaDb = (rows) => {
  fs.writeFileSync(QUOTA_DB_PATH, JSON.stringify(rows, null, 2), 'utf-8');
};

const normalizeUserKey = (raw) => {
  const cleaned = String(raw || 'default_user').trim();
  return cleaned ? cleaned.slice(0, 64) : 'default_user';
};

const buildProUsagePayload = (rec) => {
  const pc = Math.max(0, Number(rec.photo_count || 0));
  const vc = Math.max(0, Number(rec.voice_count || 0));
  const mc = Math.max(0, Number(rec.manual_count || 0));
  return {
    photo_count: pc,
    voice_count: vc,
    manual_count: mc,
    photo_remaining: Math.max(0, PRO_LIMIT_PHOTO - pc),
    voice_remaining: Math.max(0, PRO_LIMIT_VOICE - vc),
    manual_remaining: Math.max(0, PRO_LIMIT_MANUAL - mc),
  };
};

/**
 * 單一用戶配額行：基礎版 used/total + Pro 分類計數；跨伺服器本地日曆日時一併重置。
 */
const ensureQuotaRecord = (db, userKey) => {
  const today = todayLocalIso();
  let rec = db[userKey];
  if (!rec || rec.date !== today) {
    rec = {
      date: today,
      used: 0,
      total: DAILY_QUOTA_TOTAL,
      photo_count: 0,
      voice_count: 0,
      manual_count: 0,
    };
    db[userKey] = rec;
    return rec;
  }
  rec.used = Math.max(0, Math.min(Number(rec.used || 0), DAILY_QUOTA_TOTAL));
  rec.total = DAILY_QUOTA_TOTAL;
  rec.photo_count = Math.max(0, Number(rec.photo_count || 0));
  rec.voice_count = Math.max(0, Number(rec.voice_count || 0));
  rec.manual_count = Math.max(0, Number(rec.manual_count || 0));
  db[userKey] = rec;
  return rec;
};

const normalizeRecord = (r) => {
  const now = Date.now();
  const amount = Math.round(Math.abs(Number(r?.amount ?? 0)));
  return {
    internalId: String(r?.internalId || `${now}-${Math.random().toString(16).slice(2)}`),
    id: Number(r?.id ?? now),
    date: String(r?.date ?? new Date().toISOString().slice(0, 10)),
    storeKey: String(r?.storeKey ?? r?.storeId ?? 'main_store'),
    storeId: String(r?.storeId ?? r?.storeKey ?? 'main_store'),
    storeName: String(r?.storeName ?? 'Main'),
    type: r?.type === 'income' ? 'income' : 'expense',
    amount,
    createdAt: Number(r?.createdAt ?? now),
    note: String(r?.note ?? ''),
    categoryLabel: String(r?.categoryLabel ?? ''),
    thumbUrl: r?.thumbUrl ?? null,
    source:
      r?.source === 'camera' || r?.source === 'voice' || r?.source === 'manual'
        ? r.source
        : 'manual',
  };
};

app.get('/api/records', (_req, res) => {
  const rows = readDb();
  res.json(rows);
});

app.post('/api/records', (req, res) => {
  const next = normalizeRecord(req.body || {});
  const rows = readDb();
  const deduped = rows.filter((r) => r.internalId !== next.internalId);
  const merged = [next, ...deduped];
  writeDb(merged);
  console.log(`[POST] saved ${next.type} ${next.amount} (${next.internalId})`);
  res.status(201).json({ ok: true, record: next, total: merged.length });
});

app.post('/api/records/bulk', (req, res) => {
  const list = Array.isArray(req.body?.records) ? req.body.records : [];
  const incoming = list.map(normalizeRecord);
  const rows = readDb();
  const map = new Map(rows.map((r) => [r.internalId, r]));
  for (const r of incoming) map.set(r.internalId, r);
  const merged = Array.from(map.values()).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  writeDb(merged);
  console.log(`[BULK] merged ${incoming.length}, total ${merged.length}`);
  res.json({ ok: true, merged: incoming.length, total: merged.length });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ledger-api', port: PORT });
});

app.get('/api/user/quota', (req, res) => {
  const userKey = normalizeUserKey(req.query.userId ?? req.query.user_id);
  const db = readQuotaDb();
  const quota = ensureQuotaRecord(db, userKey);
  writeQuotaDb(db);
  const remaining = Math.max(0, quota.total - quota.used);
  res.json({
    ok: true,
    userId: userKey,
    date: quota.date,
    total: quota.total,
    used: quota.used,
    remaining,
    remaining_quota: remaining,
    pro_usage: buildProUsagePayload(quota),
  });
});

app.get('/api/quota/:userId', (req, res) => {
  const userKey = normalizeUserKey(req.params.userId);
  const db = readQuotaDb();
  const quota = ensureQuotaRecord(db, userKey);
  writeQuotaDb(db);
  const remaining = Math.max(0, quota.total - quota.used);
  res.json({
    ok: true,
    userId: userKey,
    date: quota.date,
    total: quota.total,
    used: quota.used,
    remaining,
    remaining_quota: remaining,
    pro_usage: buildProUsagePayload(quota),
  });
});

app.post('/api/quota/:userId/consume', (req, res) => {
  const userKey = normalizeUserKey(req.params.userId);
  const amount = Math.max(1, Math.min(50, Number(req.body?.amount ?? 1)));
  const tierRaw = String(req.body?.tier || 'basic').toLowerCase();
  const tierRequested = tierRaw === 'pro' ? 'pro' : 'basic';
  const tier = PRO_QUOTA_UID_ALLOWLIST.has(userKey) ? 'pro' : tierRequested;

  let category = String(req.body?.category || 'manual').toLowerCase();
  if (category === 'camera') category = 'photo';
  if (category !== 'photo' && category !== 'voice' && category !== 'manual') category = 'manual';

  const db = readQuotaDb();
  const quota = ensureQuotaRecord(db, userKey);

  if (tier === 'basic') {
    if (quota.used + amount > quota.total) {
      writeQuotaDb(db);
      const rem409 = Math.max(0, quota.total - quota.used);
      return res.status(409).json({
        ok: false,
        code: 'QUOTA_EXCEEDED',
        userId: userKey,
        date: quota.date,
        total: quota.total,
        used: quota.used,
        remaining: rem409,
        remaining_quota: rem409,
        pro_usage: buildProUsagePayload(quota),
      });
    }
    quota.used += amount;
    db[userKey] = quota;
    writeQuotaDb(db);
    const remOk = Math.max(0, quota.total - quota.used);
    return res.json({
      ok: true,
      code: 'OK',
      tier: 'basic',
      userId: userKey,
      date: quota.date,
      total: quota.total,
      used: quota.used,
      remaining: remOk,
      remaining_quota: remOk,
      pro_usage: buildProUsagePayload(quota),
    });
  }

  const limits = { photo: PRO_LIMIT_PHOTO, voice: PRO_LIMIT_VOICE, manual: PRO_LIMIT_MANUAL };
  const field =
    category === 'photo' ? 'photo_count' : category === 'voice' ? 'voice_count' : 'manual_count';
  const lim = limits[category];
  const cur = Math.max(0, Number(quota[field] || 0));

  if (cur + amount > lim) {
    writeQuotaDb(db);
    const code =
      category === 'photo'
        ? 'PRO_PHOTO_LIMIT'
        : category === 'voice'
          ? 'PRO_VOICE_LIMIT'
          : 'PRO_MANUAL_LIMIT';
    return res.status(403).json({
      ok: false,
      code,
      tier: 'pro',
      userId: userKey,
      date: quota.date,
      category,
      [field]: cur,
      limit: lim,
      pro_usage: buildProUsagePayload(quota),
    });
  }

  quota[field] = cur + amount;
  db[userKey] = quota;
  writeQuotaDb(db);

  return res.json({
    ok: true,
    code: 'OK',
    tier: 'pro',
    userId: userKey,
    date: quota.date,
    category,
    pro_usage: buildProUsagePayload(quota),
  });
});

app.listen(PORT, HOST, () => {
  console.log(
    `[ledger-api] http://${HOST}:${PORT} (quota day = server local ${todayLocalIso()}; pro allowlist: ${PRO_QUOTA_UID_ALLOWLIST.size} uid(s))`,
  );
});
