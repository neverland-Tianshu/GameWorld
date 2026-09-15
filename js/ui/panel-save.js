// panel-save.js — 「存档」面板（完整存档 / 存档记录查看 / 备份槽 / 导入导出）
//
// 与 js/save/game-save.js 配套：本文件**只做 UI**，所有采集/落盘/应用逻辑都在 game-save.js。
//
// 面板分段：
//   ① 当前进度（实时）  —— 运行期对象的即时快照，只读，用于与存档点对比
//   ② 当前存档记录      —— tsqt.save.full（存档点）：时间戳 / 构建戳 / 字节 / 摘要 → 读取·导出·删除
//   ③ 备份（3 槽）      —— tsqt.save.bak.1~3：存为备份 / 回到此备份 / 删除
//   ④ 导入前自动备份    —— tsqt.save.preimport（仅在有过导入时出现）
//
// 入口：HUD 顶栏「存档」按钮（ui.js 注册 data-panel="save"）。
// ★ 破坏性操作（读取覆盖 / 删除 / 导入覆盖）一律 window.confirm 二次确认 —— 与 panel-talk.js 既有口径一致。

import { BasePanel } from './panel-manager.js?v=20261007c';
import {
  saveFull, fullInfo, loadFull, listSlots, saveToSlot, restoreSlot, clearSlot,
  preimportInfo, restorePreimport, dropPreimport, dropFull,
  exportFile, importFile, liveMeta, bindSaveContext,
} from '../save/game-save.js?v=20261007c';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 一行摘要（等级/金币/地图/背包/装备/宠物）。 */
function metaLine(m) {
  if (!m) return '（无摘要）';
  const parts = ['Lv.' + m.level, '银子 ' + m.silver, '金子 ' + m.gold];
  if (m.mapName || m.mapId) parts.push((m.mapName || '地图') + (m.mapId ? '(' + m.mapId + ')' : ''));
  parts.push('背包 ' + m.bagSlots + '格/' + m.bagCount + '件');
  parts.push('装备 ' + m.equipCount + '/19');
  parts.push('宠物 ' + m.petCount + (m.petDeployed ? '(出战' + m.petDeployed + ')' : ''));
  return parts.join(' · ');
}

/** 第二行摘要（任务/击杀/技能/HP）。 */
function metaLine2(m) {
  if (!m) return '';
  return '任务 已接' + m.questAccepted + ' / 已完成' + m.questDone +
         ' · 击杀 ' + m.kills + ' · 技能 ' + m.skills + ' · HP ' + m.hp + '/' + m.maxHp;
}

/**
 * 一份存档记录卡片。
 * @param {{title:string, exists:boolean, atText?:string, build?:string, bytes?:number,
 *          meta?:object, reason?:string, slotKey?:string, acts?:{k:string,label:string,cls?:string}[]}} o
 */
function cardHtml(o) {
  const acts = (o.acts || []).map((a) =>
    `<button class="pb-btn ghost ${a.cls || ''}" data-a="${a.k}">${esc(a.label)}</button>`).join('');
  if (!o.exists) {
    const why = o.reason === 'no-save' ? '空' : ('不可用：' + esc(o.reason || '?'));
    return `<div class="sv-card empty" data-slot="${esc(o.slotKey || '')}">
      <div class="sv-main"><div class="sv-t">${esc(o.title)}</div><div class="sv-d">${why}</div></div>
      <div class="sv-acts">${acts}</div>
    </div>`;
  }
  // 实时进度卡片没有时间戳/字节，那一行就不渲染（不显示无意义的"0 字节"）
  const stamp = o.atText
    ? `<div class="sv-d">${esc(o.atText)}${o.build ? ' · 构建 ' + esc(o.build) : ''} · ${o.bytes} 字节</div>`
    : '';
  return `<div class="sv-card" data-slot="${esc(o.slotKey || '')}">
    <div class="sv-main">
      <div class="sv-t">${esc(o.title)}</div>
      ${stamp}
      <div class="sv-d">${esc(metaLine(o.meta))}</div>
      <div class="sv-d">${esc(metaLine2(o.meta))}</div>
    </div>
    <div class="sv-acts">${acts}</div>
  </div>`;
}

