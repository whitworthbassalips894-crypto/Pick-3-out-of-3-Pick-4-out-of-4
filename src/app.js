/**
 * 六合彩「7码复式 · 三中三 / 四中四」每日选号网页工具（PWA 单页版）前端主控制器
 */

import {
  ALL_NUMBERS,
  COLOR_LABELS,
  DEFAULT_CONFIG,
  getColorForNumber,
  getZodiacForNumber,
  pad2,
  padPeriod
} from './constants.js';
import {
  evaluate7CodeCompound,
  evaluateDirectTickets,
  normalizeNumbers
} from './combinatorics.js';
import { mergeDraws, normalizeDrawRecord, parseDrawsInput } from './parser.js';
import {
  STRATEGY_CATALOG,
  generatePeriodPlan,
  runHistoricalBacktest
} from './strategy.js';
import INITIAL_DB from '../data/draws.js';

const STORAGE_KEYS = {
  CONFIG: 'mark6_pick3_config_v1',
  LOCAL_DRAWS: 'mark6_pick3_local_draws_v1',
  CUSTOM_PICKS: 'mark6_pick3_custom_picks_v1'
};

const state = {
  activeTab: 'daily',
  config: { ...DEFAULT_CONFIG },
  baseDraws: Array.isArray(INITIAL_DB?.draws) ? INITIAL_DB.draws : [],
  localDraws: [],
  allDraws: [],
  lastSyncTime: INITIAL_DB?.updatedAt || '2026-10-24',

  // 模块1：每日7码选号状态
  selectedPeriodKey: 'NEXT', // 'NEXT' 或 具体 draw.id 如 '2026-296'
  activeStrategyId: 'composite',
  schemeViewMode: 'both_modes', // 'both_modes' | 'compound_only' | 'strategies_only'
  customPicks: [],
  pinnedPicks: [],
  simNormals: [],
  comboExpandTab: 'pick3', // 'pick3' | 'pick4'

  // 模块2：录入开奖状态
  entryBalls: [], // 最多 7 个球（前6正码 + 第7特码）

  // 模块3：历史回放状态
  historyPageSize: 40,
  historyVisibleCount: 40,
  openHistoryDrawIds: new Set()
};

/* ==================== 工具函数 ==================== */

function showToast(msg) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 2800);
}

async function copyText(text, label = '方案已复制到剪贴板') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    showToast(`✅ ${label}`);
  } catch {
    showToast('复制失败，请手动选择复制');
  }
}

