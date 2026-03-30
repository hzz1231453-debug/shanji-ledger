import { fileURLToPath } from 'url';
import path from 'path';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } 
  catch { return []; }
};
const writeDb = (data) => fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

const readQuota = () => {
  try { return JSON.parse(fs.readFileSync(QUOTA_DB_PATH, 'utf-8')); } 
  catch { return {}; }
};
const writeQuota = (data) => fs.writeFileSync(QUOTA_DB_PATH, JSON.stringify(data, null, 2));

// --- 核心 API 接口 (保留配额与记录功能) ---
app.get('/api/records', (req, res) => res.json(readDb()));

app.post('/api/records', (req, res) => {
  const rows = readDb();
  const next = { ...req.body, internalId: req.body.internalId || Date.now().toString() };
  const merged = [next, ...rows.filter(r => r.internalId !== next.internalId)];
  writeDb(merged);
  res.status(201).json({ ok: true, record: next });
});

app.get('/api/user/quota', (req, res) => {
  const db = readQuota();
  const userId = req.query.userId || 'default_user';
  const q = db[userId] || { used: 0, total: 10 };
  res.json({ ok: true, used: q.used, total: q.total, remaining: Math.max(0, q.total - q.used) });
});

app.get('/health', (req, res) => res.json({ status: 'OK', service: 'shanji-ledger' }));

// --- 核心：网页路由兜底，解决白屏 ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`[闪记] 启动成功，监听端口: ${PORT}`);
});
