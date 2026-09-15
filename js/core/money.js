// money.js — 两级货币（对齐原版「两 / 文」1000:1 口径）
// ── 背景：op102/op688 抓包的 price 字段单位是「文」（由 desc【价格】实证：price=5000 ↔ "5两银"，price=10 ↔ "10文银"）。
//    玩家 silver/gold 字段单位是「两」（op20 真值 silver=43）。直接相减会让 10文银 的物品四舍五入成 0 两（白送）。
//    方案：silver/gold 仍是「两」整数，新增 silverCopper/goldCopper 存 0..999 的「文」零头。
//    旧档无此字段 → 默认 0，不损失任何已有余额。
// ── 货币种类（op102/op688 currency 位标志实证）：
//    silver=银子(1,2,3) gold=金子(4,8,12) badge=徽章(64，名称在 append) special=特殊(128 竞技场 / 256 悲情值)
const COPPER_PER_LIANG = 1000;
const KEY = { silver: ["silver", "silverCopper"], gold: ["gold", "goldCopper"] };
// 玩家某货币的「文」总数
export function copper(p, cur) {
  if (!p || !KEY[cur]) return 0;
  const [lk, ck] = KEY[cur];
  return Math.max(0, int(p[lk]) * COPPER_PER_LIANG + int(p[ck]));
}
// 扣款（文单位），不足返回 false
export function payCopper(p, cur, c) {
  if (!KEY[cur]) return false;
  c = Math.max(0, int(c));
  let rest = copper(p, cur) - c;
  if (rest < 0) return false;
  const [lk, ck] = KEY[cur];
  p[lk] = Math.floor(rest / COPPER_PER_LIANG);
  p[ck] = rest % COPPER_PER_LIANG;
  return true;
}
// 收入（文单位）
export function gainCopper(p, cur, c) {
  if (!KEY[cur]) return;
  let total = copper(p, cur) + Math.max(0, int(c));
  const [lk, ck] = KEY[cur];
  p[lk] = Math.floor(total / COPPER_PER_LIANG);
  p[ck] = total % COPPER_PER_LIANG;
}
// 展示用：把玩家余额格式化成「42两 990文」（无零头时只显示两）
export function moneyText(p, cur) {
  if (!KEY[cur]) return "0";
  const [lk, ck] = KEY[cur];
  const liang = int(p[lk]), wen = int(p[ck]);
  const unit = cur === "silver" ? "银" : "金";
  if (!liang && !wen) return "0两" + unit;   // 零值也带单位，与「43两银」格式一致
  if (!wen) return liang + "两" + unit;
  if (!liang) return wen + "文" + unit;
  return liang + "两" + unit + " " + wen + "文" + unit;
}
// 把「文」数格式化成原版价格文本（5000,"银" → "5两银"；10,"银" → "10文银"）
export function fmtCopper(c, unit) {
  c = Math.max(0, int(c));
  const liang = Math.floor(c / COPPER_PER_LIANG), wen = c % COPPER_PER_LIANG;
  if (liang && wen) return liang + "两" + unit + " " + wen + "文" + unit;
  if (liang) return liang + "两" + unit;
  return wen + "文" + unit;
}
function int(v) { const n = Math.round(Number(v) || 0); return Number.isFinite(n) ? n : 0; }