export class SavePanel extends BasePanel {
  constructor(ui) { super({ id: 'panel-save', title: '存档', width: 580, height: 560, ui }); }
  init() { this._buildButtons(); this.render(); }
  onOpen() { this.render(); }

  /** 底部主操作按钮（只建一次；render 只刷 body，不会重复追加）。 */
  _buildButtons() {
    this.btnSave = this.addButton('立即完整存档', () => this._doSaveFull());
    this.btnSave.id = 'sv-btn-save';
    this.btnExport = this.addButton('导出 JSON', () => {
      const r = exportFile();
      this.ui.toast(r.ok ? ('已导出 ' + r.file) : ('导出失败：' + r.error));
    });
    this.btnExport.id = 'sv-btn-export';
    this.btnImport = this.addButton('导入 JSON', () => {
      const el = this.body.querySelector('.sv-file');
      if (el) el.click();
    });
    this.btnImport.id = 'sv-btn-import';
  }

  /** ★「立即完整存档」：采集全量 → 写 tsqt.save.full。 */
  _doSaveFull() {
    const r = saveFull();
    if (!r.ok) {
      this.ui.toast('存档失败：' + (r.error || '?'));
    } else {
      const m = r.meta || {};
      this.ui.toast('已完整存档 · ' + r.atText + ' · ' + r.bytes + ' 字节');
      if (this.ui.log) {
        this.ui.log('已完整存档 ' + r.atText + '（Lv.' + m.level + ' · 背包 ' + m.bagSlots +
                    ' 件 · 装备 ' + m.equipCount + ' · 宠物 ' + m.petCount + ' · 地图 ' + (m.mapName || m.mapId) + '）', 'sys');
      }
    }
    this.render();
    return r;
  }

  render() {
    // 面板打开时把运行期上下文同步进来（player 可能刚被重新绑定）
    bindSaveContext({ ui: this.ui, sm: this.ui.sm, player: this.ui.player });

    const live = (() => { try { return liveMeta(); } catch (e) { return null; } })();
    const full = fullInfo();
    const slots = listSlots();
    const pre = preimportInfo();

    const fullCard = cardHtml(Object.assign({}, full, {
      title: '存档点' + (full.exists && full.meta && full.meta.name ? ' · ' + full.meta.name : ''),
      slotKey: 'full',
      acts: [
        { k: 'load-full', label: '读取' },
        { k: 'export-full', label: '导出' },
        { k: 'del-full', label: '删除', cls: 'danger' },
      ],
    }));

    const slotCards = slots.map((s) => cardHtml(Object.assign({}, s, {
      title: '备份槽 ' + s.slot,
      slotKey: 'slot-' + s.slot,
      acts: [
        { k: 'save-slot', label: s.exists ? '覆盖备份' : '存为备份' },
        { k: 'restore-slot', label: '回到此备份' },
        { k: 'del-slot', label: '删除', cls: 'danger' },
      ],
    }))).join('');

    const preCard = pre.exists
      ? cardHtml(Object.assign({}, pre, {
          title: '导入前自动备份',
          slotKey: 'preimport',
          acts: [
            { k: 'restore-preimport', label: '回到导入前' },
            { k: 'del-preimport', label: '删除', cls: 'danger' },
          ],
        }))
      : '';

    this.setContent(`
      <div class="sv-list">
        <div class="sv-sec">
          <div class="sv-h">当前进度（实时 · 未存档）</div>
          ${cardHtml({ title: '运行期状态', exists: !!live, slotKey: '', meta: live, bytes: 0 })}
          <div class="sv-note">
            物品 · 背包装备 · 宠物 变更时<b>已自动落盘</b>；等级 · 金币 · 技能 · 任务 · 坐标 · 仓库队伍
            需点「完整存档」才写进存档点，刷新后从<b>上次存档点</b>恢复。
          </div>
        </div>

        <div class="sv-sec">
          <div class="sv-h">当前存档记录</div>
          ${fullCard}
        </div>

        <div class="sv-sec">
          <div class="sv-h">备份（独立快照，可随时回滚）</div>
          ${slotCards}
        </div>

        ${preCard ? '<div class="sv-sec"><div class="sv-h">导入前自动备份</div>' + preCard + '</div>' : ''}

        <div class="sv-note">
          导出 = 存档点下载成 <code>.json</code>；导入 = 选文件覆盖当前进度（导入前自动备份当前进度）。<br/>
          「读取 / 回到此备份」会把 物品 · 装备 · 宠物 · 角色数值 · 任务 · 仓库队伍 · 地图坐标 一起覆盖并跳图落位。
        </div>
      </div>
      <input class="sv-file" type="file" accept=".json,application/json" style="display:none"/>
    `);

    this._bind();
  }