function formatMoney(num) {
  const n = Number(num || 0);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toLocaleString('zh-CN')} 元`;
}

function renderBallHtml(num, options = {}) {
  const n = Number(num);
  const color = options.color || getColorForNumber(n);
  const zodiac = options.zodiac || getZodiacForNumber(n, options.dateOrYear || '2026-10-24');
  const sizeClass = options.size ? ` ${options.size}` : '';
  const hitClass = options.isHit ? ' ball-hit' : '';
  const dimClass = options.isSpecialDim ? ' ball-special-dim' : '';
  const pinHtml = options.isPinned ? '<span class="pin-badge">胆</span>' : '';
  const subText = options.subText !== undefined ? options.subText : zodiac;
  const dataAttr = options.dataAttr || '';

  return `
    <div class="lotto-ball-wrap" ${dataAttr}>
      <div class="lotto-ball ${color}${sizeClass}${hitClass}${dimClass}">
        ${pad2(n)}
        ${pinHtml}
      </div>
      ${subText ? `<span class="ball-meta">${subText}</span>` : ''}
    </div>
  `;
}

/* ==================== 本地存储与底库管理 ==================== */

function loadSavedState() {
  try {
    const rawCfg = localStorage.getItem(STORAGE_KEYS.CONFIG);
    if (rawCfg) {
      const parsed = JSON.parse(rawCfg);
      state.config = { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // ignore
  }

  try {
    const rawLocal = localStorage.getItem(STORAGE_KEYS.LOCAL_DRAWS);
    if (rawLocal) {
      const arr = JSON.parse(rawLocal);
      if (Array.isArray(arr)) {
        state.localDraws = arr.map(normalizeDrawRecord).filter(Boolean);
      }
    }
  } catch {
    state.localDraws = [];
  }

  rebuildMergedDraws();
}

function saveConfig() {
  try {
    localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(state.config));
  } catch {
    // ignore
  }
}

function saveLocalDraws() {
  try {
    localStorage.setItem(STORAGE_KEYS.LOCAL_DRAWS, JSON.stringify(state.localDraws));
  } catch {
    // ignore
  }
}

function rebuildMergedDraws() {
  const { merged } = mergeDraws(state.baseDraws, state.localDraws);
  state.allDraws = merged;
}

function getNextDrawMeta() {
  const latest = state.allDraws[0] || { year: 2026, periodNum: 296, date: '2026-10-23' };
  const nextPeriodNum = (latest.periodNum || 0) + 1;
  // 计算下一天日期
  let nextDate = '2026-10-24';
  if (latest.date && /^\d{4}-\d{2}-\d{2}$/.test(latest.date)) {
    const dt = new Date(`${latest.date}T12:00:00Z`);
    if (!Number.isNaN(dt.getTime())) {
      dt.setUTCDate(dt.getUTCDate() + 1);
      nextDate = dt.toISOString().slice(0, 10);
    }
  }
  return {
    id: 'NEXT',
    year: latest.year,
    periodNum: nextPeriodNum,
    period: padPeriod(nextPeriodNum),
    date: nextDate,
    isUpcoming: true
  };
}

function getSelectedPeriodContext() {
  if (state.selectedPeriodKey === 'NEXT') {
    const nextMeta = getNextDrawMeta();
    return {
      target: nextMeta,
      draw: null,
      isUpcoming: true
    };
  }
  const found = state.allDraws.find((d) => d.id === state.selectedPeriodKey);
  if (found) {
    return {
      target: {
        id: found.id,
        year: found.year,
        periodNum: found.periodNum,
        period: found.period,
        date: found.date,
        isUpcoming: false
      },
      draw: found,
      isUpcoming: false
    };
  }
  const nextMeta = getNextDrawMeta();
  return { target: nextMeta, draw: null, isUpcoming: true };
}

/* ==================== 顶部状态与期号选择器更新 ==================== */

function renderHeaderStatus() {
  const badge = document.getElementById('dbStatusBadge');
  const banner = document.getElementById('latestDrawBanner');
  const latest = state.allDraws[0];

  if (badge) {
    badge.textContent = `底库 ${state.allDraws.length} 期 (2022-2026)`;
  }
  if (banner && latest) {
    const normalsStr = latest.numbers.map(pad2).join(' ');
    banner.textContent = `最新开奖: ${latest.year}年第${latest.period}期 (${latest.date}) 正码 [${normalsStr}] + 特码 ${pad2(latest.special)}`;
  }

  const stakeInput = document.getElementById('cfgStake');
  const odds3Input = document.getElementById('cfgOdds3');
  const odds4Input = document.getElementById('cfgOdds4');
  if (stakeInput) stakeInput.value = state.config.stake;
  if (odds3Input) odds3Input.value = state.config.odds3;
  if (odds4Input) odds4Input.value = state.config.odds4;
}

function populateDailyPeriodSelect() {
  const select = document.getElementById('dailyPeriodSelect');
  if (!select) return;

  const nextMeta = getNextDrawMeta();
  const optionsHtml = [
    `<option value="NEXT">🌟 待开奖推荐：${nextMeta.year}年第${nextMeta.period}期 (${nextMeta.date})</option>`
  ];

  const recentDraws = state.allDraws.slice(0, 150);
  for (const d of recentDraws) {
    const normals = d.numbers.map(pad2).join(' ');
    optionsHtml.push(
      `<option value="${d.id}">${d.year}年第${d.period}期 (${d.date}) — 正码 [${normals}] + ${pad2(d.special)}</option>`
    );
  }

  select.innerHTML = optionsHtml.join('');
  select.value = state.selectedPeriodKey;
}

/* ==================== 模块一：每日7码选号渲染 ==================== */

function renderDailyModule() {
  const { target, draw, isUpcoming } = getSelectedPeriodContext();
  const plan = generatePeriodPlan(state.allDraws, target, {
    strategyId: state.activeStrategyId,
    pinnedNumbers: state.pinnedPicks
  });

  // 如果 customPicks 尚未初始化，默认同步为主推 7 码
  if (state.customPicks.length === 0) {
    state.customPicks = plan.primary7.slice();
  }

  // 控制双模式显隐
  const secCompound = document.getElementById('sectionCompoundView');
  const secStrategies = document.getElementById('sectionStrategiesView');
  if (secCompound && secStrategies) {
    secCompound.style.display = state.schemeViewMode === 'strategies_only' ? 'none' : 'block';
    secStrategies.style.display = state.schemeViewMode === 'compound_only' ? 'none' : 'block';
  }

  // 1. 渲染主推 Hero 卡片
  const activeStratObj =
    plan.strategies.find((s) => s.id === state.activeStrategyId) || plan.strategies[0];

  const heroTargetLabel = document.getElementById('heroTargetLabel');
  const heroStrategyBadge = document.getElementById('heroStrategyBadge');
  const heroSampleDesc = document.getElementById('heroSampleDesc');
  const heroWaveRatio = document.getElementById('heroWaveRatio');

  if (heroTargetLabel) {
    heroTargetLabel.textContent = `${target.year}年第${target.period}期 (${target.date}) · ${
      isUpcoming ? '最新待开期推荐' : '历史期回放核对'
    }`;
  }
  if (heroStrategyBadge) {
    heroStrategyBadge.textContent = `${activeStratObj.code} · ${activeStratObj.name}`;
  }
  if (heroSampleDesc) {
    heroSampleDesc.textContent = `基于该期之前 ${plan.priorSampleCount} 期历史正码样本推演`;
  }
  if (heroWaveRatio) {
    const w = activeStratObj.waveSummary;
    heroWaveRatio.textContent = `红波${w.red} · 蓝波${w.blue} · 绿波${w.green}`;
  }

  const evalPrimary = evaluate7CodeCompound(plan.primary7, draw, state.config);
  const normalHitSet = new Set(evalPrimary.matchedNormals);

  const heroSevenBalls = document.getElementById('heroSevenBalls');
  if (heroSevenBalls) {
    heroSevenBalls.innerHTML = plan.primary7
      .map((n) => {
        const st = plan.numberStats[n];
        return renderBallHtml(n, {
          size: 'lg',
          dateOrYear: target.date,
          isHit: normalHitSet.has(n),
          isPinned: state.pinnedPicks.includes(n),
          subText: `${st.zodiac}·${st.tag}`
        });
      })
      .join('');
  }

  // 当期开奖结果与收益核对框
  const heroDrawResultBox = document.getElementById('heroDrawResultBox');
  if (heroDrawResultBox) {
    if (!draw) {
      const cost35 = 35 * state.config.stake;
      const singleWin3 = state.config.stake * state.config.odds3;
      const singleWin4 = state.config.stake * state.config.odds4;
      heroDrawResultBox.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span style="font-weight: 700; color: #fbbf24;">⏳ 第 ${target.period} 期等待开奖</span>
          <span class="tag tag-muted">7码复式 = 35注</span>
        </div>
        <div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.65;">
          <div>• 7码复式单期总本金：<b>${cost35} 元</b>（35注 × ${state.config.stake}元）</div>
          <div>• 中3个正码 → 中 <b>1注</b> 三中三（奖金 <b>${singleWin3}元</b>）</div>
          <div>• 中4个正码 → 中 <b>4注</b> 三中三（<b>${singleWin3 * 4}元</b>）+ <b>1注</b> 四中四（<b>${singleWin4}元</b>）</div>
          <div>• 中5个正码 → 中 <b>10注</b> 三中三 + <b>5注</b> 四中四 | 中6正码 → 中 <b>20注</b> 三中三 + <b>15注</b> 四中四</div>
        </div>
      `;
    } else {
      const p3 = evalPrimary.pick3;
      const p4 = evalPrimary.pick4;
      const drawBallsHtml = draw.numbers
        .map((n, i) =>
          renderBallHtml(n, {
            size: 'sm',
            color: draw.colors?.[i],
            zodiac: draw.zodiacs?.[i],
            isHit: plan.primary7.includes(n)
          })
        )
        .join('');
      const specialHtml = renderBallHtml(draw.special, {
        size: 'sm',
        color: draw.colors?.[6],
        zodiac: draw.zodiacs?.[6],
        isSpecialDim: true,
        subText: `${draw.zodiacs?.[6] || ''}·特`
      });

      heroDrawResultBox.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px;">
          <span style="font-size: 0.82rem; font-weight: 700;">当期开奖（前6正码核对）：</span>
          <span class="tag ${evalPrimary.matchedNormalCount >= 3 ? 'tag-win' : 'tag-muted'}">
            命中正码 ${evalPrimary.matchedNormalCount} 个 ${
              evalPrimary.matchedNormals.length > 0
                ? `[${evalPrimary.matchedNormals.map(pad2).join(', ')}]`
                : ''
            }
          </span>
        </div>
        <div class="ball-row" style="margin-bottom: 10px;">
          ${drawBallsHtml}
          <span class="ball-plus">+</span>
          ${specialHtml}
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 0.8rem; background: rgba(11,17,32,0.7); padding: 8px 10px; border-radius: 8px;">
          <div>
            <span style="color: var(--text-secondary);">三中三命中:</span>
            <b style="color: ${p3.winCount > 0 ? '#34d399' : '#f8fafc'};"> ${p3.winCount} / 35 注</b>
            <div>净收益: <b style="color: ${p3.netProfit >= 0 ? '#34d399' : '#f87171'};">${formatMoney(p3.netProfit)}</b></div>
          </div>
          <div>
            <span style="color: var(--text-secondary);">四中四命中:</span>
            <b style="color: ${p4.winCount > 0 ? '#fbbf24' : '#f8fafc'};"> ${p4.winCount} / 35 注</b>
            <div>净收益: <b style="color: ${p4.netProfit >= 0 ? '#34d399' : '#f87171'};">${formatMoney(p4.netProfit)}</b></div>
          </div>
        </div>
      `;
    }
  }

  // 2. 渲染精选 5 注三中三 & 5 注四中四
  const lbl5Pick3Cost = document.getElementById('lbl5Pick3Cost');
  const lbl5Pick4Cost = document.getElementById('lbl5Pick4Cost');
  if (lbl5Pick3Cost) lbl5Pick3Cost.textContent = String(5 * state.config.stake);
  if (lbl5Pick4Cost) lbl5Pick4Cost.textContent = String(5 * state.config.stake);

  const eval5Pick3 = evaluateDirectTickets(plan.featuredPick3, draw, {
    ...state.config,
    targetSize: 3
  });
  const eval5Pick4 = evaluateDirectTickets(plan.featuredPick4, draw, {
    ...state.config,
    targetSize: 4
  });

  const featured5Pick3List = document.getElementById('featured5Pick3List');
  if (featured5Pick3List) {
    featured5Pick3List.innerHTML = eval5Pick3.details
      .map((item) => {
        const balls = item.nums
          .map((n) =>
            renderBallHtml(n, {
              size: 'sm',
              dateOrYear: target.date,
              isHit: draw ? item.hitNums.includes(n) : false,
              subText: ''
            })
          )
          .join('');
        const statusBadge = !draw
          ? `<span class="tag tag-muted">三中三直选</span>`
          : item.isWin
            ? `<span class="tag tag-win">★ 中奖 +${item.payout}元</span>`
            : `<span class="tag tag-muted">中 ${item.hitCount}/3 码</span>`;
        return `
          <div class="ticket-item ${item.isWin ? 'ticket-win' : ''}">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span class="ticket-idx">第 ${item.index} 注</span>
              <div class="ball-row">${balls}</div>
            </div>
            ${statusBadge}
          </div>
        `;
      })
      .join('');
  }

  const featured5Pick4List = document.getElementById('featured5Pick4List');
  if (featured5Pick4List) {
    featured5Pick4List.innerHTML = eval5Pick4.details
      .map((item) => {
        const balls = item.nums
          .map((n) =>
            renderBallHtml(n, {
              size: 'sm',
              dateOrYear: target.date,
              isHit: draw ? item.hitNums.includes(n) : false,
              subText: ''
            })
          )
          .join('');
        const statusBadge = !draw
          ? `<span class="tag tag-muted">四中四直选</span>`
          : item.isWin
            ? `<span class="tag tag-gold">★ 中奖 +${item.payout}元</span>`
            : `<span class="tag tag-muted">中 ${item.hitCount}/4 码</span>`;
        return `
          <div class="ticket-item ${item.isWin ? 'ticket-win' : ''}">
            <div style="display: flex; align-items: center; gap: 10px;">
              <span class="ticket-idx">第 ${item.index} 注</span>
              <div class="ball-row">${balls}</div>
            </div>
            ${statusBadge}
          </div>
        `;
      })
      .join('');
  }

  // 3. 渲染 5 组策略方案对比卡片（S1 ~ S5）
  const strategyCardsContainer = document.getElementById('strategyCardsContainer');
  if (strategyCardsContainer) {
    strategyCardsContainer.innerHTML = plan.strategies
      .map((strat) => {
        const isCurrent = strat.id === state.activeStrategyId;
        const stEval = evaluate7CodeCompound(strat.numbers, draw, state.config);
        const hitSet = new Set(stEval.matchedNormals);

        const ballsHtml = strat.numbers
          .map((n) =>
            renderBallHtml(n, {
              size: 'sm',
              dateOrYear: target.date,
              isHit: hitSet.has(n),
              subText: plan.numberStats[n]?.zodiac || ''
            })
          )
          .join('');

        const top3Preview = strat.top5Pick3
          .slice(0, 3)
          .map((t) => `[${t.map(pad2).join('-')}]`)
          .join(' ');
        const top4Preview = strat.top5Pick4
          .slice(0, 2)
          .map((t) => `[${t.map(pad2).join('-')}]`)
          .join(' ');

        const drawHitFooter = draw
          ? `
            <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px dashed var(--border-highlight); font-size: 0.78rem;">
              <span>命中正码: <b style="color: ${stEval.matchedNormalCount >= 3 ? '#34d399' : '#f8fafc'};">${stEval.matchedNormalCount}个</b></span>
              <span>三中三: <b style="color: ${stEval.pick3.winCount > 0 ? '#34d399' : '#94a3b8'};">${stEval.pick3.winCount}注</b></span>
              <span>四中四: <b style="color: ${stEval.pick4.winCount > 0 ? '#fbbf24' : '#94a3b8'};">${stEval.pick4.winCount}注</b></span>
              <span style="color: ${stEval.pick3.netProfit >= 0 ? '#34d399' : '#94a3b8'}; font-weight: 700;">
                ${formatMoney(stEval.pick3.netProfit)}
              </span>
            </div>
          `
          : '';

        return `
          <div class="strategy-card ${isCurrent ? 'active-strategy' : ''}">
            <div>
              <div class="strategy-head">
                <div style="display: flex; align-items: center; gap: 7px;">
                  <span class="strategy-code">${strat.code}</span>
                  <span style="font-weight: 800; font-size: 0.92rem;">${strat.name}</span>
                </div>
                <span class="tag ${isCurrent ? 'tag-gold' : 'tag-muted'}">${isCurrent ? '当前主推' : strat.badge}</span>
              </div>
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin: 6px 0 10px;">
                ${strat.description}
              </div>
              <div class="ball-row" style="margin-bottom: 10px;">${ballsHtml}</div>
              <div style="font-size: 0.74rem; color: var(--text-secondary); background: #0b1120; padding: 7px 9px; border-radius: 7px; line-height: 1.55;">
                <div><b style="color: #34d399;">三中三精选:</b> ${top3Preview} ...</div>
                <div><b style="color: #fbbf24;">四中四精选:</b> ${top4Preview} ...</div>
              </div>
            </div>
            ${drawHitFooter}
            <div style="display: flex; gap: 8px;">
              <button type="button" class="btn btn-sm ${isCurrent ? 'btn-primary' : ''}" data-action="activate-strategy" data-strategy="${strat.id}" style="flex: 1;">
                ${isCurrent ? '✓ 已设为主推' : '设为主推方案'}
              </button>
              <button type="button" class="btn btn-sm" data-action="load-strategy-custom" data-strategy="${strat.id}">
                载入选号盘
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // 4. 渲染 49 码交互选号盘与 35 注全展开
  renderInteractive49Picker(plan, draw);
}