  _bind() {
    const fileEl = this.body.querySelector('.sv-file');
    this.body.querySelectorAll('.sv-acts button').forEach((b) => {
      b.onclick = () => {
        const card = b.closest('.sv-card');
        this._act(b.dataset.a, card ? card.dataset.slot : '');
      };
    });
    if (fileEl) {
      fileEl.onchange = async () => {
        const f = fileEl.files && fileEl.files[0];
        fileEl.value = '';                        // 允许连续导入同一个文件
        if (!f) return;
        if (!window.confirm('导入「' + f.name + '」将覆盖当前进度（导入前会自动备份当前进度）。继续？')) return;
        const r = await importFile(f);
        if (r.ok) {
          this.ui.toast('已导入存档 · ' + (r.atText || ''));
          if (this.ui.log) this.ui.log('已导入存档 ' + (r.atText || '') + ' · ' + (r.steps || []).join(' '), 'sys');
        } else {
          this.ui.toast('导入失败：' + r.error);
        }
        this.render();
      };
    }
  }

  _act(kind, slotKey) {
    const ui = this.ui;
    const slotNo = slotKey && slotKey.indexOf('slot-') === 0 ? Number(slotKey.slice(5)) : null;

    switch (kind) {
      case 'load-full': {
        if (!window.confirm('读取存档点将覆盖当前进度（物品 · 装备 · 宠物 · 等级金币 · 任务 · 坐标）。继续？')) return;
        this._report('读取存档点', loadFull());
        return this.render();
      }
      case 'del-full': {
        if (!window.confirm('删除当前存档点？物品/宠物仍在实时档中，但等级·金币·任务·坐标将失去恢复来源。')) return;
        const r = dropFull();
        ui.toast(r.existed ? '已删除存档点' : '存档点本就不存在');
        return this.render();
      }
      case 'export-full': {
        const r = exportFile();
        ui.toast(r.ok ? ('已导出 ' + r.file) : ('导出失败：' + r.error));
        return;
      }
      case 'save-slot': {
        const r = saveToSlot(slotNo);
        ui.toast(r.ok ? ('已存为备份 ' + slotNo + ' · ' + r.atText) : ('备份失败：' + r.error));
        return this.render();
      }
      case 'restore-slot': {
        if (!window.confirm('回到备份槽 ' + slotNo + ' 将覆盖当前进度。继续？')) return;
        this._report('回到备份 ' + slotNo, restoreSlot(slotNo));
        return this.render();
      }
      case 'del-slot': {
        if (!window.confirm('删除备份槽 ' + slotNo + '？此操作不可撤销。')) return;
        clearSlot(slotNo);
        ui.toast('已删除备份槽 ' + slotNo);
        return this.render();
      }
      case 'restore-preimport': {
        if (!window.confirm('回到「导入前」的状态将覆盖当前进度。继续？')) return;
        this._report('回到导入前', restorePreimport());
        return this.render();
      }
      case 'del-preimport': {
        if (!window.confirm('删除导入前自动备份？')) return;
        dropPreimport();
        ui.toast('已删除导入前备份');
        return this.render();
      }
      default:
        return;
    }
  }

  _report(label, r) {
    const ok = !!(r && r.ok);
    this.ui.toast(ok ? (label + '完成') : (label + '失败：' + ((r && r.error) || '?')));
    if (this.ui.log) {
      this.ui.log(label + (ok ? '完成' : '失败') + ' · ' + ((r && r.steps) || []).join(' '), ok ? 'sys' : 'warn');
    }
  }
}

export function registerSavePanel(pm, ui) {
  if (pm.factories && pm.factories.save) return;
  pm.register('save', () => new SavePanel(ui));
  // 底部主操作按钮由面板自己在 btns 区提供（BasePanel.addButton）——这里不重复注册
}