function renderInteractive49Picker(plan, periodDraw) {
  const matrixEl = document.getElementById('ballMatrix49');
  if (!matrixEl) return;

  const selectedSet = new Set(state.customPicks);
  const pinnedSet = new Set(state.pinnedPicks);

  matrixEl.innerHTML = ALL_NUMBERS.map((n) => {
    const st = plan.numberStats[n];
    const isSelected = selectedSet.has(n);
    const isPinned = pinnedSet.has(n);
    return `
      <div class="matrix-cell ${isSelected ? 'selected' : ''} ${isPinned ? 'pinned' : ''}" data-ball="${n}">
        <div class="lotto-ball sm ${st.color}">
          ${pad2(n)}
          ${isPinned ? '<span class="pin-badge">胆</span>' : ''}
        </div>
        <div style="font-size: 0.68rem; color: var(--text-secondary);">
          ${st.zodiac} · <span style="color: ${
            st.tag === '热码' ? '#f87171' : st.tag === '冷码' ? '#38bdf8' : '#94a3b8'
          };">${st.tag}</span>
        </div>
        <div style="font-size: 0.63rem; color: var(--text-muted);">
          30期${st.freq30}次/漏${st.omission}
        </div>
      </div>
    `;
  }).join('');

  const customPickCount = document.getElementById('customPickCount');
  if (customPickCount) {
    customPickCount.textContent = String(state.customPicks.length);
  }

  // 确定用于核对 35 注展开的开奖正码（优先用模拟输入框，否则用当前选中期开奖）
  const simDraw =
    state.simNormals.length > 0
      ? { numbers: state.simNormals, special: periodDraw?.special ?? null }
      : periodDraw;

  const evalCustom = evaluate7CodeCompound(state.customPicks, simDraw, state.config);
  const hitNormalsSet = new Set(evalCustom.matchedNormals);

  const customSelectedBallsRow = document.getElementById('customSelectedBallsRow');
  if (customSelectedBallsRow) {
    if (state.customPicks.length === 0) {
      customSelectedBallsRow.innerHTML = `<span style="font-size: 0.82rem; color: var(--text-muted);">尚未选择号码，请点击上方号码球或点击「智能生成/补齐7码」</span>`;
    } else {
      customSelectedBallsRow.innerHTML = state.customPicks
        .map((n) =>
          renderBallHtml(n, {
            dateOrYear: plan.target.date,
            isHit: hitNormalsSet.has(n),
            isPinned: pinnedSet.has(n),
            dataAttr: `data-toggle-pin="${n}" style="cursor: pointer;" title="点击切换胆码锁定"`
          })
        )
        .join('');
    }
  }

  // 模拟核算摘要
  const simCalcSummary = document.getElementById('simCalcSummary');
  if (simCalcSummary) {
    if (!evalCustom.hasDraw) {
      simCalcSummary.innerHTML = `<span style="color: var(--text-secondary);">可在上方输入框填入任意 6 个正码（如 <code>14 43 26 45 03 31</code>）实时检验 35 注三中三/四中四命中表现。</span>`;
    } else {
      const p3 = evalCustom.pick3;
      const p4 = evalCustom.pick4;
      simCalcSummary.innerHTML = `
        <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center;">
          <span>核对正码: <b>[${evalCustom.normalList.map(pad2).join(' ')}]</b></span>
          <span class="tag ${evalCustom.matchedNormalCount >= 3 ? 'tag-win' : 'tag-muted'}">
            命中 ${evalCustom.matchedNormalCount} 个正码
          </span>
          <span>三中三中: <b style="color: #34d399;">${p3.winCount} 注</b> (${formatMoney(p3.netProfit)})</span>
          <span>四中四中: <b style="color: #fbbf24;">${p4.winCount} 注</b> (${formatMoney(p4.netProfit)})</span>
        </div>
      `;
    }
  }

  // 35 注三中三 / 35 注四中四 全展开渲染
  const lblComboCount3 = document.getElementById('lblComboCount3');
  const lblComboCount4 = document.getElementById('lblComboCount4');
  if (lblComboCount3) lblComboCount3.textContent = String(evalCustom.pick3.totalBets);
  if (lblComboCount4) lblComboCount4.textContent = String(evalCustom.pick4.totalBets);

  const activePlay = state.comboExpandTab === 'pick4' ? evalCustom.pick4 : evalCustom.pick3;
  const targetLen = state.comboExpandTab === 'pick4' ? 4 : 3;

  const comboExpandStatsText = document.getElementById('comboExpandStatsText');
  if (comboExpandStatsText) {
    comboExpandStatsText.innerHTML = `
      共 <b>${activePlay.totalBets}</b> 注 · 投注成本 <b>${activePlay.cost}</b> 元
      ${
        evalCustom.hasDraw
          ? ` · 命中 <b style="color: #34d399;">${activePlay.winCount}</b> 注 · 奖金 <b style="color: #fbbf24;">${activePlay.payout}</b> 元 · 净收益 <b>${formatMoney(activePlay.netProfit)}</b>`
          : ''
      }
    `;
  }

  const combos35Grid = document.getElementById('combos35Grid');
  if (combos35Grid) {
    if (activePlay.combos.length === 0) {
      combos35Grid.innerHTML = `<div style="color: var(--text-muted); font-size: 0.84rem; grid-column: 1 / -1;">请至少选择 ${targetLen} 个号码以展开组合明细。</div>`;
    } else {
      combos35Grid.innerHTML = activePlay.combos
        .map((c) => {
          const cls = c.isWin
            ? 'combo-chip combo-win'
            : c.hitCount >= 2
              ? 'combo-chip combo-partial'
              : 'combo-chip';
          const numsStr = c.nums
            .map((n) =>
              hitNormalsSet.has(n)
                ? `<span style="color: #fbbf24; text-decoration: underline;">${pad2(n)}</span>`
                : pad2(n)
            )
            .join(' · ');
          const badge = evalCustom.hasDraw
            ? c.isWin
              ? '★ 中奖'
              : `中${c.hitCount}`
            : `#${String(c.index).padStart(2, '0')}`;
          return `
            <div class="${cls}">
              <span>${numsStr}</span>
              <span style="font-size: 0.72rem; opacity: 0.85;">${badge}</span>
            </div>
          `;
        })
        .join('');
    }
  }
}

/* ==================== 模块二：录入开奖渲染 ==================== */

function initEntryModuleDefaults() {
  const nextMeta = getNextDrawMeta();
  const yearEl = document.getElementById('entryYear');
  const periodEl = document.getElementById('entryPeriod');
  const dateEl = document.getElementById('entryDate');

  if (yearEl) yearEl.value = String(nextMeta.year);
  if (periodEl) periodEl.value = String(nextMeta.periodNum);
  if (dateEl) dateEl.value = nextMeta.date;
}

function renderEntryModule() {
  const year = Number(document.getElementById('entryYear')?.value || 2026);
  const periodNum = Number(document.getElementById('entryPeriod')?.value || 297);
  const date = document.getElementById('entryDate')?.value || '2026-10-24';

  // 渲染 7 个槽位（平一~平六 + 特码）
  const labels = ['平一', '平二', '平三', '平四', '平五', '平六', '特码'];
  const slotsEl = document.getElementById('entrySlotsPreview');
  if (slotsEl) {
    slotsEl.innerHTML = labels
      .map((label, idx) => {
        const num = state.entryBalls[idx];
        const plusSep = idx === 6 ? '<span class="ball-plus">+</span>' : '';
        if (!num) {
          return `
            ${plusSep}
            <div class="lotto-ball-wrap">
              <div class="lotto-ball" style="background: #1e293b; border: 1px dashed #475569; color: #64748b; font-size: 0.75rem;">
                ${label}
              </div>
              <span class="ball-meta">${label}</span>
            </div>
          `;
        }
        return `
          ${plusSep}
          ${renderBallHtml(num, {
            dateOrYear: date,
            subText: `${label}·${getZodiacForNumber(num, date)}`,
            dataAttr: `data-remove-entry-idx="${idx}" style="cursor: pointer;" title="点击移除"`
          })}
        `;
      })
      .join('');
  }

  // 渲染 49 球点选键盘
  const keypadEl = document.getElementById('entryBallKeypad');
  if (keypadEl) {
    const usedSet = new Set(state.entryBalls);
    keypadEl.innerHTML = ALL_NUMBERS.map((n) => {
      const color = getColorForNumber(n);
      const used = usedSet.has(n);
      return `
        <button
          type="button"
          class="matrix-cell ${used ? 'selected' : ''}"
          data-entry-ball="${n}"
          style="padding: 5px 2px;"
        >
          <span class="lotto-ball sm ${color}">${pad2(n)}</span>
        </button>
      `;
    }).join('');
  }

  // 渲染实时核对预览
  const liveOutput = document.getElementById('entryLiveCheckOutput');
  if (liveOutput) {
    const normals = state.entryBalls.slice(0, 6);
    const special = state.entryBalls[6] || null;
    const plan = generatePeriodPlan(state.allDraws, { year, periodNum, date }, {
      strategyId: state.activeStrategyId
    });

    if (normals.length < 6) {
      liveOutput.innerHTML = `
        <div style="padding: 12px; background: #0f172a; border-radius: 10px; font-size: 0.84rem; color: var(--text-secondary);">
          <div>当前目标期：<b>${year}年第${padPeriod(periodNum)}期 (${date})</b></div>
          <div style="margin-top: 6px;">本期主推 7 码复式：<b>[${plan.primary7.map(pad2).join(' ')}]</b></div>
          <div style="margin-top: 6px; color: #fbbf24;">请继续点选或输入满 6 个正码（已选 ${normals.length}/6 个正码），系统将立即实时核算三中三与四中四命中结果。</div>
        </div>
      `;
    } else {
      const tempDraw = { numbers: normals, special };
      const primaryEval = evaluate7CodeCompound(plan.primary7, tempDraw, state.config);
      const stratRows = plan.strategies
        .map((st) => {
          const ev = evaluate7CodeCompound(st.numbers, tempDraw, state.config);
          return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--border-color); font-size: 0.8rem;">
              <span><b>${st.code} ${st.shortName}</b> [${st.numbers.map(pad2).join(' ')}]</span>
              <span>
                正码中 <b>${ev.matchedNormalCount}</b> ·
                三中三 <b style="color: ${ev.pick3.winCount > 0 ? '#34d399' : '#94a3b8'};">${ev.pick3.winCount}注</b> ·
                四中四 <b style="color: ${ev.pick4.winCount > 0 ? '#fbbf24' : '#94a3b8'};">${ev.pick4.winCount}注</b>
              </span>
            </div>
          `;
        })
        .join('');

      liveOutput.innerHTML = `
        <div style="background: #0f172a; border: 1px solid var(--border-highlight); border-radius: 10px; padding: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span style="font-weight: 700;">主推 7 码 [${plan.primary7.map(pad2).join(' ')}] 核对结果：</span>
            <span class="tag ${primaryEval.matchedNormalCount >= 3 ? 'tag-win' : 'tag-muted'}">
              命中 ${primaryEval.matchedNormalCount} 个正码
            </span>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; font-size: 0.82rem;">
            <div style="background: #111827; padding: 8px 10px; border-radius: 8px;">
              <div>三中三命中：<b>${primaryEval.pick3.winCount} / 35 注</b></div>
              <div>当期净收益：<b style="color: ${primaryEval.pick3.netProfit >= 0 ? '#34d399' : '#f87171'};">${formatMoney(primaryEval.pick3.netProfit)}</b></div>
            </div>
            <div style="background: #111827; padding: 8px 10px; border-radius: 8px;">
              <div>四中四命中：<b>${primaryEval.pick4.winCount} / 35 注</b></div>
              <div>当期净收益：<b style="color: ${primaryEval.pick4.netProfit >= 0 ? '#34d399' : '#f87171'};">${formatMoney(primaryEval.pick4.netProfit)}</b></div>
            </div>
          </div>
          <div style="font-size: 0.78rem; font-weight: 700; color: var(--text-secondary); margin-bottom: 4px;">
            5 组策略方案同场核对：
          </div>
          ${stratRows}
        </div>
      `;
    }
  }

  // 渲染本地新增记录列表
  const localListEl = document.getElementById('localCustomDrawsList');
  if (localListEl) {
    if (state.localDraws.length === 0) {
      localListEl.innerHTML = `<div style="font-size: 0.82rem; color: var(--text-muted);">暂无本地手工新增记录（已内置 2022–2026 共 ${state.baseDraws.length} 期官方历史底库）。</div>`;
    } else {
      localListEl.innerHTML = state.localDraws
        .map(
          (d) => `
          <div class="ticket-item" style="margin-bottom: 6px;">
            <div>
              <span style="font-weight: 700; color: #fbbf24;">${d.year}-${d.period}期 (${d.date})</span>
              <span style="font-size: 0.82rem; margin-left: 8px;">
                正码 [${d.numbers.map(pad2).join(' ')}] + 特码 ${pad2(d.special)}
              </span>
            </div>
            <button type="button" class="btn btn-sm" data-delete-local-id="${d.id}">删除</button>
          </div>
        `
        )
        .join('');
    }
  }
}

/* ==================== 模块三：历史回放（含三中三命中明细） ==================== */

function renderHistoryModule() {
  const yearVal = document.getElementById('histYearFilter')?.value || '2026';
  const limitVal = Number(document.getElementById('histLimitFilter')?.value || 366);
  const strategyVal = document.getElementById('histStrategyFilter')?.value || 'composite';
  const betModeVal = document.getElementById('histBetModeFilter')?.value || 'compound7';
  const hitFilterVal = document.getElementById('histHitFilter')?.value || 'all';
  const searchQuery = (document.getElementById('histSearchInput')?.value || '').trim().toLowerCase();

  const customNums =
    strategyVal === 'custom' && state.customPicks.length >= 4 ? state.customPicks : null;

  const backtest = runHistoricalBacktest(state.allDraws, {
    year: yearVal === 'all' ? 'all' : Number(yearVal),
    limit: limitVal,
    strategyId: strategyVal === 'custom' ? 'composite' : strategyVal,
    customNumbers: customNums,
    stake: state.config.stake,
    odds3: state.config.odds3,
    odds4: state.config.odds4,
    betMode: betModeVal
  });

  const { summary, records } = backtest;

  // 渲染汇总 KPI 看板
  const kpiGrid = document.getElementById('historyKpiGrid');
  if (kpiGrid) {
    const p3 = summary.pick3;
    const p4 = summary.pick4;
    kpiGrid.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">回测总期数 (${betModeVal === 'featured5' ? '5注/期' : '35注/期'})</div>
        <div class="kpi-value">${summary.totalPeriods} 期</div>
        <div class="kpi-sub">命中 ≥2 正码: ${summary.hitNormalGe2Periods} 期</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">三中三命中期数 / 总注数</div>
        <div class="kpi-value gold">${p3.hitPeriods} 期 (${p3.totalWinBets} 注)</div>
        <div class="kpi-sub">期命中率 ${p3.hitRate}% · 单期最高 ${p3.maxSingleWinBets} 注</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">三中三累计总投入 / 总奖金</div>
        <div class="kpi-value">${p3.totalPayout.toLocaleString('zh-CN')} 元</div>
        <div class="kpi-sub">累计投入: ${p3.totalCost.toLocaleString('zh-CN')} 元</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">三中三累计净收益 / ROI</div>
        <div class="kpi-value ${p3.netProfit >= 0 ? 'positive' : 'negative'}">${formatMoney(p3.netProfit)}</div>
        <div class="kpi-sub">投资回报率 ROI: ${p3.roi}%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">四中四命中期数 / 净收益</div>
        <div class="kpi-value ${p4.winCount > 0 || p4.hitPeriods > 0 ? 'gold' : ''}">${p4.hitPeriods} 期 (${p4.totalWinBets} 注)</div>
        <div class="kpi-sub">净收益: ${formatMoney(p4.netProfit)}</div>
      </div>
    `;
  }

  // 过滤记录
  const filteredRecords = records.filter((r) => {
    if (hitFilterVal === 'hit3' && r.active3.winCount <= 0) return false;
    if (hitFilterVal === 'hit4' && r.active4.winCount <= 0) return false;
    if (hitFilterVal === 'hit2' && r.matchedNormalCount < 2) return false;
    if (searchQuery) {
      const hay = `${r.draw.id} ${r.draw.period} ${r.draw.date} ${r.draw.numbers.map(pad2).join(' ')} ${pad2(r.draw.special)}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  const visibleSlice = filteredRecords.slice(0, state.historyVisibleCount);
  const container = document.getElementById('historyRecordsContainer');

  if (container) {
    if (visibleSlice.length === 0) {
      container.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--text-muted);">当前筛选条件下暂无匹配的历史开奖记录。</div>`;
    } else {
      container.innerHTML = visibleSlice
        .map((rec) => {
          const { draw, sevenNumbers, matchedNormals, matchedNormalCount, active3, active4, compoundEval } = rec;
          const isHit4 = active4.winCount > 0;
          const isHit3 = active3.winCount > 0;
          const isOpen = state.openHistoryDrawIds.has(draw.id);
          const hitSet = new Set(matchedNormals);

          const drawNormalBalls = draw.numbers
            .map((n, idx) =>
              renderBallHtml(n, {
                size: 'sm',
                color: draw.colors?.[idx],
                zodiac: draw.zodiacs?.[idx],
                isHit: sevenNumbers.includes(n)
              })
            )
            .join('');

          const specialBall = renderBallHtml(draw.special, {
            size: 'sm',
            color: draw.colors?.[6],
            zodiac: draw.zodiacs?.[6],
            isSpecialDim: true,
            subText: `${draw.zodiacs?.[6] || ''}·特`
          });

          const recBalls = sevenNumbers
            .map((n) =>
              renderBallHtml(n, {
                size: 'sm',
                dateOrYear: draw.date,
                isHit: hitSet.has(n),
                subText: ''
              })
            )
            .join('');

          // 展开抽屉里的三中三命中组合明细
          const winning3ListHtml =
            compoundEval.pick3.winningCombos.length > 0
              ? compoundEval.pick3.winningCombos
                  .map(
                    (c) =>
                      `<span class="tag tag-win" style="margin: 2px;">★ [${c.nums.map(pad2).join(' · ')}]</span>`
                  )
                  .join('')
              : `<span style="color: var(--text-muted); font-size: 0.8rem;">当期命中正码 ${matchedNormalCount} 个，未满 3 个正码（需 ≥3 个正码方可成组三中三）</span>`;

          const winning4ListHtml =
            compoundEval.pick4.winningCombos.length > 0
              ? compoundEval.pick4.winningCombos
                  .map(
                    (c) =>
                      `<span class="tag tag-gold" style="margin: 2px;">★ [${c.nums.map(pad2).join(' · ')}]</span>`
                  )
                  .join('')
              : `<span style="color: var(--text-muted); font-size: 0.8rem;">未满 4 个正码</span>`;

          return `
            <div class="history-item ${isHit4 ? 'item-hit4' : isHit3 ? 'item-hit3' : ''}">
              <div class="history-row-main">
                <div style="min-width: 155px;">
                  <div style="font-weight: 800; font-size: 0.94rem; color: #f8fafc;">
                    ${draw.year}年 第<span style="color: #fbbf24;">${draw.period}</span>期
                  </div>
                  <div style="font-size: 0.76rem; color: var(--text-secondary);">开奖时间: ${draw.date}</div>
                </div>

                <div>
                  <div style="font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 3px;">开奖号码（平一～平六 + 特码）：</div>
                  <div class="ball-row">
                    ${drawNormalBalls}
                    <span class="ball-plus">+</span>
                    ${specialBall}
                  </div>
                </div>

                <div>
                  <div style="font-size: 0.72rem; color: var(--text-secondary); margin-bottom: 3px;">当期7码复式推荐：</div>
                  <div class="ball-row">${recBalls}</div>
                </div>

                <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 5px; min-width: 190px;">
                  <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    <span class="tag ${matchedNormalCount >= 3 ? 'tag-win' : 'tag-muted'}">
                      中 ${matchedNormalCount} 正码
                    </span>
                    <span class="tag ${active3.winCount > 0 ? 'tag-win' : 'tag-muted'}">
                      三中三: ${active3.winCount} 注
                    </span>
                    ${
                      active4.winCount > 0
                        ? `<span class="tag tag-gold">四中四: ${active4.winCount} 注</span>`
                        : ''
                    }
                  </div>
                  <div style="font-size: 0.82rem; font-weight: 700; color: ${
                    active3.netProfit >= 0 ? '#34d399' : '#94a3b8'
                  };">
                    三中三净收益: ${formatMoney(active3.netProfit)}
                  </div>
                  <div style="display: flex; gap: 6px;">
                    <button type="button" class="btn btn-sm" data-toggle-hist-detail="${draw.id}">
                      ${isOpen ? '收起命中明细 ▲' : '三中三命中明细 ▼'}
                    </button>
                    <button type="button" class="btn btn-sm" data-jump-period="${draw.id}">
                      在选号页打开
                    </button>
                  </div>
                </div>
              </div>

              <div class="history-detail-drawer ${isOpen ? 'open' : ''}" id="drawer-${draw.id}">
                <div class="grid-2" style="font-size: 0.82rem;">
                  <div style="background: #111827; padding: 10px 12px; border-radius: 8px;">
                    <div style="font-weight: 700; margin-bottom: 6px; color: #34d399;">
                      ✓ 7码复式「三中三」中奖组合明细（C(${matchedNormalCount},3) = ${compoundEval.pick3.winCount} 注）：
                    </div>
                    <div>${winning3ListHtml}</div>
                    <div style="margin-top: 8px; font-weight: 700; color: #fbbf24;">
                      ✓ 7码复式「四中四」中奖组合明细（C(${matchedNormalCount},4) = ${compoundEval.pick4.winCount} 注）：
                    </div>
                    <div>${winning4ListHtml}</div>
                  </div>
                  <div style="background: #111827; padding: 10px 12px; border-radius: 8px;">
                    <div style="font-weight: 700; margin-bottom: 6px;">当期收益账单明细：</div>
                    <div>• 命中正码：${
                      matchedNormals.length > 0 ? matchedNormals.map(pad2).join(', ') : '无'
                    } ${
                      rec.specialMatched
                        ? `<span style="color:#f59e0b;">(注：选号含特码 ${pad2(draw.special)}，按规不计入连码)</span>`
                        : ''
                    }</div>
                    <div>• 7码复式三中三：投 ${compoundEval.pick3.cost} 元 → 奖 ${compoundEval.pick3.payout} 元 → 净利 <b>${formatMoney(compoundEval.pick3.netProfit)}</b></div>
                    <div>• 7码复式四中四：投 ${compoundEval.pick4.cost} 元 → 奖 ${compoundEval.pick4.payout} 元 → 净利 <b>${formatMoney(compoundEval.pick4.netProfit)}</b></div>
                    <div>• 精选5注三中三：命中 <b>${rec.direct3Eval.winCount} / 5 注</b> → 净利 <b>${formatMoney(rec.direct3Eval.netProfit)}</b></div>
                  </div>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
    }
  }

  const pageWrap = document.getElementById('historyPaginationWrap');
  if (pageWrap) {
    pageWrap.style.display =
      filteredRecords.length > state.historyVisibleCount ? 'block' : 'none';
  }
}

/* ==================== 模块四：数据同步渲染 ==================== */

function renderSyncModule() {
  const kpiEl = document.getElementById('syncStatsKpi');
  if (!kpiEl) return;

  const latest = state.allDraws[0];
  const years = Array.from(new Set(state.allDraws.map((d) => d.year))).sort((a, b) => b - a);

  kpiEl.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">底库总期数</div>
      <div class="kpi-value gold">${state.allDraws.length} 期</div>
      <div class="kpi-sub">覆盖年份: ${years.join(', ')}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">最新开奖期号</div>
      <div class="kpi-value">${latest ? `${latest.year}-${latest.period}` : 'N/A'}</div>
      <div class="kpi-sub">开奖日期: ${latest ? latest.date : '-'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">本地增量/导入记录</div>
      <div class="kpi-value positive">${state.localDraws.length} 期</div>
      <div class="kpi-sub">内置基础底库: ${state.baseDraws.length} 期</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">定时同步源</div>
      <div class="kpi-value" style="font-size: 0.9rem; word-break: break-all;">2026kj.zkclhb.com:2025</div>
      <div class="kpi-sub">GitHub Actions 每日自动抓取</div>
    </div>
  `;
}

/* ==================== 事件绑定与初始化 ==================== */

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.module-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });

  if (tabName === 'daily') renderDailyModule();
  else if (tabName === 'entry') renderEntryModule();
  else if (tabName === 'history') renderHistoryModule();
  else if (tabName === 'sync') renderSyncModule();
}

function bindEvents() {
  // 顶部 4 模块切换
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchTab(btn.dataset.tab);
    });
  });

  // 全局本金与赔率配置实时更新
  const updateOddsFromInputs = () => {
    const stake = Math.max(1, Number(document.getElementById('cfgStake')?.value || 10));
    const odds3 = Math.max(1, Number(document.getElementById('cfgOdds3')?.value || 650));
    const odds4 = Math.max(1, Number(document.getElementById('cfgOdds4')?.value || 7500));
    state.config.stake = stake;
    state.config.odds3 = odds3;
    state.config.odds4 = odds4;
    saveConfig();
    if (state.activeTab === 'daily') renderDailyModule();
    else if (state.activeTab === 'entry') renderEntryModule();
    else if (state.activeTab === 'history') renderHistoryModule();
  };

  ['cfgStake', 'cfgOdds3', 'cfgOdds4'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', updateOddsFromInputs);
  });

  document.getElementById('btnResetOdds')?.addEventListener('click', () => {
    state.config.stake = DEFAULT_CONFIG.stake;
    state.config.odds3 = DEFAULT_CONFIG.odds3;
    state.config.odds4 = DEFAULT_CONFIG.odds4;
    saveConfig();
    renderHeaderStatus();
    updateOddsFromInputs();
    showToast('已恢复默认本金(10元)与赔率(650x / 7500x)');
  });

  // 模块1：期号下拉选择
  document.getElementById('dailyPeriodSelect')?.addEventListener('change', (e) => {
    state.selectedPeriodKey = e.target.value;
    state.pinnedPicks = [];
    const { target } = getSelectedPeriodContext();
    const plan = generatePeriodPlan(state.allDraws, target, {
      strategyId: state.activeStrategyId
    });
    state.customPicks = plan.primary7.slice();
    renderDailyModule();
  });

  document.getElementById('btnJumpNextPeriod')?.addEventListener('click', () => {
    state.selectedPeriodKey = 'NEXT';
    populateDailyPeriodSelect();
    const { target } = getSelectedPeriodContext();
    const plan = generatePeriodPlan(state.allDraws, target, {
      strategyId: state.activeStrategyId
    });
    state.customPicks = plan.primary7.slice();
    renderDailyModule();
    showToast('已切回最新待开期推荐');
  });

  // 双模式视图切换
  document.getElementById('schemeModeBar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.schemeViewMode = btn.dataset.mode;
    document.querySelectorAll('#schemeModeBar .seg-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    renderDailyModule();
  });

  // 复制主推方案
  document.getElementById('btnCopyPrimaryScheme')?.addEventListener('click', () => {
    const { target } = getSelectedPeriodContext();
    const plan = generatePeriodPlan(state.allDraws, target, {
      strategyId: state.activeStrategyId,
      pinnedNumbers: state.pinnedPicks
    });
    const text = [
      `【六合彩 ${target.year}年第${target.period}期 (${target.date}) 推荐方案】`,
      `▶ 主推7码复式 (35注): ${plan.primary7.map(pad2).join(' ')}`,
      `▶ 精选5注三中三: ${plan.featuredPick3.map((t) => `[${t.map(pad2).join('-')}]`).join(' ')}`,
      `▶ 精选5注四中四: ${plan.featuredPick4.map((t) => `[${t.map(pad2).join('-')}]`).join(' ')}`
    ].join('\n');
    copyText(text, '本期7码复式及精选5注方案已复制');
  });

  document.getElementById('btnCopy5Pick3')?.addEventListener('click', () => {
    const { target } = getSelectedPeriodContext();
    const plan = generatePeriodPlan(state.allDraws, target, {
      strategyId: state.activeStrategyId,
      pinnedNumbers: state.pinnedPicks
    });
    const text = plan.featuredPick3.map((t, i) => `第${i + 1}注三中三: ${t.map(pad2).join(' ')}`).join('\n');
    copyText(text, '5注三中三精选组合已复制');
  });

  document.getElementById('btnCopy5Pick4')?.addEventListener('click', () => {
    const { target } = getSelectedPeriodContext();
    const plan = generatePeriodPlan(state.allDraws, target, {
      strategyId: state.activeStrategyId,
      pinnedNumbers: state.pinnedPicks
    });
    const text = plan.featuredPick4.map((t, i) => `第${i + 1}注四中四: ${t.map(pad2).join(' ')}`).join('\n');
    copyText(text, '5注四中四精选组合已复制');
  });

  document.getElementById('btnCopyAll5Strategies')?.addEventListener('click', () => {
    const { target } = getSelectedPeriodContext();
    const plan = generatePeriodPlan(state.allDraws, target, {
      strategyId: state.activeStrategyId
    });
    const lines = [`【${target.year}年第${target.period}期 · 5组策略7码复式对比】`];
    for (const s of plan.strategies) {
      lines.push(`${s.code} ${s.name}: ${s.numbers.map(pad2).join(' ')}`);
    }
    copyText(lines.join('\n'), '5组策略方案已全部复制');
  });

  document.getElementById('btnLoadToCustomPicker')?.addEventListener('click', () => {
    const { target } = getSelectedPeriodContext();
    const plan = generatePeriodPlan(state.allDraws, target, {
      strategyId: state.activeStrategyId,
      pinnedNumbers: state.pinnedPicks
    });
    state.customPicks = plan.primary7.slice();
    renderDailyModule();
    document.getElementById('ballMatrix49')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('已将主推7码载入下方49码选号盘');
  });

  // 5 组策略卡片点击委托
  document.getElementById('strategyCardsContainer')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const stratId = btn.dataset.strategy;
    const action = btn.dataset.action;

    if (action === 'activate-strategy') {
      state.activeStrategyId = stratId;
      const { target } = getSelectedPeriodContext();
      const plan = generatePeriodPlan(state.allDraws, target, {
        strategyId: state.activeStrategyId,
        pinnedNumbers: state.pinnedPicks
      });
      state.customPicks = plan.primary7.slice();
      renderDailyModule();
      showToast(`已切换主推策略为 ${stratId}`);
    } else if (action === 'load-strategy-custom') {
      const { target } = getSelectedPeriodContext();
      const plan = generatePeriodPlan(state.allDraws, target, { strategyId: stratId });
      state.customPicks = plan.primary7.slice();
      renderDailyModule();
      showToast('已将该策略7码载入选号盘');
    }
  });

  // 49 码交互选号盘点击
  document.getElementById('ballMatrix49')?.addEventListener('click', (e) => {
    const cell = e.target.closest('.matrix-cell[data-ball]');
    if (!cell) return;
    const num = Number(cell.dataset.ball);
    if (state.customPicks.includes(num)) {
      state.customPicks = state.customPicks.filter((n) => n !== num);
      state.pinnedPicks = state.pinnedPicks.filter((n) => n !== num);
    } else {
      if (state.customPicks.length >= 7) {
        showToast('7码复式最多选择 7 个号码，请先取消一个号码或清空重选');
        return;
      }
      state.customPicks = [...state.customPicks, num].sort((a, b) => a - b);
    }
    renderDailyModule();
  });

  // 点击已选号码球切换胆码锁定
  document.getElementById('customSelectedBallsRow')?.addEventListener('click', (e) => {
    const wrap = e.target.closest('[data-toggle-pin]');
    if (!wrap) return;
    const num = Number(wrap.dataset.togglePin);
    if (state.pinnedPicks.includes(num)) {
      state.pinnedPicks = state.pinnedPicks.filter((n) => n !== num);
      showToast(`已取消号码 ${pad2(num)} 的胆码锁定`);
    } else {
      if (state.pinnedPicks.length >= 6) {
        showToast('最多可锁定 6 个胆码');
        return;
      }
      state.pinnedPicks = [...state.pinnedPicks, num].sort((a, b) => a - b);
      showToast(`已锁定胆码 ${pad2(num)}`);
    }
    renderDailyModule();
  });

  // 按策略智能补齐 7 码
  document.getElementById('btnAutoFillByStrategy')?.addEventListener('click', () => {
    const stratId = document.getElementById('pickerStrategySelect')?.value || 'composite';
    const { target } = getSelectedPeriodContext();
    const plan = generatePeriodPlan(state.allDraws, target, {
      strategyId: stratId,
      pinnedNumbers: state.pinnedPicks
    });
    state.customPicks = plan.primary7.slice();
    renderDailyModule();
    showToast(`已按策略补齐 7 码 [${state.customPicks.map(pad2).join(' ')}]`);
  });

  document.getElementById('btnClearCustomPicks')?.addEventListener('click', () => {
    state.customPicks = [];
    state.pinnedPicks = [];
    renderDailyModule();
  });

  // 模拟开奖正码试算
  document.getElementById('btnRunSimCalc')?.addEventListener('click', () => {
    const raw = document.getElementById('simNormalInput')?.value || '';
    const nums = [...raw.matchAll(/\b(0?[1-9]|[1-4]\d)\b/g)].map((m) => Number(m[1]));
    const norm = normalizeNumbers(nums, { sort: false, maxCount: 6 });
    if (norm.length === 0) {
      state.simNormals = [];
      renderDailyModule();
      showToast('已清除模拟正码，恢复默认期号核对');
      return;
    }
    state.simNormals = norm;
    renderDailyModule();
    showToast(`已按模拟正码 [${norm.map(pad2).join(' ')}] 核算 35 注命中明细`);
  });

  document.getElementById('btnUsePeriodDrawForSim')?.addEventListener('click', () => {
    const { draw } = getSelectedPeriodContext();
    const targetDraw = draw || state.allDraws[0];
    if (!targetDraw) return;
    state.simNormals = targetDraw.numbers.slice(0, 6);
    const input = document.getElementById('simNormalInput');
    if (input) input.value = state.simNormals.map(pad2).join(' ');
    renderDailyModule();
    showToast(`已填入 ${targetDraw.year}-${targetDraw.period} 期 6 个正码`);
  });

  // 35 注三中三 / 四中四 Tab 切换
  document.getElementById('comboExpandTabBar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    state.comboExpandTab = btn.dataset.play;
    document.querySelectorAll('#comboExpandTabBar .seg-btn').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    renderDailyModule();
  });

  // ==================== 模块2：录入开奖事件 ====================
  document.getElementById('entryBallKeypad')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-entry-ball]');
    if (!btn) return;
    const n = Number(btn.dataset.entryBall);
    if (state.entryBalls.includes(n)) {
      state.entryBalls = state.entryBalls.filter((x) => x !== n);
    } else {
      if (state.entryBalls.length >= 7) {
        showToast('已选满 6 个正码 + 1 个特码（共 7 球）');
        return;
      }
      state.entryBalls.push(n);
    }
    renderEntryModule();
  });

  document.getElementById('entrySlotsPreview')?.addEventListener('click', (e) => {
    const slot = e.target.closest('[data-remove-entry-idx]');
    if (!slot) return;
    const idx = Number(slot.dataset.removeEntryIdx);
    state.entryBalls.splice(idx, 1);
    renderEntryModule();
  });

  document.getElementById('btnClearEntryBalls')?.addEventListener('click', () => {
    state.entryBalls = [];
    renderEntryModule();
  });

  document.getElementById('btnParseQuickEntry')?.addEventListener('click', () => {
    const raw = document.getElementById('entryQuickLine')?.value || '';
    const nums = [...raw.matchAll(/\b(0?[1-9]|[1-4]\d)\b/g)].map((m) => Number(m[1]));
    const unique = normalizeNumbers(nums, { sort: false, maxCount: 7 });
    if (unique.length < 6) {
      showToast('请至少输入 6 个不重复的正码（1~49）');
      return;
    }
    state.entryBalls = unique;
    renderEntryModule();
    showToast(`已解析填入 ${unique.length} 个开奖球号`);
  });

  ['entryYear', 'entryPeriod', 'entryDate'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => renderEntryModule());
  });

  document.getElementById('btnSaveDrawEntry')?.addEventListener('click', () => {
    const year = Number(document.getElementById('entryYear')?.value || 2026);
    const periodNum = Number(document.getElementById('entryPeriod')?.value || 297);
    const date = document.getElementById('entryDate')?.value || '2026-10-24';

    if (state.entryBalls.length < 7) {
      showToast('请选满 6 个正码 + 1 个特码（共 7 个号码）后再保存');
      return;
    }

    const record = normalizeDrawRecord({
      year,
      periodNum,
      date,
      numbers: state.entryBalls.slice(0, 6),
      special: state.entryBalls[6]
    });

    if (!record) {
      showToast('开奖数据格式有误，请检查号码范围 (01~49)');
      return;
    }

    const { merged } = mergeDraws(state.localDraws, [record]);
    state.localDraws = merged;
    saveLocalDraws();
    rebuildMergedDraws();
    renderHeaderStatus();
    populateDailyPeriodSelect();

    // 自动选中刚录入的期号并展示结果
    state.selectedPeriodKey = record.id;
    document.getElementById('dailyPeriodSelect').value = record.id;

    state.entryBalls = [];
    initEntryModuleDefaults();
    renderEntryModule();
    showToast(`✅ 已保存 ${record.year}-${record.period} 期开奖记录并完成三中三核对！`);
  });

  document.getElementById('localCustomDrawsList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delete-local-id]');
    if (!btn) return;
    const id = btn.dataset.deleteLocalId;
    state.localDraws = state.localDraws.filter((d) => d.id !== id);
    saveLocalDraws();
    rebuildMergedDraws();
    renderHeaderStatus();
    populateDailyPeriodSelect();
    renderEntryModule();
    showToast(`已移除本地记录 ${id}`);
  });

  document.getElementById('btnClearLocalEntries')?.addEventListener('click', () => {
    state.localDraws = [];
    saveLocalDraws();
    rebuildMergedDraws();
    renderHeaderStatus();
    populateDailyPeriodSelect();
    renderEntryModule();
    showToast('已清空本地新增开奖记录');
  });

  // ==================== 模块3：历史回放事件 ====================
  [
    'histYearFilter',
    'histLimitFilter',
    'histStrategyFilter',
    'histBetModeFilter',
    'histHitFilter'
  ].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      state.historyVisibleCount = state.historyPageSize;
      renderHistoryModule();
    });
  });

  document.getElementById('histSearchInput')?.addEventListener('input', () => {
    state.historyVisibleCount = state.historyPageSize;
    renderHistoryModule();
  });

  document.getElementById('btnLoadMoreHistory')?.addEventListener('click', () => {
    state.historyVisibleCount += state.historyPageSize;
    renderHistoryModule();
  });

  document.getElementById('btnUseCustom7InBacktest')?.addEventListener('click', () => {
    const sel = document.getElementById('histStrategyFilter');
    if (sel) sel.value = 'custom';
    state.historyVisibleCount = state.historyPageSize;
    renderHistoryModule();
    showToast(`正在使用当前选号盘 [${state.customPicks.map(pad2).join(' ')}] 回测历史正码命中`);
  });

  document.getElementById('historyRecordsContainer')?.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-toggle-hist-detail]');
    if (toggleBtn) {
      const id = toggleBtn.dataset.toggleHistDetail;
      if (state.openHistoryDrawIds.has(id)) {
        state.openHistoryDrawIds.delete(id);
      } else {
        state.openHistoryDrawIds.add(id);
      }
      renderHistoryModule();
      return;
    }

    const jumpBtn = e.target.closest('[data-jump-period]');
    if (jumpBtn) {
      const id = jumpBtn.dataset.jumpPeriod;
      state.selectedPeriodKey = id;
      populateDailyPeriodSelect();
      switchTab('daily');
      showToast(`已跳转至 ${id} 期详情`);
    }
  });

  // ==================== 模块4：数据同步事件 ====================
  document.getElementById('btnSyncRepoJson')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('syncActionStatus');
    if (statusEl) statusEl.textContent = '正在从 ./data/draws.json 拉取最新底库...';
    try {
      const res = await fetch(`./data/draws.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming = Array.isArray(data.draws) ? data.draws : [];
      const { merged, addedCount, updatedCount } = mergeDraws(state.baseDraws, incoming);
      state.baseDraws = merged;
      rebuildMergedDraws();
      renderHeaderStatus();
      populateDailyPeriodSelect();
      renderSyncModule();
      if (statusEl) {
        statusEl.innerHTML = `<span style="color: #34d399;">✓ 同步成功！底库共 ${state.allDraws.length} 期（本次新增 ${addedCount} 期，更新 ${updatedCount} 期）。</span>`;
      }
      showToast('底库刷新成功');
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `<span style="color: #fbbf24;">本地离线模式已就绪（当前使用内置 ${state.allDraws.length} 期底库）。</span>`;
      }
    }
  });

  document.getElementById('btnTryFetchRemoteAm')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('syncActionStatus');
    const targetUrl = DEFAULT_CONFIG.remoteSourceUrl;
    if (statusEl) {
      statusEl.textContent = `正在尝试抓取 ${targetUrl} ...`;
    }

    const candidateUrls = [
      targetUrl,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`,
      `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`
    ];

    let htmlText = '';
    for (const u of candidateUrls) {
      try {
        const res = await fetch(u, { cache: 'no-store' });
        if (res.ok) {
          const t = await res.text();
          if (t && t.includes('期(开奖时间:')) {
            htmlText = t;
            break;
          }
        }
      } catch {
        // 继续尝试下一个候选或引导粘贴兜底
      }
    }

    if (htmlText) {
      const parsed = parseDrawsInput(htmlText);
      const { merged, addedCount } = mergeDraws(state.localDraws, parsed);
      state.localDraws = merged;
      saveLocalDraws();
      rebuildMergedDraws();
      renderHeaderStatus();
      populateDailyPeriodSelect();
      renderSyncModule();
      if (statusEl) {
        statusEl.innerHTML = `<span style="color: #34d399;">✓ 成功从远程抓取并解析 ${parsed.length} 期记录（新增 ${addedCount} 期）！</span>`;
      }
      showToast(`远程同步成功：解析 ${parsed.length} 期`);
    } else {
      if (statusEl) {
        statusEl.innerHTML = `<span style="color: #fbbf24;">⚠️ 浏览器跨域限制或目标端口 :2025 拦截了前端直连。请使用右侧「粘贴导入兜底」或由 GitHub Actions 定时任务在服务端抓取更新。</span>`;
      }
      showToast('已切换至右侧粘贴导入兜底模式');
    }
  });

  document.getElementById('btnExportDrawsJson')?.addEventListener('click', () => {
    const payload = {
      updatedAt: new Date().toISOString(),
      source: DEFAULT_CONFIG.remoteSourceUrl,
      totalCount: state.allDraws.length,
      latestId: state.allDraws[0]?.id || null,
      draws: state.allDraws
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `draws-${state.allDraws[0]?.id || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`已导出完整底库 JSON (${state.allDraws.length} 期)`);
  });

  // 粘贴导入兜底解析合并
  document.getElementById('btnParseAndMergePaste')?.addEventListener('click', () => {
    const raw = document.getElementById('pasteImportTextarea')?.value || '';
    const msgEl = document.getElementById('pasteParseResultMsg');
    const parsed = parseDrawsInput(raw);

    if (parsed.length === 0) {
      if (msgEl) {
        msgEl.style.color = '#f87171';
        msgEl.textContent = '❌ 未能识别出有效开奖记录，请检查格式（需含期号与 6正码+1特码）';
      }
      showToast('未解析到有效开奖记录');
      return;
    }

    const beforeTotal = state.allDraws.length;
    const { merged: newLocal } = mergeDraws(state.localDraws, parsed);
    state.localDraws = newLocal;
    saveLocalDraws();
    rebuildMergedDraws();
    const netAdded = state.allDraws.length - beforeTotal;

    renderHeaderStatus();
    populateDailyPeriodSelect();
    renderSyncModule();

    if (msgEl) {
      msgEl.style.color = '#34d399';
      msgEl.textContent = `✓ 解析成功 ${parsed.length} 期（底库净增 ${netAdded} 期，当前总计 ${state.allDraws.length} 期）`;
    }
    showToast(`✅ 成功导入 ${parsed.length} 期开奖数据！`);
  });

  document.getElementById('btnFillDemoPaste')?.addEventListener('click', () => {
    const nextMeta = getNextDrawMeta();
    const ta = document.getElementById('pasteImportTextarea');
    if (ta) {
      ta.value = `${nextMeta.periodNum}期(开奖时间:${nextMeta.date})\n08 猪 14 蛇 23 猴 26 蛇 31 鼠 45 狗 12 羊`;
    }
  });

  document.getElementById('btnClearPasteBox')?.addEventListener('click', () => {
    const ta = document.getElementById('pasteImportTextarea');
    const msgEl = document.getElementById('pasteParseResultMsg');
    if (ta) ta.value = '';
    if (msgEl) msgEl.textContent = '';
  });

  // 文件上传导入 (.html / .json / .txt)
  document.getElementById('syncFileInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseDrawsInput(text);
    const msgEl = document.getElementById('pasteParseResultMsg');

    if (parsed.length === 0) {
      showToast(`文件 ${file.name} 未解析出开奖记录`);
      return;
    }

    const beforeTotal = state.allDraws.length;
    const { merged: newLocal } = mergeDraws(state.localDraws, parsed);
    state.localDraws = newLocal;
    saveLocalDraws();
    rebuildMergedDraws();
    const netAdded = state.allDraws.length - beforeTotal;

    renderHeaderStatus();
    populateDailyPeriodSelect();
    renderSyncModule();

    if (msgEl) {
      msgEl.style.color = '#34d399';
      msgEl.textContent = `✓ 从文件 ${file.name} 导入 ${parsed.length} 期（净增 ${netAdded} 期）`;
    }
    showToast(`已从 ${file.name} 成功导入 ${parsed.length} 期记录`);
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {
        // ignore sw errors in restricted environments
      });
    });
  }
}

function initApp() {
  loadSavedState();
  renderHeaderStatus();
  populateDailyPeriodSelect();
  initEntryModuleDefaults();
  bindEvents();
  renderDailyModule();
  registerServiceWorker();
}

initApp();
