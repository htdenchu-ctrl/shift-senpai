import React, { useState, useMemo, useEffect } from 'react';
import { Calendar, Users, Settings, Sparkles, AlertTriangle, Plus, Trash2, ChevronLeft, ChevronRight, Check, X, BarChart3, Coffee, Download, Smartphone } from 'lucide-react';

// ============== LocalStorage ヘルパー (データ永続化) ==============
// データ構造のバージョン。フォーマットを変えるときはここを上げる
const STORAGE_VERSION = 'v1';
const STORAGE_KEY_PREFIX = `shiftAtelier_${STORAGE_VERSION}_`;

// 安全に読み込み(失敗時はnull返却)
const loadFromStorage = (key, fallback) => {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`localStorage読込失敗 (${key}):`, e);
    return fallback;
  }
};

// 安全に保存(失敗時はサイレントスキップ)
const saveToStorage = (key, value) => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(STORAGE_KEY_PREFIX + key, JSON.stringify(value));
  } catch (e) {
    console.warn(`localStorage保存失敗 (${key}):`, e);
  }
};

// 全データをクリア (リセットボタン用)
const clearAllStorage = () => {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const keys = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(STORAGE_KEY_PREFIX)) keys.push(k);
    }
    keys.forEach(k => window.localStorage.removeItem(k));
  } catch (e) {
    console.warn('localStorageクリア失敗:', e);
  }
};

// ============== 型・定数 ==============
const SHIFT_TYPES = {
  EARLY: { id: 'EARLY', label: '早番', time: '9:30-18:30', short: '早', color: 'amber' },
  MAMA: { id: 'MAMA', label: 'ママさん早番', time: '9:30-16:30', short: '早M', color: 'rose' },
  MIDDLE: { id: 'MIDDLE', label: '中番', time: '10:30-19:30', short: '中', color: 'emerald' },
  LATE: { id: 'LATE', label: '遅番', time: '11:30-20:30', short: '遅', color: 'sky' },
  OFF: { id: 'OFF', label: '休', time: '', short: '休', color: 'stone' },
  REQUEST_OFF: { id: 'REQUEST_OFF', label: '希望休', time: '', short: '希', color: 'stone' },
  // 半休: 0.5日休扱い・出勤としてカウント・時間帯はマスのメモで個別記入
  HALF_OFF: { id: 'HALF_OFF', label: '半休', time: '', short: '半', color: 'teal' },
  // MT(ミーティング): 必出。時間帯はマスのメモで個別に管理(早/中/遅の区別なし)
  MT: { id: 'MT', label: 'MT', time: '', short: 'MT', color: 'violet' },
  // 出張: 出勤扱いだが店舗の必要人数にはカウントしない
  TRIP: { id: 'TRIP', label: '出張', time: '', short: '出張', color: 'indigo' },
  HELP_EARLY: { id: 'HELP_EARLY', label: 'ヘルプ早番', time: '9:30-18:30', short: '早', color: 'yellow', isHelp: true },
  HELP_MAMA: { id: 'HELP_MAMA', label: 'ヘルプママ早', time: '9:30-16:30', short: '早M', color: 'yellow', isHelp: true },
  HELP_MIDDLE: { id: 'HELP_MIDDLE', label: 'ヘルプ中番', time: '10:30-19:30', short: '中', color: 'yellow', isHelp: true },
  HELP_LATE: { id: 'HELP_LATE', label: 'ヘルプ遅番', time: '11:30-20:30', short: '遅', color: 'yellow', isHelp: true },
};

// MTかどうか(後方互換で MT_EARLY/MT_MIDDLE/MT_LATE もMT扱い)
const isMTShift = (s) => s === 'MT' || s === 'MT_EARLY' || s === 'MT_MIDDLE' || s === 'MT_LATE';
// 旧形式のMT値を新形式の 'MT' に正規化する
const normalizeMTValue = (s) => isMTShift(s) ? 'MT' : s;
// 半休かどうか
const isHalfOff = (s) => s === 'HALF_OFF';
// ヘルプかどうかの判定ヘルパー
const isHelpShift = (s) => s && s.startsWith('HELP_');
// 出張かどうか
const isTripShift = (s) => s === 'TRIP';
// 通常出勤判定（OFF/REQUEST_OFFでもヘルプでもMT以外でもない、純粋な勤務）
const isWorkShift = (s) => s && s !== 'OFF' && s !== 'REQUEST_OFF' && !isHelpShift(s);
// 出勤扱い（連勤計算には使わない、集計用）
const isAnyWork = (s) => s && s !== 'OFF' && s !== 'REQUEST_OFF';
// 店舗の必要人数充足にカウントされる出勤か(出張は除外)
const isStoreWorkShift = (s) => isWorkShift(s) && !isTripShift(s);

const STAFF_TYPE = { EMPLOYEE: 'EMPLOYEE', MAMA: 'MAMA' };

// ============== 日付ユーティリティ ==============
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

const getShiftPeriod = (year, month) => {
  // month: 1-12（11日始まりの月を表す。例: month=4 → 4/11〜5/10）
  const start = new Date(year, month - 1, 11);
  const end = new Date(year, month, 10);
  const days = [];
  const cur = new Date(start);
  while (cur <= end) {
    days.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return { start, end, days };
};

const dayOfWeekJa = ['日','月','火','水','木','金','土'];

// ============== 曜日ごとの必要人数デフォルト ==============
// 構造: { 0-6: 数, holiday: 数 }  キー0=日, 6=土, holiday=祝日
const DEFAULT_REQUIRED_BY_DOW = { 0: 3, 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 4, holiday: 3 };

// 後方互換用 (旧コードが defaultRequiredByDow[dow] で参照する箇所をそのまま動かすため)
const defaultRequiredByDow = DEFAULT_REQUIRED_BY_DOW;

// 必要人数を取得するヘルパー
// (date, requiredByDate, dowConfig) → 数値
const getRequiredFor = (date, requiredByDate, dowConfig) => {
  const ds = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  if (requiredByDate[ds] !== undefined) return requiredByDate[ds];
  const cfg = dowConfig || DEFAULT_REQUIRED_BY_DOW;
  if (isHoliday(date) && cfg.holiday !== undefined) return cfg.holiday;
  return cfg[date.getDay()] ?? 3;
};

// ============== 日本の祝日（拡充版: 固定祝日 + ハッピーマンデー + 春分秋分 + 振替休日） ==============
// 春分・秋分の計算 (Newcomb の式の近似版で 1980〜2099 まで有効)
const _vernalDay = (year) => {
  if (year >= 1900 && year <= 1979) return Math.floor(20.8357 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  if (year >= 1980 && year <= 2099) return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  if (year >= 2100 && year <= 2150) return Math.floor(21.851 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  return 20;
};
const _autumnDay = (year) => {
  if (year >= 1900 && year <= 1979) return Math.floor(23.2588 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  if (year >= 1980 && year <= 2099) return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  if (year >= 2100 && year <= 2150) return Math.floor(24.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  return 23;
};
// 第N週の指定曜日
const _nthWeekday = (year, month, week, weekday) => {
  const first = new Date(year, month - 1, 1);
  const firstDow = first.getDay();
  let day = 1 + (weekday - firstDow + 7) % 7 + (week - 1) * 7;
  return day;
};

// 指定日が祝日かどうか判定
const _isHolidayCore = (year, month, day) => {
  // 固定祝日
  const fixed = [
    [1, 1],   // 元日
    [2, 11],  // 建国記念の日
    [2, 23],  // 天皇誕生日 (2020年〜)
    [4, 29],  // 昭和の日
    [5, 3],   // 憲法記念日
    [5, 4],   // みどりの日
    [5, 5],   // こどもの日
    [8, 11],  // 山の日
    [11, 3],  // 文化の日
    [11, 23], // 勤労感謝の日
  ];
  if (fixed.some(([m, d]) => m === month && d === day)) return true;
  // ハッピーマンデー
  if (month === 1 && day === _nthWeekday(year, 1, 2, 1)) return true; // 成人の日 (1月第2月曜)
  if (month === 7 && day === _nthWeekday(year, 7, 3, 1)) return true; // 海の日 (7月第3月曜)
  if (month === 9 && day === _nthWeekday(year, 9, 3, 1)) return true; // 敬老の日 (9月第3月曜)
  if (month === 10 && day === _nthWeekday(year, 10, 2, 1)) return true; // スポーツの日 (10月第2月曜)
  // 春分の日・秋分の日
  if (month === 3 && day === _vernalDay(year)) return true;
  if (month === 9 && day === _autumnDay(year)) return true;
  // 国民の休日 (春分/秋分が火曜の場合、その前日の月曜が祝日となる "国民の休日" になることもあるが、レアケースなので省略)
  return false;
};

const isHoliday = (d) => {
  const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
  if (_isHolidayCore(y, m, day)) return true;
  // 振替休日: 「日曜と重なった祝日があったとき、その後最初の平日(=非祝日)を振替休日とする」
  // この日が振替休日候補(月〜) で、過去をさかのぼって日曜の祝日にぶつかるかチェック
  // 月曜以降を遡り、祝日が連続している間さかのぼり、最後の祝日が日曜なら振替成立
  if (d.getDay() >= 1) {
    let cur = new Date(d);
    cur.setDate(cur.getDate() - 1);
    while (cur.getDay() !== 0) {
      // 連続祝日でない場合はループ終了
      if (!_isHolidayCore(cur.getFullYear(), cur.getMonth() + 1, cur.getDate())) {
        return false;
      }
      cur.setDate(cur.getDate() - 1);
    }
    // 日曜にたどり着いた、その日が祝日なら振替成立
    if (_isHolidayCore(cur.getFullYear(), cur.getMonth() + 1, cur.getDate())) {
      return true;
    }
  }
  return false;
};

// ============== シフト自動生成ロジック ==============
// exemptions: 制約免除リスト
//   { allowFiveDay: { [staffId_dateStr]: true },     // 5連勤超過を許可
//     allowFourthRule: { [staffId_dateStr]: true } } // 4連勤の月1回上限を超えて許可
// manualLocks: 手動編集ロック { [staffId]: { [dateStr]: shiftValue } }
const generateShifts = (staff, days, requiredByDate, fixedShifts, exemptions = {}, manualLocks = {}) => {
  const exAllowFiveDay = exemptions.allowFiveDay || {};
  const exAllowFourthRule = exemptions.allowFourthRule || {};

  const result = {};
  staff.forEach(s => { result[s.id] = {}; });

  const dateStrs = days.map(fmt);

  // Step 1: 希望休・MT・出張と手動ロックを最初に反映
  staff.forEach(s => {
    dateStrs.forEach(ds => {
      const fx = fixedShifts[s.id]?.[ds];
      if (fx === 'REQUEST_OFF') result[s.id][ds] = 'REQUEST_OFF';
      else if (isMTShift(fx)) {
        // 旧形式(MT_EARLY/MIDDLE/LATE)も含めて 'MT' に統一
        result[s.id][ds] = 'MT';
      }
      else if (fx === 'TRIP') result[s.id][ds] = 'TRIP';
      // 手動ロックは fixedShifts より優先(MT系は新形式に正規化)
      const lock = manualLocks[s.id]?.[ds];
      if (lock) result[s.id][ds] = isMTShift(lock) ? 'MT' : lock;
    });
  });

  // 各スタッフの連勤数チェック関数
  const getConsecutiveWork = (staffId, untilIdx) => {
    let count = 0;
    for (let i = untilIdx; i >= 0; i--) {
      const s = result[staffId][dateStrs[i]];
      if (s && s !== 'OFF' && s !== 'REQUEST_OFF') count++;
      else break;
    }
    return count;
  };

  // 4連勤の発生回数
  const getFourConsecCount = (staffId) => {
    let count = 0, run = 0;
    for (let i = 0; i < dateStrs.length; i++) {
      const s = result[staffId][dateStrs[i]];
      if (s && s !== 'OFF' && s !== 'REQUEST_OFF') {
        run++;
        if (run === 4) count++;
      } else {
        run = 0;
      }
    }
    return count;
  };

  // 既存の勤務日数
  const getWorkDays = (staffId) => {
    return dateStrs.filter(ds => {
      const s = result[staffId][ds];
      return s && s !== 'OFF' && s !== 'REQUEST_OFF';
    }).length;
  };

  // 残り出勤可能日数（i日目以降で、まだ何も割り当たっていない＝希望休でもMTでも出張でもない日数）
  const getRemainingAvailableDays = (staffId, fromIdx) => {
    let count = 0;
    for (let j = fromIdx; j < dateStrs.length; j++) {
      const v = result[staffId][dateStrs[j]];
      if (!v) count++; // 未割当
      else if (v !== 'OFF' && v !== 'REQUEST_OFF' && !isMTShift(v) && v !== 'TRIP') count++; // 仮割当（再考慮）
    }
    return count;
  };

  // 各スタッフの目標出勤日数を算出
  // 上限: 期間日数 - 最低休日数（休日数が最低を下回らないように）
  // 下限: 期間日数 - 最大休日数（休日数が最大を超えないように）
  const totalDays = dateStrs.length;
  const staffTargets = {};      // 目標出勤上限
  const staffMinTargets = {};   // 目標出勤下限（これを下回らせない）
  staff.forEach(s => {
    const minOff = s.minOffDays ?? 8;
    const maxOff = s.maxOffDays ?? totalDays; // 未設定なら制約なし
    const requestOffCount = dateStrs.filter(ds => result[s.id][ds] === 'REQUEST_OFF').length;
    // MT/出張は既に出勤確定なのでカウント対象（追加割当の目標から差し引く）
    const mtTripCount = dateStrs.filter(ds => {
      const v = result[s.id][ds];
      return isMTShift(v) || v === 'TRIP';
    }).length;
    // 最大出勤日数（最低休日数を確保した残り。希望休も休日にカウント）
    const maxWorkDays = totalDays - Math.max(minOff, requestOffCount);
    // 最低出勤日数（最大休日数を超えないように）
    const minWorkDays = Math.max(0, totalDays - maxOff);
    // MT/出張は既に出勤確定なので、追加で割り当てる目標数
    staffTargets[s.id] = Math.max(0, maxWorkDays - mtTripCount);
    staffMinTargets[s.id] = Math.max(0, minWorkDays - mtTripCount);
  });

  // 構造的キャパチェック: 全スタッフが最大出勤しても必要人数を満たせるか
  const totalRequired = dateStrs.reduce((sum, ds, idx) => {
    return sum + (requiredByDate[ds] ?? defaultRequiredByDow[days[idx].getDay()]);
  }, 0);
  const totalMaxCapacity = staff.reduce((sum, s) => {
    const requestOffCount = dateStrs.filter(ds => result[s.id][ds] === 'REQUEST_OFF').length;
    // 各スタッフの期間内最大出勤可能日数（最低休日数 OR 希望休数の大きい方を引く）
    const maxWork = totalDays - Math.max(s.minOffDays ?? 8, requestOffCount);
    return sum + maxWork;
  }, 0);
  // 構造的余剰がない、または最低出勤総量が必要総量を超える場合に警告フラグを立てる
  const totalMinWork = staff.reduce((sum, s) => {
    const maxOff = s.maxOffDays ?? totalDays;
    return sum + Math.max(0, totalDays - maxOff);
  }, 0);
  const structuralWarnings = {
    capacityShortage: totalMaxCapacity < totalRequired,    // 最大出勤しても足りない
    capacityShortageDetail: { totalMaxCapacity, totalRequired },
    forcedOverMax: totalMinWork > totalRequired,           // 最低出勤総量が必要数を超える(構造的に最大休日数オーバー必須)
    forcedOverMaxDetail: { totalMinWork, totalRequired },
  };

  // ============== 休前/休明け優先順位ヘルパー ==============
  // 休日(OFF/REQUEST_OFF)の前後にあたる日のシフト優先順位を決定する
  // - 休日の翌日(休明け): 遅 → 中 → 早
  // - 休日の前日(休前):   早 → 中 → 遅
  // - 両方該当(休→出→休): 中(両端を避ける)
  // - どちらでもない: null (既存のバランス計算に任せる)
  // 半休(HALF_OFF)は出勤扱いなので休日には含めない
  // 注意: 未来日は result がまだ未確定なので、fixedShifts(希望休)も併用して判定
  const isOffDay = (staffId, idx) => {
    if (idx < 0 || idx >= dateStrs.length) return false;
    const ds = dateStrs[idx];
    const v = result[staffId][ds];
    // 既に処理済みで休 or 希望休
    if (v === 'OFF' || v === 'REQUEST_OFF') return true;
    // 未処理(undefined)でも、fixedShiftsで希望休が確定している場合は休扱い
    const fx = fixedShifts[staffId]?.[ds];
    if (fx === 'REQUEST_OFF') return true;
    return false;
  };
  // 「休→出→休」の中日や「休→出」「出→休」を判定し、優先順位を返す
  // 戻り値: ['LATE','MIDDLE','EARLY'] のような優先度配列、または null(既存ロジック)
  const getShiftPriority = (staffId, dateIdx, staffType) => {
    // ママさんは早Mのみなので適用外
    if (staffType === STAFF_TYPE.MAMA) return null;
    const isAfterOff = isOffDay(staffId, dateIdx - 1);  // 前日が休
    const isBeforeOff = isOffDay(staffId, dateIdx + 1); // 翌日が休
    if (isAfterOff && isBeforeOff) {
      // 休→出→休: 中央寄り (中→早→遅)
      return ['MIDDLE', 'EARLY', 'LATE'];
    }
    if (isAfterOff) {
      // 休明け: 遅→中→早 (前日休だったので、出勤時刻は遅めに)
      return ['LATE', 'MIDDLE', 'EARLY'];
    }
    if (isBeforeOff) {
      // 休前: 早→中→遅 (翌日休なので、早く上がりたい)
      return ['EARLY', 'MIDDLE', 'LATE'];
    }
    return null; // 通常日: 既存のバランス計算に任せる
  };

  // Step 2: 各日について必要人数を満たすように割当
  const helpNeeded = {};

  for (let i = 0; i < dateStrs.length; i++) {
    const ds = dateStrs[i];
    const required = requiredByDate[ds] ?? defaultRequiredByDow[days[i].getDay()];

    // 既に確定している店舗出勤者数（MTは出勤カウント、出張は店舗にいないのでカウントしない）
    let assignedShifts = staff.map(s => result[s.id][ds]).filter(v => v && v !== 'OFF' && v !== 'REQUEST_OFF' && v !== 'TRIP');
    let currentCount = assignedShifts.length;

    const needsToAssign = required - currentCount;

    // 強制出勤判定：最大休日数を超えないようにする
    // 過去の日: 何も割当てられていない日は最終的にOFFになる予定 → 休日カウント
    //          REQUEST_OFFも休日カウント
    //          MTや実シフト割当があれば出勤カウント（休日には数えない）
    // 未来の日: REQUEST_OFFは確定休日。それ以外は不確定だが安全側評価
    // 「今日休ませた場合の最終休日数最小値 = 過去の休日数 + 1(今日) + 未来の確定休日数」
    // これが maxOff を超えるなら今日は強制出勤
    const forcedWorkers = staff.filter(s => {
      const cur = result[s.id][ds];
      if (cur) return false; // 既に割当済はスキップ
      const maxOff = s.maxOffDays;
      if (maxOff === undefined) return false;

      // 過去の休日数: 「OFF確定 + REQUEST_OFF + 未割当(=OFFになる予定)」を1日、半休を0.5日として加算
      // ※ Step2の処理中は過去日も未割当のままの場合がある
      let pastOff = 0;
      dateStrs.slice(0, i).forEach(d => {
        const v = result[s.id][d];
        if (!v || v === 'OFF' || v === 'REQUEST_OFF') pastOff += 1;
        else if (v === 'HALF_OFF') pastOff += 0.5;
      });
      // 未来の確定休日数(REQUEST_OFFを1日、HALF_OFFは0.5日)
      let futureFixedOff = 0;
      dateStrs.slice(i + 1).forEach(d => {
        const v = result[s.id][d];
        if (v === 'REQUEST_OFF') futureFixedOff += 1;
        else if (v === 'HALF_OFF') futureFixedOff += 0.5;
      });
      // 今日休みにしたとして達成可能な最小休日数
      const minPossibleOff = pastOff + 1 + futureFixedOff;
      return minPossibleOff > maxOff;
    });

    if (needsToAssign <= 0 && forcedWorkers.length === 0) continue;

    // 候補スタッフをフィルタ
    const forcedSet = new Set(forcedWorkers.map(s => s.id));

    // 既に割当済みのママさん人数をカウント
    const currentMamaCount = staff.filter(s =>
      s.type === STAFF_TYPE.MAMA && (result[s.id][ds] === 'MAMA')
    ).length;
    // 3人以下のシフト構成日はママさん1名まで（4人以上なら制限なし）
    const isMamaLimited = required <= 3;

    const candidates = staff.filter(s => {
      const cur = result[s.id][ds];
      if (cur) return false; // 既に何か割当済み

      // 3人シフトの日はママさん2人目以降を除外（強制出勤でも適用）
      if (isMamaLimited && s.type === STAFF_TYPE.MAMA && currentMamaCount >= 1) {
        return false;
      }

      // 連勤チェックは強制出勤でも必須（5連勤禁止は安全上守る）
      const exKey = `${s.id}_${dateStrs[i]}`;
      const consec = getConsecutiveWork(s.id, i - 1);
      if (consec >= 4) {
        // 5連勤になる - 免除があれば許可、強制出勤でも基本は守る
        if (!exAllowFiveDay[exKey]) return false;
      }

      // 強制出勤スタッフは4連勤の月1回ルール、最低休日数チェックは免除
      if (forcedSet.has(s.id)) {
        return true;
      }

      // 連勤例外免除がある場合も、最低休日数チェックを免除する
      // （ユーザーが「この日にこのスタッフを出勤させたい」と明示的に許可したため）
      const hasConsecExemption = exAllowFiveDay[exKey] || exAllowFourthRule[exKey];
      if (hasConsecExemption) {
        return true;
      }

      // 4連勤の月1回ルール
      if (consec === 3) {
        if (getFourConsecCount(s.id) >= 1 && !exAllowFourthRule[exKey]) return false;
      }

      // 目標出勤日数を超えるなら避ける（最低休日数の確保）
      const currentWork = getWorkDays(s.id);
      if (currentWork >= staffTargets[s.id]) return false;

      return true;
    });

    // 緊急度の高い順にソート
    // 1) 最大休日数を超えるリスクのある強制出勤スタッフを最優先
    // 2) 最低出勤日数(最大休日数からの逆算)に未達のスタッフを優先
    // 3) 残り日数で目標出勤数を達成する必要があるスタッフ優先
    // 4) 連勤数が少ない順
    // 5) 既出勤日数が少ない順
    candidates.sort((a, b) => {
      const aForced = forcedSet.has(a.id);
      const bForced = forcedSet.has(b.id);
      if (aForced !== bForced) return aForced ? -1 : 1;

      // 連勤例外免除されたスタッフを次に優先
      // （ユーザーが「この人をこの日に出勤させたい」と明示的に指定したため）
      const aExKey = `${a.id}_${dateStrs[i]}`;
      const bExKey = `${b.id}_${dateStrs[i]}`;
      const aExempt = !!(exAllowFiveDay[aExKey] || exAllowFourthRule[aExKey]);
      const bExempt = !!(exAllowFiveDay[bExKey] || exAllowFourthRule[bExKey]);
      if (aExempt !== bExempt) return aExempt ? -1 : 1;

      const aWork = getWorkDays(a.id);
      const bWork = getWorkDays(b.id);
      const aRemaining = getRemainingAvailableDays(a.id, i);
      const bRemaining = getRemainingAvailableDays(b.id, i);

      // 最低出勤日数未達ペナルティ
      const aMinNeeded = Math.max(0, staffMinTargets[a.id] - aWork);
      const bMinNeeded = Math.max(0, staffMinTargets[b.id] - bWork);
      const aMinUrgency = aRemaining > 0 ? aMinNeeded / aRemaining : 0;
      const bMinUrgency = bRemaining > 0 ? bMinNeeded / bRemaining : 0;
      if (Math.abs(aMinUrgency - bMinUrgency) > 0.01) return bMinUrgency - aMinUrgency;

      const aNeeded = staffTargets[a.id] - aWork;
      const bNeeded = staffTargets[b.id] - bWork;
      const aUrgency = aRemaining > 0 ? aNeeded / aRemaining : 0;
      const bUrgency = bRemaining > 0 ? bNeeded / bRemaining : 0;
      if (Math.abs(aUrgency - bUrgency) > 0.01) return bUrgency - aUrgency;

      const ca = getConsecutiveWork(a.id, i - 1);
      const cb = getConsecutiveWork(b.id, i - 1);
      if (ca !== cb) return ca - cb;
      return aWork - bWork;
    });

    // 必要なシフトタイプを決定（早・中・遅をバランス良く）
    // MTは時間帯10:30-19:30(中番相当)としてバランス計算に含める、出張は店舗に出ないので除外
    const hasEarly = assignedShifts.some(v => v === 'EARLY' || v === 'MAMA');
    const hasMiddle = assignedShifts.some(v => v === 'MIDDLE' || isMTShift(v));
    const hasLate = assignedShifts.some(v => v === 'LATE');

    const shiftPriority = [];
    if (!hasEarly) shiftPriority.push('EARLY');
    if (!hasLate) shiftPriority.push('LATE');
    if (!hasMiddle) shiftPriority.push('MIDDLE');
    while (shiftPriority.length < needsToAssign) {
      shiftPriority.push(['EARLY','MIDDLE','LATE'][shiftPriority.length % 3]);
    }

    let assigned = 0;
    for (const shiftType of shiftPriority) {
      if (assigned >= needsToAssign) break;
      // 動的に現在のママさん割当数をチェック（このループ内で割り当てた分も含む）
      const liveMamaCount = staff.filter(st =>
        st.type === STAFF_TYPE.MAMA && result[st.id][ds] === 'MAMA'
      ).length;

      // この shiftType を割り当てられるスタッフを探す
      // (休前/休明け優先順位はここでは使わず、Step 2.7で最適化する)
      const idx = candidates.findIndex(c => {
        // 3人シフト日でママさんが既に1人いるなら他のママさんは除外
        if (isMamaLimited && c.type === STAFF_TYPE.MAMA && liveMamaCount >= 1) {
          return false;
        }
        if (c.type === STAFF_TYPE.MAMA) {
          return shiftType === 'EARLY'; // ママさんは早番のみ
        }
        return true;
      });
      if (idx >= 0) {
        const s = candidates[idx];
        const actualShift = (s.type === STAFF_TYPE.MAMA && shiftType === 'EARLY') ? 'MAMA' : shiftType;
        result[s.id][ds] = actualShift;
        candidates.splice(idx, 1);
        assigned++;
      }
    }

    // 強制出勤スタッフでまだ未割当の人がいれば、必要人数を超えてでも追加で割り当てる
    // （最大休日数を超えないことが最優先）
    // ただし連勤上限（5連勤禁止）と「3人シフト日のママさん2人禁止」は守る
    const remainingForced = candidates.filter(c => forcedSet.has(c.id));
    for (const s of remainingForced) {
      // 連勤チェック（既に5連勤になる場合は割り当てない）
      const consec = getConsecutiveWork(s.id, i - 1);
      const exKey = `${s.id}_${dateStrs[i]}`;
      if (consec >= 4 && !exAllowFiveDay[exKey]) {
        continue; // 5連勤超過は許可されていないのでスキップ
      }

      // 3人シフト日でママさんが既に1人いるなら、ママさんの2人目は割り当てない
      if (isMamaLimited && s.type === STAFF_TYPE.MAMA) {
        const liveMamaCount = staff.filter(st =>
          st.type === STAFF_TYPE.MAMA && result[st.id][ds] === 'MAMA'
        ).length;
        if (liveMamaCount >= 1) continue;
      }

      // 早・中・遅の中でその時点で人数の少ないシフトタイプを選ぶ(MTは中番相当としてカウント)
      const counts = { EARLY: 0, MIDDLE: 0, LATE: 0 };
      staff.forEach(st => {
        const v = result[st.id][ds];
        if (v === 'EARLY' || v === 'MAMA') counts.EARLY++;
        else if (v === 'MIDDLE' || isMTShift(v)) counts.MIDDLE++;
        else if (v === 'LATE') counts.LATE++;
      });
      let bestType = 'EARLY';
      if (s.type === STAFF_TYPE.MAMA) {
        bestType = 'EARLY';
      } else {
        // 最も少ないシフトタイプを選ぶ (休前/休明け優先順位は Step 2.7 で最適化)
        bestType = Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
      }
      const actualShift = (s.type === STAFF_TYPE.MAMA && bestType === 'EARLY') ? 'MAMA' : bestType;
      result[s.id][ds] = actualShift;
    }

    if (assigned < needsToAssign) {
      helpNeeded[ds] = needsToAssign - assigned;
    }
  }

  // Step 2.5: 不足日の救済 - 最低〜最大休日数の余剰を活用
  // helpNeededが残っている日について、休日数が「最低休日数 + 余剰」のスタッフから1日借りて出勤に振り替える
  // 例: 最低10〜最大11の人が現在休11日 → 余剰1日あるので、不足日に出勤させる(休10日に減らす)
  // 条件:
  //   - そのスタッフがその日にOFFになっている(=未割当でStep3で OFFになる予定 のもの)
  //   - 現時点の休日見込み数 > minOffDays (減らせる余地がある)
  //   - 連勤チェック(5連勤禁止)を満たす
  //   - 3人シフト日ならママさん2人目を作らない
  //   - 4連勤の月1回ルールを満たす(免除なしの場合)
  //   - 希望休でない、MTでない、既に割当済でない
  // 不足日を優先度高い順(土日や応援が必要な日数の多い日)に処理する
  const getCurrentOffCount = (staffId) => {
    let count = 0;
    dateStrs.forEach(d => {
      const v = result[staffId][d];
      if (!v || v === 'OFF' || v === 'REQUEST_OFF') count += 1;
      else if (v === 'HALF_OFF') count += 0.5;
    });
    return count;
  };

  // 不足日を順に処理(日付順)
  const shortageDays = Object.keys(helpNeeded).sort();
  for (const ds of shortageDays) {
    const i = dateStrs.indexOf(ds);
    if (i < 0) continue;
    const required = requiredByDate[ds] ?? defaultRequiredByDow[days[i].getDay()];

    // この日の現在の店舗出勤者を再カウント（出張は店舗にいないので除外）
    let currentCount = staff.filter(s => {
      const v = result[s.id][ds];
      return v && v !== 'OFF' && v !== 'REQUEST_OFF' && v !== 'TRIP';
    }).length;
    let stillShort = required - currentCount;
    if (stillShort <= 0) {
      delete helpNeeded[ds];
      continue;
    }

    // 現在ママさん割当数(3人シフト日のママ2人目制約用)
    const isMamaLimited = required <= 3;

    // 候補: その日に未割当(=OFF予定)、かつ希望休/MTでない、かつ休日に余裕があるスタッフ
    const rescueCandidates = staff.filter(s => {
      const cur = result[s.id][ds];
      // 未割当(=OFFになる)であること
      if (cur && cur !== 'OFF') return false;
      // 余裕がない(現状の休日数が最低休日数以下)ならスキップ
      const currentOff = getCurrentOffCount(s.id);
      const minOff = s.minOffDays ?? 8;
      if (currentOff <= minOff) return false; // 既に最低休に達している → 減らせない
      // 連勤チェック
      const exKey = `${s.id}_${ds}`;
      const consec = getConsecutiveWork(s.id, i - 1);
      // 5連勤は強制免除がない限り禁止
      if (consec >= 4 && !exAllowFiveDay[exKey]) return false;
      // 4連勤の月1回ルール
      if (consec === 3 && getFourConsecCount(s.id) >= 1 && !exAllowFourthRule[exKey]) return false;
      // 翌日の連勤も考慮: この日に出勤させたとき、連勤が5になるかチェック
      // 翌日が出勤なら連勤+1、翌々日も... と続く
      let futureConsec = consec + 1; // この日含めての連勤
      let maxFutureConsec = futureConsec;
      for (let j = i + 1; j < dateStrs.length; j++) {
        const fv = result[s.id][dateStrs[j]];
        if (fv && fv !== 'OFF' && fv !== 'REQUEST_OFF') {
          futureConsec++;
          maxFutureConsec = Math.max(maxFutureConsec, futureConsec);
        } else {
          break;
        }
      }
      // 5連勤超過になるなら免除がない限り禁止
      if (maxFutureConsec >= 5 && !exAllowFiveDay[exKey]) return false;

      return true;
    });

    // ママさん制約チェック付きで割当
    const liveMamaCount = () => staff.filter(st =>
      st.type === STAFF_TYPE.MAMA && result[st.id][ds] === 'MAMA'
    ).length;

    // 余裕の大きい順(休日数 - minOff が大きい)、出勤数の少ない順でソート
    rescueCandidates.sort((a, b) => {
      const aSlack = getCurrentOffCount(a.id) - (a.minOffDays ?? 8);
      const bSlack = getCurrentOffCount(b.id) - (b.minOffDays ?? 8);
      if (aSlack !== bSlack) return bSlack - aSlack; // 余裕大きい人優先
      return getWorkDays(a.id) - getWorkDays(b.id); // 出勤少ない人優先
    });

    // 必要なシフトタイプを判定して順次割当
    for (const s of rescueCandidates) {
      if (stillShort <= 0) break;

      // 3人シフト日のママ2人目制約
      if (isMamaLimited && s.type === STAFF_TYPE.MAMA && liveMamaCount() >= 1) continue;

      // 現在の早/中/遅バランスを見て、最も少ないシフトタイプを選ぶ(MTは中番相当としてカウント)
      const counts = { EARLY: 0, MIDDLE: 0, LATE: 0 };
      staff.forEach(st => {
        const v = result[st.id][ds];
        if (v === 'EARLY' || v === 'MAMA') counts.EARLY++;
        else if (v === 'MIDDLE' || isMTShift(v)) counts.MIDDLE++;
        else if (v === 'LATE') counts.LATE++;
      });
      let shiftType;
      if (s.type === STAFF_TYPE.MAMA) {
        shiftType = 'MAMA'; // ママさんは早Mのみ
      } else {
        // 最も少ないシフトタイプを選ぶ (休前/休明け優先順位は Step 2.7 で最適化)
        shiftType = Object.entries(counts).sort((a, b) => a[1] - b[1])[0][0];
      }
      result[s.id][ds] = shiftType;
      stillShort--;
    }

    // helpNeeded の値を更新(まだ不足が残っているなら維持、解消したら削除)
    if (stillShort <= 0) {
      delete helpNeeded[ds];
    } else {
      helpNeeded[ds] = stillShort;
    }
  }

  // ============== Step 2.7: 休前/休明け最適化 (2パス目) ==============
  // パス1で店舗バランス重視で組まれた編成を、各スタッフの休前/休明けに合わせて最適化する。
  // パス1完了時点で全日付の休が確定しているため、未来日の休も正確に判定できる。
  //
  // ロジック:
  //   各スタッフ・各日について理想シフト(第1優先)を計算 → 現状と異なる場合、同じ日の他スタッフと
  //   シフト交換できないか試す。交換相手は「自分の理想シフトを今持っていて、自分の現シフトが交換相手の
  //   理想にも合致する(またはニュートラル)スタッフ」を探す。両者にとって悪化しない場合のみ交換。
  // 制約:
  //   - 手動ロック(manualLocks)されたセルは交換しない
  //   - MT/出張/休/希望休/半休 のセルは交換対象外(早/中/遅 同士のみ交換)
  //   - ママさんは早Mのみなので交換対象外
  //   - 必要人数を超えて出勤している人(forcedWorkersで追加された人)も交換可

  // パス2用の isOffDay (今度は全日付確定済みなので result のみで判定)
  // 注意: Step 3 (残りを休にする処理)は Step 2.7 より後に走るため、
  // この時点で未割当(undefined)のセルは「最終的にOFFになる予定」 → 休として判定する
  const isOffDayFinal = (staffId, idx) => {
    if (idx < 0 || idx >= dateStrs.length) return false;
    const v = result[staffId][dateStrs[idx]];
    if (!v) return true; // undefined = まだ未割当 → 最終的にOFFになるので休扱い
    return v === 'OFF' || v === 'REQUEST_OFF';
  };
  // 全期間の優先順位を再評価
  const getFinalShiftPriority = (staffId, dateIdx, staffType) => {
    if (staffType === STAFF_TYPE.MAMA) return null;
    const isAfterOff = isOffDayFinal(staffId, dateIdx - 1);
    const isBeforeOff = isOffDayFinal(staffId, dateIdx + 1);
    if (isAfterOff && isBeforeOff) return ['MIDDLE', 'EARLY', 'LATE'];
    if (isAfterOff) return ['LATE', 'MIDDLE', 'EARLY'];
    if (isBeforeOff) return ['EARLY', 'MIDDLE', 'LATE'];
    return null;
  };
  // シフトの満足度: 自分の理想優先順位の中で何位か (低いほど満足)
  // priority がない場合は 1.5 (中立 = 第2優先と第3優先の間)
  const getSatisfaction = (staffId, dateIdx, staffType, shift) => {
    const priority = getFinalShiftPriority(staffId, dateIdx, staffType);
    if (!priority) return 1.5;
    const pos = priority.indexOf(shift);
    return pos >= 0 ? pos : 99;
  };

  // 各日について最適化
  // 数回繰り返すと連鎖的に改善することがあるので、3回まで反復
  for (let iteration = 0; iteration < 3; iteration++) {
    let madeChange = false;
    for (let i = 0; i < dateStrs.length; i++) {
      const ds = dateStrs[i];
      // この日の出勤者(早/中/遅のみ・ママは除外・手動ロックは除外)を集める
      const swappable = staff.filter(s => {
        if (s.type === STAFF_TYPE.MAMA) return false;
        if (manualLocks?.[s.id]?.[ds]) return false;
        const v = result[s.id][ds];
        return v === 'EARLY' || v === 'MIDDLE' || v === 'LATE';
      });
      if (swappable.length < 1) continue;

      // ペアごとに交換を試みる
      for (let a = 0; a < swappable.length; a++) {
        for (let b = a + 1; b < swappable.length; b++) {
          const sa = swappable[a];
          const sb = swappable[b];
          const va = result[sa.id][ds];
          const vb = result[sb.id][ds];
          if (va === vb) continue; // 同じシフトなら交換無意味

          // 現在の満足度
          const currentSat = getSatisfaction(sa.id, i, sa.type, va) + getSatisfaction(sb.id, i, sb.type, vb);
          // 交換後の満足度
          const swappedSat = getSatisfaction(sa.id, i, sa.type, vb) + getSatisfaction(sb.id, i, sb.type, va);
          // 個別悪化チェック: 第1優先(0)だった人を「第3優先(2)」まで急落させる交換は避ける
          // (第2優先までの悪化は、合計改善があれば許容)
          const aBefore = getSatisfaction(sa.id, i, sa.type, va);
          const aAfter = getSatisfaction(sa.id, i, sa.type, vb);
          const bBefore = getSatisfaction(sb.id, i, sb.type, vb);
          const bAfter = getSatisfaction(sb.id, i, sb.type, va);
          if (aBefore === 0 && aAfter >= 2) continue;
          if (bBefore === 0 && bAfter >= 2) continue;
          // 合計が改善するなら交換
          if (swappedSat < currentSat) {
            result[sa.id][ds] = vb;
            result[sb.id][ds] = va;
            madeChange = true;
          }
        }
      }

      // 単独シフト変更: 「自分の理想シフトが店舗に欠けている枠」なら単独で変更
      // 例: その日の出勤が「遅・MT・休」だけで早枠が空き、田中が遅で休前(早が理想)なら田中=早に変更
      // ※ 店舗バランスを考慮: 変更後にその枠(早/中/遅)が複数になる過剰偏りは避ける
      for (const s of swappable) {
        const cur = result[s.id][ds];
        const priority = getFinalShiftPriority(s.id, i, s.type);
        if (!priority) continue; // 通常日は対象外
        const ideal = priority[0];
        if (cur === ideal) continue; // 既に理想

        // 現在の店舗のシフト分布(早/中/遅をカウント・MTは中番相当)
        const counts = { EARLY: 0, MIDDLE: 0, LATE: 0 };
        staff.forEach(st => {
          const v = result[st.id][ds];
          if (v === 'EARLY' || v === 'MAMA') counts.EARLY++;
          else if (v === 'MIDDLE' || isMTShift(v)) counts.MIDDLE++;
          else if (v === 'LATE') counts.LATE++;
        });

        // 変更後のカウントをシミュレーション
        const newCounts = { ...counts };
        if (cur === 'EARLY') newCounts.EARLY--;
        else if (cur === 'MIDDLE') newCounts.MIDDLE--;
        else if (cur === 'LATE') newCounts.LATE--;
        if (ideal === 'EARLY') newCounts.EARLY++;
        else if (ideal === 'MIDDLE') newCounts.MIDDLE++;
        else if (ideal === 'LATE') newCounts.LATE++;

        // 変更可能の条件:
        // 1. 自分の理想シフト(ideal)枠が空き(0名) → 埋める意味がある
        // 2a. 元の枠(cur)に他のスタッフがいる → 自分が抜けても店舗バランス維持
        //    OR
        // 2b. 元の枠(cur)に他がいなくても、自分が抜けて0になる枠の数が変更前と同じ以下
        //    (つまり店舗バランスを悪化させない)
        const idealWasEmpty = (
          (ideal === 'EARLY' && counts.EARLY === 0) ||
          (ideal === 'MIDDLE' && counts.MIDDLE === 0) ||
          (ideal === 'LATE' && counts.LATE === 0)
        );
        if (!idealWasEmpty) continue; // ideal枠が既に埋まっているなら単独変更しない

        // 変更前後の「埋まっている枠の数」をカウント
        const filledBefore = [counts.EARLY, counts.MIDDLE, counts.LATE].filter(n => n > 0).length;
        const filledAfter = [newCounts.EARLY, newCounts.MIDDLE, newCounts.LATE].filter(n => n > 0).length;

        // 変更後に埋まっている枠の数が増えるか同じなら、店舗バランスを悪化させない
        if (filledAfter >= filledBefore) {
          result[s.id][ds] = ideal;
          madeChange = true;
        }
      }
    }
    if (!madeChange) break;
  }


  // ヘルプ要請が必要な日 (helpNeeded) について、他店舗からの応援を1日1名まで配置する
  // 他店舗応援なので連続日でも可。既存スタッフのルールには一切影響しない
  // ルール: ヘルプは中番(HELP_MIDDLE)のみ
  // helpAssignments: { [dateStr]: 'HELP_MIDDLE' }
  const helpAssignments = {};
  for (let i = 0; i < dateStrs.length; i++) {
    const ds = dateStrs[i];
    if (!helpNeeded[ds]) continue;

    // 1日1名まで・中番固定で配置（不足が2名以上でも1名のみ、残りは外部要請として残す）
    helpAssignments[ds] = 'HELP_MIDDLE';
    helpNeeded[ds] -= 1;
    if (helpNeeded[ds] <= 0) delete helpNeeded[ds];
  }

  // Step 3: 残りは休み
  staff.forEach(s => {
    dateStrs.forEach(ds => {
      if (!result[s.id][ds]) result[s.id][ds] = 'OFF';
    });
  });

  // Step 4: 改善提案の分析
  // helpNeeded が残っている日について「なぜ埋まらなかったか」と「どうすれば解消するか」を分析
  const suggestions = [];
  Object.keys(helpNeeded).forEach(ds => {
    const i = dateStrs.indexOf(ds);
    if (i < 0) return;
    const dateLabel = `${days[i].getMonth()+1}/${days[i].getDate()}(${dayOfWeekJa[days[i].getDay()]})`;
    const shortage = helpNeeded[ds];

    // この日に出勤可能だったが弾かれたスタッフを各理由ごとに集計
    const blockedReasons = {
      minOff: [],          // 最低休日数の制約で弾かれた
      fourConsec: [],      // 4連勤上限で弾かれた（5連勤になる）
      fiveConsec: [],      // すでに4連勤後で弾かれた
      requestOff: [],      // 希望休
    };

    staff.forEach(s => {
      const cur = result[s.id][ds];
      // 既に通常出勤・MT・ヘルプの人はスキップ
      if (cur && cur !== 'OFF' && cur !== 'REQUEST_OFF') return;

      // 希望休
      if (cur === 'REQUEST_OFF') {
        blockedReasons.requestOff.push(s);
        return;
      }

      // この日が休み(OFF)になっている人について、どの制約が効いたかを推定
      // 連勤数チェック
      let consec = 0;
      for (let j = i - 1; j >= 0; j--) {
        const v = result[s.id][dateStrs[j]];
        if (v && v !== 'OFF' && v !== 'REQUEST_OFF' && !isHelpShift(v)) consec++;
        else break;
      }
      if (consec >= 4) {
        blockedReasons.fiveConsec.push({ staff: s, consec });
        return;
      }
      if (consec === 3) {
        // 4連勤になる→月1回まで→既に4連勤あり
        let fourCount = 0, run = 0;
        for (let j = 0; j < dateStrs.length; j++) {
          const v = result[s.id][dateStrs[j]];
          if (v && v !== 'OFF' && v !== 'REQUEST_OFF' && !isHelpShift(v)) {
            run++;
            if (run === 4) fourCount++;
          } else run = 0;
        }
        if (fourCount >= 1) {
          blockedReasons.fourConsec.push({ staff: s, fourCount });
          return;
        }
      }

      // 最低休日数チェック（目標出勤数を超過）
      const workDays = dateStrs.filter(d => {
        const v = result[s.id][d];
        return v && v !== 'OFF' && v !== 'REQUEST_OFF' && !isHelpShift(v);
      }).length;
      const minOff = s.minOffDays ?? 8;
      const requestOffCount = dateStrs.filter(d => result[s.id][d] === 'REQUEST_OFF').length;
      const target = totalDays - Math.max(minOff, requestOffCount);
      if (workDays >= target) {
        blockedReasons.minOff.push({ staff: s, workDays, target, minOff });
        return;
      }
    });

    // 提案を生成
    const dayActions = [];

    if (blockedReasons.minOff.length > 0) {
      blockedReasons.minOff.forEach(({ staff: s, minOff }) => {
        dayActions.push({
          type: 'reduce_off',
          priority: 1,
          staffId: s.id,
          staffName: s.name,
          currentMinOff: minOff,
          date: ds,
          text: `${s.name}さんの最低休日数を ${minOff}日 → ${minOff - 1}日 に減らせば出勤可能`,
        });
      });
    }
    if (blockedReasons.fourConsec.length > 0) {
      blockedReasons.fourConsec.forEach(({ staff: s }) => {
        dayActions.push({
          type: 'allow_fifth_day',
          priority: 2,
          staffId: s.id,
          staffName: s.name,
          date: ds,
          text: `${s.name}さんを5連勤させれば出勤可能（現在4連勤目を上限超過）`,
        });
      });
    }
    if (blockedReasons.fiveConsec.length > 0) {
      blockedReasons.fiveConsec.forEach(({ staff: s, consec }) => {
        dayActions.push({
          type: 'allow_long_consec',
          priority: 3,
          staffId: s.id,
          staffName: s.name,
          date: ds,
          text: `${s.name}さんを${consec + 1}連勤させれば出勤可能（5連勤超過の例外を許可）`,
        });
      });
    }
    if (blockedReasons.requestOff.length > 0) {
      blockedReasons.requestOff.forEach(s => {
        dayActions.push({
          type: 'move_request_off',
          priority: 4,
          staffId: s.id,
          staffName: s.name,
          date: ds,
          text: `${s.name}さんに希望休の変更を相談（この日が希望休）`,
        });
      });
    }

    // 全員出勤・休日数満たしているがそもそも人数が足りない場合
    if (dayActions.length === 0) {
      dayActions.push({
        type: 'add_staff',
        priority: 9,
        date: ds,
        text: `この日は構造的に人手が不足しています。新規スタッフ追加または必要人数の見直しを検討`,
      });
    }

    // 優先度順にソート
    dayActions.sort((a, b) => a.priority - b.priority);

    suggestions.push({
      date: ds,
      dateLabel,
      shortage,
      actions: dayActions,
    });
  });

  // ============== グローバル課題の分析 ==============
  // 最終結果から、最大休日数を超えてしまったスタッフを抽出
  const globalIssues = [];

  // 各スタッフの実際の休日数を計算(半休=0.5日)
  staff.forEach(s => {
    let offDays = 0;
    dateStrs.forEach(d => {
      const v = result[s.id][d];
      if (v === 'OFF' || v === 'REQUEST_OFF') offDays += 1;
      else if (v === 'HALF_OFF') offDays += 0.5;
    });
    const maxOff = s.maxOffDays;
    if (maxOff !== undefined && offDays > maxOff) {
      const overBy = offDays - maxOff;
      globalIssues.push({
        type: 'max_off_exceeded',
        priority: 1,
        staffId: s.id,
        staffName: s.name,
        currentOffDays: offDays,
        maxOff,
        overBy,
        text: `${s.name}さんの休日数が ${offDays}日 で 最大 ${maxOff}日 を ${overBy}日 超過しています`,
      });
    }
  });

  // 構造的キャパ不足
  if (structuralWarnings.capacityShortage) {
    const shortage = structuralWarnings.capacityShortageDetail.totalRequired - structuralWarnings.capacityShortageDetail.totalMaxCapacity;
    globalIssues.push({
      type: 'capacity_shortage',
      priority: 2,
      shortage,
      text: `現スタッフ全員が最低休日数まで休んでも、必要のべ人数 ${structuralWarnings.capacityShortageDetail.totalRequired}人 に対して ${shortage}人分 不足しています`,
    });
  }
  if (structuralWarnings.forcedOverMax) {
    const over = structuralWarnings.forcedOverMaxDetail.totalMinWork - structuralWarnings.forcedOverMaxDetail.totalRequired;
    globalIssues.push({
      type: 'forced_over_max',
      priority: 3,
      over,
      text: `最大休日数の合計から逆算した必要のべ出勤数が、必要人数の合計より ${over}人分 多いため、最大休日数を超えるスタッフが発生します`,
    });
  }

  return { shifts: result, helpNeeded, suggestions, helpAssignments, globalIssues };
};

// ============== メインコンポーネント ==============
export default function ShiftTool() {
  const today = new Date();
  // 初期値はlocalStorageから読み込み(なければデフォルト計算)
  const [periodMonth, setPeriodMonth] = useState(() => loadFromStorage('periodMonth', {
    year: today.getDate() >= 11 ? today.getFullYear() : (today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear()),
    month: today.getDate() >= 11 ? today.getMonth() + 1 : today.getMonth() === 0 ? 12 : today.getMonth(),
  }));

  const [staff, setStaff] = useState(() => loadFromStorage('staff', [
    { id: 's1', name: '田中', type: STAFF_TYPE.EMPLOYEE, minOffDays: 8, maxOffDays: 10 },
    { id: 's2', name: '佐藤', type: STAFF_TYPE.EMPLOYEE, minOffDays: 8, maxOffDays: 10 },
    { id: 's3', name: '鈴木', type: STAFF_TYPE.EMPLOYEE, minOffDays: 9, maxOffDays: 11 },
    { id: 's4', name: '山田', type: STAFF_TYPE.MAMA, minOffDays: 12, maxOffDays: 16 },
    { id: 's5', name: '伊藤', type: STAFF_TYPE.EMPLOYEE, minOffDays: 8, maxOffDays: 10 },
  ]));

  const [requiredByDate, setRequiredByDate] = useState(() => loadFromStorage('requiredByDate', {})); // 個別設定された日の人数
  const [fixedShifts, setFixedShifts] = useState(() => loadFromStorage('fixedShifts', {})); // {staffId: {dateStr: 'REQUEST_OFF'|'MT'}}
  const [manualLocks, setManualLocks] = useState(() => loadFromStorage('manualLocks', {})); // {staffId: {dateStr: shiftValue}} 手動編集ロック
  const [generatedShifts, setGeneratedShifts] = useState(() => loadFromStorage('generatedShifts', null));
  const [helpNeeded, setHelpNeeded] = useState(() => loadFromStorage('helpNeeded', {}));
  const [helpAssignments, setHelpAssignments] = useState(() => loadFromStorage('helpAssignments', {}));
  // ヘルプの時間メモ {[dateStr]: "11-16"} (中番固定だが応援者の都合で時間が変わる)
  const [helpTimeNotes, setHelpTimeNotes] = useState(() => loadFromStorage('helpTimeNotes', {}));
  // スタッフ別のセルメモ {staffId: {dateStr: "メモ文字列"}}
  // 全シフトタイプ(早/中/遅/MT/出張/休 など)に対して任意のメモを付けられる
  const [cellNotes, setCellNotes] = useState(() => loadFromStorage('cellNotes', {}));
  // 店舗イベント [{id, name, dateStart, dateEnd, color}]
  const [events, setEvents] = useState(() => loadFromStorage('events', []));
  const [suggestions, setSuggestions] = useState([]); // 編成時に再計算するので保存不要
  const [globalIssues, setGlobalIssues] = useState([]); // 同上
  const [exemptions, setExemptions] = useState(() => loadFromStorage('exemptions', {
    allowFiveDay: {},
    allowFourthRule: {},
  }));
  const [appliedActions, setAppliedActions] = useState(() => loadFromStorage('appliedActions', []));
  // 月ごとの最低/最大休日数の上書き
  // 構造: { "2026-4": { staffId: { minOffDays: 9, maxOffDays: 10 }, ... }, "2026-5": {...} }
  const [monthlyOverrides, setMonthlyOverrides] = useState(() => loadFromStorage('monthlyOverrides', {}));
  // 曜日ごとの必要人数デフォルト設定 (店舗共通)
  // { 0-6: 数, holiday: 数 }
  const [defaultRequiredConfig, setDefaultRequiredConfig] = useState(() =>
    loadFromStorage('defaultRequiredConfig', { 0: 3, 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 4, holiday: 3 })
  );
  const [activeTab, setActiveTab] = useState('shift');
  const [selectedStaffId, setSelectedStaffId] = useState(null);
  const [editingCell, setEditingCell] = useState(null);
  const [highlightedCells, setHighlightedCells] = useState(new Set());
  const [lastApplyResult, setLastApplyResult] = useState(null);

  const { days } = useMemo(() => getShiftPeriod(periodMonth.year, periodMonth.month), [periodMonth]);
  const dateStrs = days.map(fmt);

  // 現在の月のキー (例: "2026-4")
  const periodKey = `${periodMonth.year}-${periodMonth.month}`;

  // 月ごとの上書きを反映したスタッフ配列 (実効値)
  // 自動編成・休計表示・改善提案などで使う
  const effectiveStaff = useMemo(() => {
    const overrides = monthlyOverrides[periodKey] || {};
    return staff.map(s => {
      const ov = overrides[s.id];
      if (!ov) return s;
      return {
        ...s,
        minOffDays: ov.minOffDays !== undefined ? ov.minOffDays : s.minOffDays,
        maxOffDays: ov.maxOffDays !== undefined ? ov.maxOffDays : s.maxOffDays,
      };
    });
  }, [staff, monthlyOverrides, periodKey]);

  // 展開済み必要人数: 個別調整があればそれ、なければdefaultRequiredConfigから(祝日も考慮)
  // generateShiftsに渡すrequiredByDateとして使う
  const effectiveRequiredByDate = useMemo(() => {
    const out = {};
    days.forEach((d, idx) => {
      const ds = dateStrs[idx];
      if (requiredByDate[ds] !== undefined) {
        out[ds] = requiredByDate[ds];
      } else if (isHoliday(d) && defaultRequiredConfig.holiday !== undefined) {
        out[ds] = defaultRequiredConfig.holiday;
      } else {
        out[ds] = defaultRequiredConfig[d.getDay()] ?? 3;
      }
    });
    return out;
  }, [days, dateStrs, requiredByDate, defaultRequiredConfig]);

  // 月ごとの上書きを更新するヘルパー
  // value === null なら上書きを削除(基本値に戻す)
  const setMonthlyStaffOverride = (staffId, field, value) => {
    setMonthlyOverrides(prev => {
      const next = { ...prev };
      const monthly = { ...(next[periodKey] || {}) };
      const current = { ...(monthly[staffId] || {}) };
      if (value === null || value === undefined || value === '') {
        delete current[field];
      } else {
        current[field] = Number(value);
      }
      // staffIdごとのレコードが空ならまるごと削除
      if (Object.keys(current).length === 0) {
        delete monthly[staffId];
      } else {
        monthly[staffId] = current;
      }
      // 月レコードが空ならまるごと削除
      if (Object.keys(monthly).length === 0) {
        delete next[periodKey];
      } else {
        next[periodKey] = monthly;
      }
      return next;
    });
  };

  // スタッフの今月の上書きをまるごとリセット (両方の値を基本値に戻す)
  const resetMonthlyStaffOverride = (staffId) => {
    setMonthlyOverrides(prev => {
      const monthly = { ...(prev[periodKey] || {}) };
      delete monthly[staffId];
      const next = { ...prev };
      if (Object.keys(monthly).length === 0) delete next[periodKey];
      else next[periodKey] = monthly;
      return next;
    });
  };

  // ============== LocalStorage 自動保存 ==============
  // 各stateが変わったタイミングで自動保存する
  useEffect(() => { saveToStorage('periodMonth', periodMonth); }, [periodMonth]);
  useEffect(() => { saveToStorage('staff', staff); }, [staff]);
  useEffect(() => { saveToStorage('requiredByDate', requiredByDate); }, [requiredByDate]);
  useEffect(() => { saveToStorage('fixedShifts', fixedShifts); }, [fixedShifts]);
  useEffect(() => { saveToStorage('manualLocks', manualLocks); }, [manualLocks]);
  useEffect(() => { saveToStorage('generatedShifts', generatedShifts); }, [generatedShifts]);
  useEffect(() => { saveToStorage('helpNeeded', helpNeeded); }, [helpNeeded]);
  useEffect(() => { saveToStorage('helpAssignments', helpAssignments); }, [helpAssignments]);
  useEffect(() => { saveToStorage('helpTimeNotes', helpTimeNotes); }, [helpTimeNotes]);
  useEffect(() => { saveToStorage('cellNotes', cellNotes); }, [cellNotes]);

  // セルメモを更新するヘルパー (空文字なら削除)
  const updateCellNote = (staffId, dateStr, note) => {
    setCellNotes(prev => {
      const next = { ...prev };
      const sMap = { ...(next[staffId] || {}) };
      const trimmed = (note || '').trim();
      if (trimmed === '') {
        delete sMap[dateStr];
      } else {
        sMap[dateStr] = trimmed;
      }
      if (Object.keys(sMap).length === 0) {
        delete next[staffId];
      } else {
        next[staffId] = sMap;
      }
      return next;
    });
  };
  useEffect(() => { saveToStorage('events', events); }, [events]);
  useEffect(() => { saveToStorage('exemptions', exemptions); }, [exemptions]);
  useEffect(() => { saveToStorage('appliedActions', appliedActions); }, [appliedActions]);
  useEffect(() => { saveToStorage('monthlyOverrides', monthlyOverrides); }, [monthlyOverrides]);
  useEffect(() => { saveToStorage('defaultRequiredConfig', defaultRequiredConfig); }, [defaultRequiredConfig]);

  // 旧形式(MT_EARLY/MT_MIDDLE/MT_LATE)データを新形式('MT')に1度だけマイグレーション
  useEffect(() => {
    // fixedShifts に旧形式が残っていれば 'MT' に置換
    let needFix = false;
    Object.values(fixedShifts).forEach(map => {
      Object.values(map || {}).forEach(v => {
        if (v === 'MT_EARLY' || v === 'MT_MIDDLE' || v === 'MT_LATE') needFix = true;
      });
    });
    if (needFix) {
      setFixedShifts(prev => {
        const next = {};
        Object.entries(prev).forEach(([sid, dmap]) => {
          next[sid] = {};
          Object.entries(dmap || {}).forEach(([ds, val]) => {
            next[sid][ds] = isMTShift(val) ? 'MT' : val;
          });
        });
        return next;
      });
    }
    // manualLocks も同様
    let needFixLocks = false;
    Object.values(manualLocks).forEach(map => {
      Object.values(map || {}).forEach(v => {
        if (v === 'MT_EARLY' || v === 'MT_MIDDLE' || v === 'MT_LATE') needFixLocks = true;
      });
    });
    if (needFixLocks) {
      setManualLocks(prev => {
        const next = {};
        Object.entries(prev).forEach(([sid, dmap]) => {
          next[sid] = {};
          Object.entries(dmap || {}).forEach(([ds, val]) => {
            next[sid][ds] = isMTShift(val) ? 'MT' : val;
          });
        });
        return next;
      });
    }
    // generatedShifts も同様
    if (generatedShifts) {
      let needFixGen = false;
      Object.values(generatedShifts).forEach(map => {
        Object.values(map || {}).forEach(v => {
          if (v === 'MT_EARLY' || v === 'MT_MIDDLE' || v === 'MT_LATE') needFixGen = true;
        });
      });
      if (needFixGen) {
        setGeneratedShifts(prev => {
          if (!prev) return prev;
          const next = {};
          Object.entries(prev).forEach(([sid, dmap]) => {
            next[sid] = {};
            Object.entries(dmap || {}).forEach(([ds, val]) => {
              next[sid][ds] = isMTShift(val) ? 'MT' : val;
            });
          });
          return next;
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // 起動時に1回だけ

  // 全データをリセット (localStorage + state)
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const performResetAllData = () => {
    clearAllStorage();
    // stateもデフォルト値に戻す
    const td = new Date();
    setPeriodMonth({
      year: td.getDate() >= 11 ? td.getFullYear() : (td.getMonth() === 0 ? td.getFullYear() - 1 : td.getFullYear()),
      month: td.getDate() >= 11 ? td.getMonth() + 1 : td.getMonth() === 0 ? 12 : td.getMonth(),
    });
    setStaff([
      { id: 's1', name: '田中', type: STAFF_TYPE.EMPLOYEE, minOffDays: 8, maxOffDays: 10 },
      { id: 's2', name: '佐藤', type: STAFF_TYPE.EMPLOYEE, minOffDays: 8, maxOffDays: 10 },
      { id: 's3', name: '鈴木', type: STAFF_TYPE.EMPLOYEE, minOffDays: 9, maxOffDays: 11 },
      { id: 's4', name: '山田', type: STAFF_TYPE.MAMA, minOffDays: 12, maxOffDays: 16 },
      { id: 's5', name: '伊藤', type: STAFF_TYPE.EMPLOYEE, minOffDays: 8, maxOffDays: 10 },
    ]);
    setRequiredByDate({});
    setFixedShifts({});
    setManualLocks({});
    setGeneratedShifts(null);
    setHelpNeeded({});
    setHelpAssignments({});
    setHelpTimeNotes({});
    setCellNotes({});
    setEvents([]);
    setExemptions({ allowFiveDay: {}, allowFourthRule: {} });
    setAppliedActions([]);
    setMonthlyOverrides({});
    setDefaultRequiredConfig({ 0: 3, 1: 3, 2: 3, 3: 3, 4: 3, 5: 3, 6: 4, holiday: 3 });
    setCustomFileName('');
    setSuggestions([]);
    setGlobalIssues([]);
    setHighlightedCells(new Set());
    setLastApplyResult(null);
    setEditingCell(null);
    setSelectedStaffId(null);
    setShowResetConfirm(false);
  };

  // 手動でシフトセルを変更（自動的にロック）
  const updateShiftCell = (staffId, dateStr, newValue) => {
    // 旧形式のMT_EARLY/MT_MIDDLE/MT_LATEは新形式の 'MT' に正規化
    const normalizedValue = isMTShift(newValue) ? 'MT' : newValue;
    setGeneratedShifts(prev => {
      if (!prev) return prev;
      const next = { ...prev };
      next[staffId] = { ...next[staffId], [dateStr]: normalizedValue };
      return next;
    });
    setEditingCell(null);

    // 希望休・MT・出張は fixedShifts にも反映（次回自動編成時に保持される）
    if (normalizedValue === 'REQUEST_OFF' || normalizedValue === 'MT' || normalizedValue === 'TRIP') {
      setFixedShifts(prev => {
        const next = { ...prev };
        next[staffId] = { ...(next[staffId] || {}), [dateStr]: normalizedValue };
        return next;
      });
      // 希望休・MT・出張は fixedShifts で管理されるのでロックは不要（解除）
      setManualLocks(prev => {
        if (!prev[staffId]?.[dateStr]) return prev;
        const next = { ...prev };
        next[staffId] = { ...next[staffId] };
        delete next[staffId][dateStr];
        return next;
      });
    } else {
      // それ以外は手動ロックとして登録
      setManualLocks(prev => {
        const next = { ...prev };
        next[staffId] = { ...(next[staffId] || {}), [dateStr]: normalizedValue };
        return next;
      });
      // fixedShiftsから削除
      setFixedShifts(prev => {
        if (!prev[staffId]?.[dateStr]) return prev;
        const next = { ...prev };
        next[staffId] = { ...next[staffId] };
        delete next[staffId][dateStr];
        return next;
      });
    }
  };

  // 手動ロックを解除
  const unlockShiftCell = (staffId, dateStr) => {
    setManualLocks(prev => {
      if (!prev[staffId]?.[dateStr]) return prev;
      const next = { ...prev };
      next[staffId] = { ...next[staffId] };
      delete next[staffId][dateStr];
      return next;
    });
    setEditingCell(null);
    // ロック解除後は次の再編成タイミングでセルが上書きされる
    // 即座に反映するために再編成を実行
    const cleared = { ...manualLocks };
    if (cleared[staffId]) {
      cleared[staffId] = { ...cleared[staffId] };
      delete cleared[staffId][dateStr];
    }
    const { shifts, helpNeeded: hn, suggestions: sg, helpAssignments: ha, globalIssues: gi } = generateShifts(
      effectiveStaff, days, effectiveRequiredByDate, fixedShifts, exemptions, cleared
    );
    setGeneratedShifts(shifts);
    setHelpNeeded(hn);
    setSuggestions(sg || []);
    setHelpAssignments(ha || {});
    setGlobalIssues(gi || []);
  };

  // ヘルプ枠を手動で切り替え（配置 / 解除）
  const toggleHelpCell = (dateStr) => {
    setHelpAssignments(prev => {
      const next = { ...prev };
      if (next[dateStr]) {
        // 既に配置されている → 解除
        delete next[dateStr];
        // helpNeeded を再計算（必要人数 - 店舗出勤者・出張は店舗外なので除外）
        setHelpNeeded(prevHN => {
          const required = effectiveRequiredByDate[dateStr] ?? 3;
          const workers = staff.filter(s => {
            const v = generatedShifts?.[s.id]?.[dateStr];
            return v && v !== 'OFF' && v !== 'REQUEST_OFF' && v !== 'TRIP';
          }).length;
          const shortage = required - workers;
          const updated = { ...prevHN };
          if (shortage > 0) updated[dateStr] = shortage;
          else delete updated[dateStr];
          return updated;
        });
      } else {
        // 配置されていない → 中番ヘルプを配置
        next[dateStr] = 'HELP_MIDDLE';
        // helpNeeded も更新
        setHelpNeeded(prevHN => {
          const updated = { ...prevHN };
          if (updated[dateStr] && updated[dateStr] > 1) {
            updated[dateStr] -= 1;
          } else {
            delete updated[dateStr];
          }
          return updated;
        });
      }
      return next;
    });
  };

  // ============== ハンドラ ==============
  const generate = (overrideExemptions) => {
    const ex = overrideExemptions || exemptions;
    const { shifts, helpNeeded: hn, suggestions: sg, helpAssignments: ha, globalIssues: gi } = generateShifts(effectiveStaff, days, effectiveRequiredByDate, fixedShifts, ex, manualLocks);
    setGeneratedShifts(shifts);
    setHelpNeeded(hn);
    setSuggestions(sg || []);
    setHelpAssignments(ha || {});
    setGlobalIssues(gi || []);
  };

  // 必要人数変更時、既に編成済みなら自動再編成
  useEffect(() => {
    if (generatedShifts !== null) {
      const { shifts, helpNeeded: hn, suggestions: sg, helpAssignments: ha, globalIssues: gi } = generateShifts(effectiveStaff, days, effectiveRequiredByDate, fixedShifts, exemptions, manualLocks);
      setGeneratedShifts(shifts);
      setHelpNeeded(hn);
      setSuggestions(sg || []);
      setHelpAssignments(ha || {});
      setGlobalIssues(gi || []);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredByDate]);

  // 提案を適用するハンドラ
  const applyAction = (action) => {
    let newExemptions = exemptions;
    let newEffectiveStaff = effectiveStaff; // 改善提案後の実効値
    let label = '';

    if (action.type === 'reduce_off') {
      // 該当スタッフの今月の最低休日数を1減らす(上書き登録)
      const target = effectiveStaff.find(s => s.id === action.staffId);
      const currentMin = target?.minOffDays ?? action.currentMinOff;
      const newMinOff = Math.max(0, currentMin - 1);
      setMonthlyStaffOverride(action.staffId, 'minOffDays', newMinOff);
      newEffectiveStaff = effectiveStaff.map(s => s.id === action.staffId
        ? { ...s, minOffDays: newMinOff }
        : s);
      label = `${action.staffName}さんの最低休日数(今月): ${currentMin}日 → ${newMinOff}日`;
    } else if (action.type === 'increase_max_off') {
      // 該当スタッフの今月の最大休日数を1増やす(上書き登録)
      const target = effectiveStaff.find(s => s.id === action.staffId);
      const currentMax = target?.maxOffDays ?? action.currentMaxOff ?? 0;
      const newMax = currentMax + 1;
      setMonthlyStaffOverride(action.staffId, 'maxOffDays', newMax);
      newEffectiveStaff = effectiveStaff.map(s => s.id === action.staffId
        ? { ...s, maxOffDays: newMax }
        : s);
      label = `${action.staffName}さんの最大休日数(今月): ${currentMax}日 → ${newMax}日`;
    } else if (action.type === 'allow_fifth_day' || action.type === 'allow_long_consec') {
      newExemptions = {
        ...exemptions,
        allowFiveDay: { ...exemptions.allowFiveDay, [`${action.staffId}_${action.date}`]: true },
        allowFourthRule: { ...exemptions.allowFourthRule, [`${action.staffId}_${action.date}`]: true },
      };
      const dateLabel = action.date.split('-').slice(1).join('/');
      label = `${action.staffName}さんの${dateLabel}: 連勤ルール例外を許可`;
      setExemptions(newExemptions);
    }

    setAppliedActions(prev => [...prev, {
      id: `${Date.now()}_${Math.random()}`,
      type: action.type,
      label,
      action,
    }]);

    // 即座に再編成
    const { shifts, helpNeeded: hn, suggestions: sg, helpAssignments: ha, globalIssues: gi } = generateShifts(
      newEffectiveStaff, days, effectiveRequiredByDate, fixedShifts, newExemptions, manualLocks
    );

    // 変更されたセルを抽出（ハイライト用）
    const changedCells = [];
    if (generatedShifts) {
      newEffectiveStaff.forEach(s => {
        dateStrs.forEach(ds => {
          const before = generatedShifts[s.id]?.[ds];
          const after = shifts[s.id]?.[ds];
          if (before !== after) {
            changedCells.push(`${s.id}_${ds}`);
          }
        });
      });
    }

    setGeneratedShifts(shifts);
    setHelpNeeded(hn);
    setSuggestions(sg || []);
    setHelpAssignments(ha || {});
    setGlobalIssues(gi || []);
    setHighlightedCells(new Set(changedCells));
    setLastApplyResult({
      label,
      changeCount: changedCells.length,
      remainingShortage: Object.keys(hn).length,
    });

    // シフト表タブに自動遷移して結果を見せる
    setActiveTab('shift');

    // 5秒後にハイライトを消す
    setTimeout(() => {
      setHighlightedCells(new Set());
      setLastApplyResult(null);
    }, 6000);
  };

  // 適用した提案を取り消す
  const undoAction = (entryId) => {
    const entry = appliedActions.find(e => e.id === entryId);
    if (!entry) return;

    let newExemptions = exemptions;
    let newEffectiveStaff = effectiveStaff;

    if (entry.type === 'reduce_off') {
      // 今月の上書きを+1して戻す
      const target = effectiveStaff.find(s => s.id === entry.action.staffId);
      const currentMin = target?.minOffDays ?? 0;
      const restoredMin = currentMin + 1;
      const baseMin = staff.find(s => s.id === entry.action.staffId)?.minOffDays ?? 0;
      // 基本値に戻ったなら上書きを削除、そうでなければ上書きを更新
      if (restoredMin === baseMin) {
        setMonthlyStaffOverride(entry.action.staffId, 'minOffDays', null);
      } else {
        setMonthlyStaffOverride(entry.action.staffId, 'minOffDays', restoredMin);
      }
      newEffectiveStaff = effectiveStaff.map(s => s.id === entry.action.staffId
        ? { ...s, minOffDays: restoredMin }
        : s);
    } else if (entry.type === 'allow_fifth_day' || entry.type === 'allow_long_consec') {
      const key = `${entry.action.staffId}_${entry.action.date}`;
      const a = { ...exemptions.allowFiveDay }; delete a[key];
      const b = { ...exemptions.allowFourthRule }; delete b[key];
      newExemptions = { ...exemptions, allowFiveDay: a, allowFourthRule: b };
      setExemptions(newExemptions);
    } else if (entry.type === 'increase_max_off') {
      // 今月の上書きを-1して戻す
      const target = effectiveStaff.find(s => s.id === entry.action.staffId);
      const currentMax = target?.maxOffDays ?? 0;
      const restoredMax = currentMax - 1;
      const baseMax = staff.find(s => s.id === entry.action.staffId)?.maxOffDays;
      if (restoredMax === baseMax) {
        setMonthlyStaffOverride(entry.action.staffId, 'maxOffDays', null);
      } else {
        setMonthlyStaffOverride(entry.action.staffId, 'maxOffDays', restoredMax);
      }
      newEffectiveStaff = effectiveStaff.map(s => s.id === entry.action.staffId
        ? { ...s, maxOffDays: restoredMax }
        : s);
    }

    setAppliedActions(prev => prev.filter(e => e.id !== entryId));

    // 再編成
    const { shifts, helpNeeded: hn, suggestions: sg, helpAssignments: ha, globalIssues: gi } = generateShifts(
      newEffectiveStaff, days, effectiveRequiredByDate, fixedShifts, newExemptions, manualLocks
    );
    setGeneratedShifts(shifts);
    setHelpNeeded(hn);
    setSuggestions(sg || []);
    setHelpAssignments(ha || {});
    setGlobalIssues(gi || []);
  };

  // 全免除を解除＋手動ロックも解除（自動編成ボタン用：完全リセット）
  const resetAndGenerate = () => {
    const empty = { allowFiveDay: {}, allowFourthRule: {} };
    setExemptions(empty);
    setAppliedActions([]);
    setManualLocks({}); // 手動ロックも全解除
    // 直接再編成（manualLocksを空にして）
    const { shifts, helpNeeded: hn, suggestions: sg, helpAssignments: ha, globalIssues: gi } = generateShifts(
      effectiveStaff, days, effectiveRequiredByDate, fixedShifts, empty, {}
    );
    setGeneratedShifts(shifts);
    setHelpNeeded(hn);
    setSuggestions(sg || []);
    setHelpAssignments(ha || {});
    setGlobalIssues(gi || []);
  };

  // 画像出力（Canvas APIで直接描画、外部依存なし）
  const [exporting, setExporting] = useState(false);
  const [exportedImageUrl, setExportedImageUrl] = useState(null); // ダウンロード後のプレビュー用
  const [customFileName, setCustomFileName] = useState(() => loadFromStorage('customFileName', '')); // ユーザー指定のファイル名（拡張子なし）
  // customFileNameは定義位置の都合で他のuseEffectとは別にここで保存
  useEffect(() => { saveToStorage('customFileName', customFileName); }, [customFileName]);
  const exportShiftAsImage = async (mode = 'mobile') => {
    if (!generatedShifts) {
      alert('シフトを自動編成してから出力してください');
      return;
    }
    setExporting(true);

    try {
      // 旧形式(MT_EARLY/MT_MIDDLE/MT_LATE)が混在するデータでも安全に表示するため、ヘルパーで正規化
      const normalizeForDisplay = (s) => isMTShift(s) ? 'MT' : s;
      const labelMap = {
        EARLY: '早', MAMA: '早M', MIDDLE: '中', LATE: '遅',
        MT: 'MT',
        HALF_OFF: '半',
        TRIP: '出張',
        REQUEST_OFF: '希', OFF: '休'
      };
      const colorMap = {
        EARLY: { bg: '#fef3c7', fg: '#78350f', border: '#fbbf24' },
        MAMA: { bg: '#ffe4e6', fg: '#881337', border: '#fb7185' },
        MIDDLE: { bg: '#d1fae5', fg: '#064e3b', border: '#34d399' },
        LATE: { bg: '#e0f2fe', fg: '#0c4a6e', border: '#38bdf8' },
        MT: { bg: '#ede9fe', fg: '#4c1d95', border: '#a78bfa' },
        HALF_OFF: { bg: '#ccfbf1', fg: '#134e4a', border: '#5eead4' },
        TRIP: { bg: '#e0e7ff', fg: '#312e81', border: '#818cf8' },
        REQUEST_OFF: { bg: '#e7e5e4', fg: '#44403c', border: '#a8a29e' },
        OFF: { bg: '#ffffff', fg: '#a8a29e', border: '#e7e5e4' },
      };

      const isMobile = mode === 'mobile';
      const padding = isMobile ? 16 : 24;
      const headerHeight = 60;
      const legendHeight = 60;
      const footerHeight = 30;
      const summaryW = isMobile ? 42 : 50; // 合計列の幅

      // 各スタッフの休日数を事前計算(半休=0.5日)
      const staffOffCount = {};
      staff.forEach(s => {
        let count = 0;
        dateStrs.forEach(ds => {
          const v = generatedShifts[s.id]?.[ds];
          if (v === 'OFF' || v === 'REQUEST_OFF') count += 1;
          else if (v === 'HALF_OFF') count += 0.5;
        });
        staffOffCount[s.id] = count;
      });

      // 行=スタッフ、列=日付、右端に休日合計列（モバイル/PC共通レイアウト、サイズだけ調整）
      const cellW = isMobile ? 26 : 36;
      const cellH = isMobile ? 32 : 40;
      const labelColW = isMobile ? 80 : 110;
      const labelColH = isMobile ? 36 : 40;
      // 期間中に表示するイベントの抽出
      // 不正期間(終了日<開始日)のものはここで補正してから扱う
      const normalizedEvents = (events || []).map(ev => {
        const dEnd = ev.dateEnd || ev.dateStart;
        if (ev.dateStart && dEnd && dEnd < ev.dateStart) {
          return { ...ev, dateEnd: ev.dateStart };
        }
        return ev;
      });
      const periodStart = dateStrs[0];
      const periodEnd = dateStrs[dateStrs.length - 1];
      const visibleEvents = normalizedEvents.filter(ev =>
        ev.dateStart <= periodEnd && (ev.dateEnd || ev.dateStart) >= periodStart
      );
      const eventRowH = visibleEvents.length > 0 ? (isMobile ? 18 : 22) : 0;
      // イベント一覧セクションの高さ (タイトル + 1行18pxごと)
      const eventListLineH = isMobile ? 18 : 20;
      // イベント一覧の行数を計算 (横並び・自動折り返し)
      // 計算用に一旦tempCanvasでテキスト幅を計測
      let eventListRowCount = 0;
      if (visibleEvents.length > 0) {
        const tempCanvas = document.createElement('canvas');
        const tctx = tempCanvas.getContext('2d');
        tctx.font = `${isMobile ? 10 : 11}px "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif`;
        const itemSpacing = 16;
        const swatchW = 14;
        const swatchGap = 6;
        const availableWidth = (padding * 2 + labelColW + cellW * days.length + summaryW) - padding * 2;
        let curX = 0;
        eventListRowCount = 1;
        visibleEvents.forEach(ev => {
          const startD = ev.dateStart.split('-');
          const endStr = ev.dateEnd || ev.dateStart;
          const endD = endStr.split('-');
          const dateLabel = (ev.dateStart === endStr)
            ? `${parseInt(startD[1])}/${parseInt(startD[2])}`
            : `${parseInt(startD[1])}/${parseInt(startD[2])} 〜 ${parseInt(endD[1])}/${parseInt(endD[2])}`;
          const text = `${ev.name || '(無題)'} (${dateLabel})`;
          const itemW = swatchW + swatchGap + tctx.measureText(text).width;
          if (curX > 0 && curX + itemW > availableWidth) {
            eventListRowCount += 1;
            curX = 0;
          }
          curX += itemW + itemSpacing;
        });
      }
      const eventListHeight = visibleEvents.length > 0
        ? (isMobile ? 12 : 16) + 6 + eventListRowCount * eventListLineH + 8
        : 0;
      // イベント色マップ (HEX)
      const eventColorHex = {
        rose:    { bg: '#fecdd3', text: '#881337' },
        orange:  { bg: '#fed7aa', text: '#7c2d12' },
        amber:   { bg: '#fde68a', text: '#78350f' },
        emerald: { bg: '#a7f3d0', text: '#064e3b' },
        sky:     { bg: '#bae6fd', text: '#0c4a6e' },
        violet:  { bg: '#ddd6fe', text: '#4c1d95' },
      };
      const canvasWidth = padding * 2 + labelColW + cellW * days.length + summaryW;
      const canvasHeight = padding * 2 + headerHeight + eventRowH + cellH * (staff.length + 1) + eventListHeight + legendHeight + footerHeight + 20;

      const dpr = 2; // 高解像度
      const canvas = document.createElement('canvas');
      canvas.width = canvasWidth * dpr;
      canvas.height = canvasHeight * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // 背景
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      // フォント設定
      const fontFamily = '"Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif';

      // ヘッダー
      let y = padding;
      // 印章
      ctx.fillStyle = '#8b1c1c';
      ctx.fillRect(padding, y, 50, 22);
      ctx.fillStyle = '#fef3c7';
      ctx.font = `500 11px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('勤務表', padding + 25, y + 11);

      // タイトル
      ctx.fillStyle = '#1c1917';
      ctx.font = `600 18px ${fontFamily}`;
      ctx.textAlign = 'left';
      ctx.fillText(`${periodMonth.year}年${periodMonth.month}月期`, padding + 64, y + 14);

      // 期間
      ctx.fillStyle = '#78716c';
      ctx.font = `11px ${fontFamily}`;
      const endY = periodMonth.month === 12 ? periodMonth.year + 1 : periodMonth.year;
      const endM = periodMonth.month === 12 ? 1 : periodMonth.month + 1;
      ctx.fillText(`${periodMonth.month}/11 — ${endY}/${endM}/10`, padding + 64, y + 32);

      // 区切り線
      y += 44;
      ctx.strokeStyle = '#1c1917';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(canvasWidth - padding, y);
      ctx.stroke();

      // テーブル
      y += 12;
      const tableX = padding;
      const tableY = y;

        // 行=スタッフ、列=日付、右端に休日合計列（モバイル/PC共通レイアウト）
        const tableWidth = labelColW + cellW * days.length + summaryW;

        // イベント行（描画するイベントがあれば、ヘッダ行の上に配置）
        if (eventRowH > 0) {
          // 背景は白
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(tableX, y, tableWidth, eventRowH);
          // ラベル列
          ctx.fillStyle = '#fafafa';
          ctx.fillRect(tableX, y, labelColW, eventRowH);
          ctx.strokeStyle = '#e7e5e4';
          ctx.lineWidth = 1;
          ctx.strokeRect(tableX, y, labelColW, eventRowH);
          ctx.fillStyle = '#78716c';
          ctx.font = `500 9px ${fontFamily}`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText('イベント', tableX + 8, y + eventRowH / 2);

          // 各イベントを期間バーとして描画
          visibleEvents.forEach(ev => {
            const startIdx = Math.max(0, dateStrs.indexOf(ev.dateStart));
            const endIdx = (() => {
              const d = ev.dateEnd || ev.dateStart;
              const idx = dateStrs.indexOf(d);
              return idx < 0 ? dateStrs.length - 1 : idx;
            })();
            // 期間範囲がカレンダー外まで延びている場合のクリップ
            const clipStartIdx = ev.dateStart < periodStart ? 0 : startIdx;
            const clipEndIdx = (ev.dateEnd || ev.dateStart) > periodEnd ? dateStrs.length - 1 : endIdx;
            if (clipStartIdx > clipEndIdx) return;
            const barX = tableX + labelColW + cellW * clipStartIdx + 1;
            const barW = cellW * (clipEndIdx - clipStartIdx + 1) - 2;
            const c = eventColorHex[ev.color] || eventColorHex.amber;
            ctx.fillStyle = c.bg;
            ctx.fillRect(barX, y + 2, barW, eventRowH - 4);
            // テキスト
            ctx.fillStyle = c.text;
            ctx.font = `600 ${isMobile ? 9 : 10}px ${fontFamily}`;
            ctx.textAlign = 'center';
            const startD = parseInt(ev.dateStart.split('-')[2], 10);
            const endD = parseInt((ev.dateEnd || ev.dateStart).split('-')[2], 10);
            const isSingleDay = startD === endD;
            const name = ev.name || '?';
            const maxTextWidth = barW - 6;
            let displayText;
            if (isSingleDay) {
              // 1日のみ: 名前の頭1文字 (詳細は画像下のイベント一覧で確認可能)
              displayText = name.charAt(0) || '?';
            } else {
              // 2日以上: 名前+期間。入らなければ末尾を「…」省略
              const periodLabel = `${startD}-${endD}`;
              const fullText = `${name} ${periodLabel}`;
              displayText = fullText;
              if (ctx.measureText(displayText).width > maxTextWidth) {
                while (displayText.length > 1 && ctx.measureText(displayText + '…').width > maxTextWidth) {
                  displayText = displayText.slice(0, -1);
                }
                displayText = displayText + '…';
              }
            }
            ctx.fillText(displayText, barX + barW / 2, y + eventRowH / 2);
          });
          y += eventRowH;
        }

        // ヘッダ行（黒背景・スタッフ列ラベル）
        ctx.fillStyle = '#1c1917';
        ctx.fillRect(tableX, y, tableWidth, labelColH);

        ctx.fillStyle = '#fafaf9';
        ctx.font = `500 12px ${fontFamily}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('スタッフ', tableX + 8, y + labelColH / 2);

        // 日付列ヘッダ
        days.forEach((d, idx) => {
          const cx = tableX + labelColW + cellW * idx + cellW / 2;
          const dow = d.getDay();
          const isHol = isHoliday(d);
          const colorH = (dow === 0 || isHol) ? '#fda4af' : (dow === 6 ? '#7dd3fc' : '#fafaf9');
          ctx.fillStyle = colorH;
          ctx.font = `500 12px ${fontFamily}`;
          ctx.textAlign = 'center';
          ctx.fillText(`${d.getDate()}`, cx, y + labelColH / 2 - 6);
          ctx.font = `9px ${fontFamily}`;
          ctx.fillText(dayOfWeekJa[dow], cx, y + labelColH / 2 + 9);
        });

        // 休日合計列ヘッダ
        const summaryX = tableX + labelColW + cellW * days.length;
        ctx.fillStyle = '#fafaf9';
        ctx.font = `500 11px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.fillText('休日', summaryX + summaryW / 2, y + labelColH / 2 - 5);
        ctx.font = `9px ${fontFamily}`;
        ctx.fillStyle = '#a8a29e';
        ctx.fillText('合計', summaryX + summaryW / 2, y + labelColH / 2 + 9);

        y += labelColH;

        // スタッフ行
        staff.forEach(s => {
          // 行背景の罫線
          ctx.strokeStyle = '#e7e5e4';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(tableX, y + cellH);
          ctx.lineTo(tableX + tableWidth, y + cellH);
          ctx.stroke();

          // 名前列
          ctx.fillStyle = '#1c1917';
          ctx.font = `500 12px ${fontFamily}`;
          ctx.textAlign = 'left';
          ctx.fillText(s.name, tableX + 8, y + cellH / 2 - 4);
          ctx.fillStyle = '#a8a29e';
          ctx.font = `9px ${fontFamily}`;
          ctx.fillText(s.type === STAFF_TYPE.MAMA ? 'ママさん' : '社員', tableX + 8, y + cellH / 2 + 10);

          // 名前列区切り
          ctx.strokeStyle = '#1c1917';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(tableX + labelColW, y);
          ctx.lineTo(tableX + labelColW, y + cellH);
          ctx.stroke();

          // 日付列
          days.forEach((d, idx) => {
            const ds = dateStrs[idx];
            const cx = tableX + labelColW + cellW * idx;
            const dow = d.getDay();
            const isHol = isHoliday(d);
            const dowBg = (dow === 0 || isHol) ? '#fef2f2' : (dow === 6 ? '#f0f9ff' : null);

            if (dowBg) {
              ctx.fillStyle = dowBg;
              ctx.fillRect(cx, y, cellW, cellH);
            }

            const v = generatedShifts[s.id]?.[ds];
            const vNorm = normalizeForDisplay(v);
            const note = cellNotes[s.id]?.[ds];
            if (vNorm && colorMap[vNorm]) {
              const c = colorMap[vNorm];
              ctx.fillStyle = c.bg;
              ctx.fillRect(cx + 2, y + 3, cellW - 4, cellH - 6);
              ctx.strokeStyle = c.border;
              ctx.lineWidth = 1;
              ctx.strokeRect(cx + 2, y + 3, cellW - 4, cellH - 6);
              ctx.fillStyle = c.fg;
              if (note) {
                // ラベル(上) + メモ(下)
                ctx.font = `500 11px ${fontFamily}`;
                ctx.textAlign = 'center';
                ctx.fillText(labelMap[vNorm] || '', cx + cellW / 2, y + cellH / 2 - 6);
                // メモはセル幅に応じてサイズ調整
                const maxNoteWidth = cellW - 6;
                const tryFont = (size) => {
                  ctx.font = `${size}px ${fontFamily}`;
                  return ctx.measureText(note).width <= maxNoteWidth;
                };
                if (tryFont(8)) {
                  ctx.fillText(note, cx + cellW / 2, y + cellH / 2 + 7);
                } else if (tryFont(7)) {
                  ctx.fillText(note, cx + cellW / 2, y + cellH / 2 + 7);
                } else {
                  ctx.font = `6px ${fontFamily}`;
                  ctx.fillText(note, cx + cellW / 2, y + cellH / 2 + 7);
                }
              } else {
                ctx.font = `500 11px ${fontFamily}`;
                ctx.textAlign = 'center';
                ctx.fillText(labelMap[vNorm] || '', cx + cellW / 2, y + cellH / 2);
              }
            } else {
              ctx.fillStyle = '#d6d3d1';
              ctx.font = `10px ${fontFamily}`;
              ctx.textAlign = 'center';
              ctx.fillText('—', cx + cellW / 2, y + cellH / 2);
            }
          });

          // 休日合計セル
          const summaryX = tableX + labelColW + cellW * days.length;
          const offDays = staffOffCount[s.id] || 0;
          const minOff = s.minOffDays ?? 8;
          const maxOff = s.maxOffDays;
          const isUnder = offDays < minOff;
          const isOver = maxOff !== undefined && offDays > maxOff;
          const numColor = isUnder ? '#be123c' : isOver ? '#a16207' : '#1c1917';
          const summaryBg = isUnder ? '#fef2f2' : isOver ? '#fef3c7' : '#fafaf9';

          ctx.fillStyle = summaryBg;
          ctx.fillRect(summaryX, y, summaryW, cellH);
          // 区切り線
          ctx.strokeStyle = '#1c1917';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(summaryX, y);
          ctx.lineTo(summaryX, y + cellH);
          ctx.stroke();

          ctx.fillStyle = numColor;
          ctx.font = `700 18px ${fontFamily}`;
          ctx.textAlign = 'center';
          // 整数なら整数、小数なら小数表示
          const offDisplay = Number.isInteger(offDays) ? offDays : offDays.toFixed(1);
          ctx.fillText(`${offDisplay}`, summaryX + summaryW / 2, y + cellH / 2 - 3);
          ctx.fillStyle = '#a8a29e';
          ctx.font = `8px ${fontFamily}`;
          const rangeStr = maxOff !== undefined ? `${minOff}〜${maxOff}日` : `最低${minOff}日`;
          ctx.fillText(rangeStr, summaryX + summaryW / 2, y + cellH / 2 + 12);

          y += cellH;
        });

        // ヘルプ枠行
        ctx.fillStyle = '#fefce8';
        ctx.fillRect(tableX, y, tableWidth, cellH);
        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tableX, y);
        ctx.lineTo(tableX + tableWidth, y);
        ctx.stroke();

        ctx.fillStyle = '#713f12';
        ctx.font = `500 12px ${fontFamily}`;
        ctx.textAlign = 'left';
        ctx.fillText('ヘルプ枠', tableX + 8, y + cellH / 2 - 4);
        ctx.fillStyle = '#a16207';
        ctx.font = `9px ${fontFamily}`;
        ctx.fillText('他店舗応援·中番', tableX + 8, y + cellH / 2 + 10);

        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tableX + labelColW, y);
        ctx.lineTo(tableX + labelColW, y + cellH);
        ctx.stroke();

        days.forEach((d, idx) => {
          const ds = dateStrs[idx];
          const cx = tableX + labelColW + cellW * idx;
          const helpType = helpAssignments?.[ds];
          const helpStill = helpNeeded?.[ds];
          if (helpType) {
            ctx.fillStyle = '#fde047';
            ctx.fillRect(cx + 2, y + 3, cellW - 4, cellH - 6);
            ctx.strokeStyle = '#ca8a04';
            ctx.lineWidth = 2;
            ctx.strokeRect(cx + 2, y + 3, cellW - 4, cellH - 6);
            ctx.fillStyle = '#713f12';
            const timeNote = helpTimeNotes?.[ds];
            if (timeNote) {
              // 「中」を上に表示
              ctx.font = `700 10px ${fontFamily}`;
              ctx.textAlign = 'center';
              ctx.fillText('中', cx + cellW / 2, y + cellH / 2 - 6);

              // 時間メモを下に。セル幅に収まるようフォント自動縮小、それでも入らなければ2行表示
              const maxTimeWidth = cellW - 6;
              const tryFont = (size) => {
                ctx.font = `600 ${size}px ${fontFamily}`;
                return ctx.measureText(timeNote).width <= maxTimeWidth;
              };
              if (tryFont(8)) {
                ctx.fillText(timeNote, cx + cellW / 2, y + cellH / 2 + 7);
              } else if (tryFont(7)) {
                ctx.fillText(timeNote, cx + cellW / 2, y + cellH / 2 + 7);
              } else if (timeNote.includes('-')) {
                // ハイフン区切りなら「11:30」「16:30」で2行に分ける
                const [from, to] = timeNote.split('-');
                ctx.font = `600 7px ${fontFamily}`;
                ctx.fillText(from, cx + cellW / 2, y + cellH / 2 + 4);
                ctx.fillText('〜' + to, cx + cellW / 2, y + cellH / 2 + 12);
              } else {
                // 区切りなしなら6pxまで縮小
                ctx.font = `600 6px ${fontFamily}`;
                ctx.fillText(timeNote, cx + cellW / 2, y + cellH / 2 + 7);
              }
            } else {
              ctx.font = `700 11px ${fontFamily}`;
              ctx.textAlign = 'center';
              ctx.fillText('中', cx + cellW / 2, y + cellH / 2 - 5);
              ctx.font = `700 8px ${fontFamily}`;
              ctx.fillText('HELP', cx + cellW / 2, y + cellH / 2 + 8);
            }
          } else if (helpStill) {
            ctx.fillStyle = '#fef2f2';
            ctx.fillRect(cx + 2, y + 3, cellW - 4, cellH - 6);
            ctx.strokeStyle = '#fb7185';
            ctx.lineWidth = 2;
            ctx.setLineDash([3, 2]);
            ctx.strokeRect(cx + 2, y + 3, cellW - 4, cellH - 6);
            ctx.setLineDash([]);
            ctx.fillStyle = '#be123c';
            ctx.font = `700 10px ${fontFamily}`;
            ctx.textAlign = 'center';
            ctx.fillText(`+${helpStill}`, cx + cellW / 2, y + cellH / 2);
          } else {
            ctx.fillStyle = '#d6d3d1';
            ctx.font = `10px ${fontFamily}`;
            ctx.textAlign = 'center';
            ctx.fillText('—', cx + cellW / 2, y + cellH / 2);
          }
        });

        // ヘルプ枠の合計セル
        const helpSummaryX = tableX + labelColW + cellW * days.length;
        const helpTotal = Object.keys(helpAssignments || {}).length;
        ctx.fillStyle = '#fefce8';
        ctx.fillRect(helpSummaryX, y, summaryW, cellH);
        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(helpSummaryX, y);
        ctx.lineTo(helpSummaryX, y + cellH);
        ctx.stroke();
        ctx.fillStyle = '#713f12';
        ctx.font = `700 18px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.fillText(`${helpTotal}`, helpSummaryX + summaryW / 2, y + cellH / 2 - 3);
        ctx.fillStyle = '#a16207';
        ctx.font = `8px ${fontFamily}`;
        ctx.fillText('日', helpSummaryX + summaryW / 2, y + cellH / 2 + 12);

        y += cellH;

        // ============== 人数行 (店舗にいる人数 = 出張除く・半休0.5・ヘルプ別) ==============
        ctx.fillStyle = '#f5f5f4';
        ctx.fillRect(tableX, y, tableWidth, cellH);
        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tableX, y);
        ctx.lineTo(tableX + tableWidth, y);
        ctx.stroke();

        // ラベル
        ctx.fillStyle = '#44403c';
        ctx.font = `600 12px ${fontFamily}`;
        ctx.textAlign = 'left';
        ctx.fillText('人数', tableX + 8, y + cellH / 2 - 4);
        ctx.fillStyle = '#78716c';
        ctx.font = `9px ${fontFamily}`;
        ctx.fillText('出張除·半休0.5', tableX + 8, y + cellH / 2 + 10);

        // 区切り線
        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(tableX + labelColW, y);
        ctx.lineTo(tableX + labelColW, y + cellH);
        ctx.stroke();

        // 各日の人数を計算して表示
        days.forEach((d, idx) => {
          const ds = dateStrs[idx];
          const cx = tableX + labelColW + cellW * idx;
          let total = 0;
          staff.forEach(s => {
            const v = generatedShifts[s.id]?.[ds];
            if (!v) return;
            if (v === 'OFF' || v === 'REQUEST_OFF' || v === 'TRIP') return; // 休・出張は除外
            if (v === 'HALF_OFF') total += 0.5;
            else total += 1; // 早/中/遅/早M(MAMA)/MT
          });
          // ヘルプ枠も店舗にいるのでカウント(他店舗応援だが店舗で勤務)
          if (helpAssignments?.[ds]) total += 1;
          // 数値表示 (整数なら整数、小数なら .5 表示)
          const display = total === Math.floor(total) ? `${total}` : `${total.toFixed(1)}`;
          ctx.fillStyle = '#1c1917';
          ctx.font = `700 14px ${fontFamily}`;
          ctx.textAlign = 'center';
          ctx.fillText(display, cx + cellW / 2, y + cellH / 2 + 4);
        });

        // 人数行の右端の合計セル(空白)
        const peopleSummaryX = tableX + labelColW + cellW * days.length;
        ctx.fillStyle = '#f5f5f4';
        ctx.fillRect(peopleSummaryX, y, summaryW, cellH);
        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(peopleSummaryX, y);
        ctx.lineTo(peopleSummaryX, y + cellH);
        ctx.stroke();

        y += cellH;

        ctx.strokeStyle = '#1c1917';
        ctx.lineWidth = 2;
        ctx.strokeRect(tableX, tableY, tableWidth, y - tableY);

      // イベント一覧セクション (visibleEventsがある場合のみ・横並びで折り返し)
      if (visibleEvents.length > 0) {
        y += 12;
        // タイトル
        ctx.fillStyle = '#44403c';
        ctx.font = `600 ${isMobile ? 11 : 12}px ${fontFamily}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText('■ 今月のイベント', padding, y + (isMobile ? 6 : 8));
        y += (isMobile ? 12 : 16) + 6;
        // 横並びレイアウト
        const itemSpacing = 16;
        const swatchW = 14;
        const swatchGap = 6;
        const availableWidth = canvasWidth - padding * 2;
        let curX = padding;
        ctx.font = `${isMobile ? 10 : 11}px ${fontFamily}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        visibleEvents.forEach(ev => {
          const c = eventColorHex[ev.color] || eventColorHex.amber;
          const startD = ev.dateStart.split('-');
          const endStr = ev.dateEnd || ev.dateStart;
          const endD = endStr.split('-');
          const dateLabel = (ev.dateStart === endStr)
            ? `${parseInt(startD[1])}/${parseInt(startD[2])}`
            : `${parseInt(startD[1])}/${parseInt(startD[2])} 〜 ${parseInt(endD[1])}/${parseInt(endD[2])}`;
          const name = ev.name || '(無題)';
          const text = `${name} (${dateLabel})`;
          const itemW = swatchW + swatchGap + ctx.measureText(text).width;

          // 行末を超えそうなら改行
          if (curX > padding && (curX - padding) + itemW > availableWidth) {
            curX = padding;
            y += eventListLineH;
          }

          // 色付き四角
          ctx.fillStyle = c.bg;
          ctx.fillRect(curX, y + 2, swatchW, eventListLineH - 6);
          ctx.strokeStyle = c.text;
          ctx.lineWidth = 1;
          ctx.strokeRect(curX, y + 2, swatchW, eventListLineH - 6);
          // テキスト
          ctx.fillStyle = '#1c1917';
          ctx.fillText(text, curX + swatchW + swatchGap, y + eventListLineH / 2);

          curX += itemW + itemSpacing;
        });
        // 最後の行の高さ分も含めて進める
        y += eventListLineH + 4;
      }

      // 凡例
      y += 16;
      const legendItems = [
        { label: '早 9:30-18:30', ...colorMap.EARLY },
        { label: 'ママ早 9:30-16:30', ...colorMap.MAMA },
        { label: '中 10:30-19:30', ...colorMap.MIDDLE },
        { label: '遅 11:30-20:30', ...colorMap.LATE },
        { label: 'MT(時間はマス内メモ)', ...colorMap.MT },
        { label: '半休(0.5日休扱い)', ...colorMap.HALF_OFF },
        { label: '出張(店舗外)', ...colorMap.TRIP },
        { label: '希望休', ...colorMap.REQUEST_OFF },
        { label: 'ヘルプ', bg: '#fde047', fg: '#713f12', border: '#ca8a04' },
      ];

      let lx = padding;
      let ly = y;
      ctx.font = `10px ${fontFamily}`;
      legendItems.forEach(item => {
        const w = ctx.measureText(item.label).width + 12;
        if (lx + w > canvasWidth - padding) {
          lx = padding;
          ly += 22;
        }
        ctx.fillStyle = item.bg;
        ctx.fillRect(lx, ly, w, 18);
        ctx.strokeStyle = item.border;
        ctx.lineWidth = 1;
        ctx.strokeRect(lx, ly, w, 18);
        ctx.fillStyle = item.fg;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(item.label, lx + w / 2, ly + 9);
        lx += w + 4;
      });

      // フッター
      ly += 30;
      ctx.fillStyle = '#a8a29e';
      ctx.font = `9px ${fontFamily}`;
      ctx.textAlign = 'center';
      ctx.fillText('— SHIFT ATELIER —', canvasWidth / 2, ly);

      // ダウンロード
      const baseName = customFileName.trim() || `shift_${periodMonth.year}-${String(periodMonth.month).padStart(2, '0')}_${mode}`;
      const fileName = baseName.endsWith('.png') ? baseName : `${baseName}.png`;
      canvas.toBlob((blob) => {
        if (!blob) {
          alert('画像の生成に失敗しました');
          setExporting(false);
          return;
        }
        const url = URL.createObjectURL(blob);

        // 画像をプレビューモーダルで表示（保存方法を選択するため）
        setExportedImageUrl({ url, fileName, blob, mode });

        // ダウンロードを試みる（PCブラウザならこれで保存される）
        try {
          const link = document.createElement('a');
          link.download = fileName;
          link.href = url;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } catch (e) {
          console.warn('ダウンロード失敗、プレビューで表示します:', e);
        }
        setExporting(false);
      }, 'image/png');

    } catch (error) {
      console.error('画像出力エラー:', error);
      alert('画像の生成に失敗しました: ' + error.message);
      setExporting(false);
    }
  };

  const addStaff = () => {
    const id = `s${Date.now()}`;
    setStaff(prev => [...prev, { id, name: '新規スタッフ', type: STAFF_TYPE.EMPLOYEE, minOffDays: 8, maxOffDays: 10 }]);
  };

  const updateStaff = (id, patch) => {
    setStaff(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));
  };

  // スタッフ削除（Claude.ai では confirm() がブロックされるためモーダルで確認）
  const [pendingDeleteStaffId, setPendingDeleteStaffId] = useState(null);
  const removeStaff = (id) => {
    setPendingDeleteStaffId(id);
  };
  const confirmRemoveStaff = () => {
    const id = pendingDeleteStaffId;
    if (!id) return;
    setStaff(prev => prev.filter(s => s.id !== id));
    // そのスタッフに紐づくデータもまとめてクリア
    setFixedShifts(prev => { const n = { ...prev }; delete n[id]; return n; });
    setManualLocks(prev => { const n = { ...prev }; delete n[id]; return n; });
    setGeneratedShifts(prev => {
      if (!prev) return prev;
      const n = { ...prev };
      delete n[id];
      return n;
    });
    setPendingDeleteStaffId(null);
  };
  const cancelRemoveStaff = () => setPendingDeleteStaffId(null);

  const toggleFixedShift = (staffId, dateStr, type) => {
    setFixedShifts(prev => {
      const next = { ...prev };
      if (!next[staffId]) next[staffId] = {};
      else next[staffId] = { ...next[staffId] };
      if (next[staffId][dateStr] === type) {
        delete next[staffId][dateStr];
      } else {
        next[staffId][dateStr] = type;
      }
      return next;
    });
  };

  const setDayRequired = (dateStr, count) => {
    setRequiredByDate(prev => {
      const next = { ...prev };
      if (count === null || count === '' || isNaN(count)) {
        delete next[dateStr];
      } else {
        next[dateStr] = Number(count);
      }
      return next;
    });
  };

  const changePeriod = (delta) => {
    setPeriodMonth(prev => {
      let m = prev.month + delta, y = prev.year;
      if (m > 12) { m = 1; y++; }
      if (m < 1) { m = 12; y--; }
      return { year: y, month: m };
    });
    // 月をまたぐ際にリセットする項目（スタッフ情報・連勤ルール=minOffDays/maxOffDaysは
    // staff state にあるのでそのまま引き継がれる）
    setGeneratedShifts(null);
    setFixedShifts({});           // 希望休・MTは月ごとにリセット
    setManualLocks({});            // 手動編集ロックも月ごとにリセット
    setRequiredByDate({});         // 日別の必要人数調整もリセット
    setExemptions({ allowFiveDay: {}, allowFourthRule: {} }); // 連勤例外もリセット
    setHelpAssignments({});        // ヘルプ配置もリセット
    setHelpNeeded({});
    setHelpTimeNotes({});           // ヘルプ時間メモもリセット
    setCellNotes({});               // セルメモも月ごとにリセット
    // 注: events(店舗イベント)は月跨ぎがあり得るので月送り時にはクリアしない
    setAppliedActions([]);         // 適用履歴もクリア
    setSuggestions([]);
    setGlobalIssues([]);
    setHighlightedCells(new Set());
    setLastApplyResult(null);
    setEditingCell(null);
    setSelectedStaffId(null);
  };

  // ============== サマリ計算 ==============
  const summary = useMemo(() => {
    if (!generatedShifts) return null;
    return effectiveStaff.map(s => {
      const counts = { EARLY: 0, MAMA: 0, MIDDLE: 0, LATE: 0, OFF: 0, REQUEST_OFF: 0, MT: 0, TRIP: 0, HALF_OFF: 0 };
      dateStrs.forEach(ds => {
        const v = generatedShifts[s.id]?.[ds] || 'OFF';
        // 旧形式のMT_EARLY/MT_MIDDLE/MT_LATE は MT に集約
        const key = isMTShift(v) ? 'MT' : v;
        counts[key] = (counts[key] || 0) + 1;
      });
      const mtTotal = counts.MT || 0;
      const tripTotal = counts.TRIP || 0;
      const halfOffTotal = counts.HALF_OFF || 0;
      // 出勤日数: 通常勤務 + MT + 出張 + 半休(出勤扱い・0.5日)
      const workDays = counts.EARLY + counts.MAMA + counts.MIDDLE + counts.LATE + mtTotal + tripTotal + halfOffTotal * 0.5;
      // 休日数: 通常休 + 希望休 + 半休(0.5日)
      const offDays = counts.OFF + counts.REQUEST_OFF + halfOffTotal * 0.5;
      // 連勤最大(半休も連勤に含む)
      let maxConsec = 0, run = 0;
      dateStrs.forEach(ds => {
        const v = generatedShifts[s.id]?.[ds];
        if (v && v !== 'OFF' && v !== 'REQUEST_OFF') {
          run++;
          maxConsec = Math.max(maxConsec, run);
        } else {
          run = 0;
        }
      });
      return { staff: s, counts, workDays, offDays, maxConsec, mtTotal, tripTotal, halfOffTotal };
    });
  }, [generatedShifts, effectiveStaff, dateStrs]);

  // ============== レンダリング ==============
  const tabs = [
    { id: 'shift', label: 'シフト表', icon: Calendar },
    { id: 'requests', label: '希望休・MT', icon: Coffee },
    { id: 'calendar', label: 'カレンダー', icon: AlertTriangle },
    { id: 'suggestions', label: '改善提案', icon: Sparkles, badge: suggestions.length + globalIssues.length },
    { id: 'staff', label: 'スタッフ', icon: Users },
    { id: 'summary', label: '集計', icon: BarChart3 },
  ];

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900" style={{ fontFamily: "'Noto Serif JP', 'Hiragino Mincho ProN', serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@300;400;500;700&family=Noto+Sans+JP:wght@300;400;500;700&family=Cormorant+Garamond:wght@400;500;600&display=swap');
        .font-display { font-family: 'Cormorant Garamond', 'Noto Serif JP', serif; }
        .font-sans-jp { font-family: 'Noto Sans JP', sans-serif; }
        .seal {
          display: inline-flex; align-items: center; justify-content: center;
          background: #8b1c1c; color: #fef3c7; padding: 4px 10px;
          font-family: 'Noto Serif JP', serif; font-weight: 500; letter-spacing: 0.15em;
          font-size: 11px; transform: rotate(-2deg);
        }
        .grid-paper {
          background-image: linear-gradient(rgba(120,113,108,0.08) 1px, transparent 1px),
                          linear-gradient(90deg, rgba(120,113,108,0.08) 1px, transparent 1px);
          background-size: 24px 24px;
        }
        .scroll-shadow::-webkit-scrollbar { height: 8px; width: 8px; }
        .scroll-shadow::-webkit-scrollbar-track { background: #f5f5f4; }
        .scroll-shadow::-webkit-scrollbar-thumb { background: #a8a29e; border-radius: 4px; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in { animation: fadeIn 0.4s ease-out; }
        @keyframes highlightPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(217, 119, 6, 0); transform: scale(1); }
          15% { box-shadow: 0 0 0 4px rgba(217, 119, 6, 0.5); transform: scale(1.05); }
          50% { box-shadow: 0 0 0 3px rgba(217, 119, 6, 0.4); transform: scale(1.02); }
        }
        .highlight-pulse {
          animation: highlightPulse 2s ease-in-out infinite;
          position: relative;
          z-index: 5;
        }
        @keyframes slideInRight {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .toast-in { animation: slideInRight 0.4s ease-out; }
      `}</style>

      {/* ヘッダー */}
      <header className="border-b-2 border-stone-900 bg-white">
        <div className="max-w-[1400px] mx-auto px-4 sm:px-8 py-3 sm:py-6">
          {/* スマホは縦2段、PCは横1段 */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
            {/* 上段: ロゴ */}
            <div className="flex items-center gap-2 sm:gap-5">
              <div className="seal">勤務表</div>
              <div>
                <h1 className="font-display text-lg sm:text-3xl font-medium tracking-wide">Shift Atelier</h1>
                <p className="hidden sm:block text-[10px] sm:text-xs text-stone-500 tracking-[0.2em] sm:tracking-[0.3em] mt-0.5 font-sans-jp">シフト自動編成システム</p>
              </div>
            </div>
            {/* 下段: 月送り (スマホは横幅100%, PCは右寄せ) */}
            <div className="flex items-center justify-between sm:justify-end gap-1 sm:gap-3 w-full sm:w-auto border-t sm:border-0 border-stone-200 pt-2 sm:pt-0">
              <button
                onClick={() => changePeriod(-1)}
                className="p-2 hover:bg-stone-100 rounded-full transition flex-shrink-0"
                aria-label="前の月"
              >
                <ChevronLeft size={20} />
              </button>
              <div className="text-center flex-1 sm:flex-initial sm:min-w-[180px]">
                <div className="font-display text-lg sm:text-2xl leading-tight">{periodMonth.year}年{periodMonth.month}月期</div>
                <div className="text-[10px] sm:text-xs text-stone-500 font-sans-jp">
                  {periodMonth.month}/11 — {periodMonth.month === 12 ? periodMonth.year + 1 : periodMonth.year}/{periodMonth.month === 12 ? 1 : periodMonth.month + 1}/10
                </div>
              </div>
              <button
                onClick={() => changePeriod(1)}
                className="p-2 hover:bg-stone-100 rounded-full transition flex-shrink-0"
                aria-label="次の月"
              >
                <ChevronRight size={20} />
              </button>
            </div>
          </div>
        </div>

        {/* タブ */}
        <div className="max-w-[1400px] mx-auto px-2 sm:px-8 flex gap-1 border-t border-stone-200 overflow-x-auto scroll-shadow">
          {tabs.map(t => {
            const Icon = t.icon;
            const isActive = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-3 text-xs sm:text-sm font-sans-jp transition relative whitespace-nowrap flex-shrink-0 ${
                  isActive ? 'text-stone-900' : 'text-stone-500 hover:text-stone-700'
                }`}
              >
                <Icon size={15} />
                {t.label}
                {t.badge > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[10px] font-bold bg-amber-500 text-white rounded-full">
                    {t.badge}
                  </span>
                )}
                {isActive && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-800" />}
              </button>
            );
          })}
          <div className="ml-auto flex items-center pl-2 flex-shrink-0">
            <button
              onClick={resetAndGenerate}
              className="flex items-center gap-2 bg-stone-900 text-stone-50 px-3 sm:px-5 py-2 my-1.5 hover:bg-red-900 transition text-xs sm:text-sm font-sans-jp tracking-wider whitespace-nowrap"
            >
              <Sparkles size={15} />
              自動編成
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-4 sm:px-8 py-6 sm:py-8 fade-in" key={activeTab}>
        {/* シフト表 */}
        {activeTab === 'shift' && (
          <ShiftTable
            staff={effectiveStaff}
            days={days}
            dateStrs={dateStrs}
            generatedShifts={generatedShifts}
            fixedShifts={fixedShifts}
            manualLocks={manualLocks}
            requiredByDate={requiredByDate}
            effectiveRequiredByDate={effectiveRequiredByDate}
            helpNeeded={helpNeeded}
            helpAssignments={helpAssignments}
            setDayRequired={setDayRequired}
            editingCell={editingCell}
            setEditingCell={setEditingCell}
            updateShiftCell={updateShiftCell}
            unlockShiftCell={unlockShiftCell}
            toggleHelpCell={toggleHelpCell}
            highlightedCells={highlightedCells}
            lastApplyResult={lastApplyResult}
            exportShiftAsImage={exportShiftAsImage}
            exporting={exporting}
            summary={summary}
            customFileName={customFileName}
            setCustomFileName={setCustomFileName}
            events={events}
            setEvents={setEvents}
            helpTimeNotes={helpTimeNotes}
            setHelpTimeNotes={setHelpTimeNotes}
            cellNotes={cellNotes}
            updateCellNote={updateCellNote}
          />
        )}

        {/* 希望休・MT */}
        {activeTab === 'requests' && (
          <RequestsView
            staff={effectiveStaff}
            days={days}
            dateStrs={dateStrs}
            fixedShifts={fixedShifts}
            toggleFixedShift={toggleFixedShift}
            selectedStaffId={selectedStaffId}
            setSelectedStaffId={setSelectedStaffId}
          />
        )}

        {/* カレンダー（ヘルプ要請） */}
        {activeTab === 'calendar' && (
          <CalendarView
            days={days}
            dateStrs={dateStrs}
            helpNeeded={helpNeeded}
            helpAssignments={helpAssignments}
            requiredByDate={requiredByDate}
            effectiveRequiredByDate={effectiveRequiredByDate}
            generatedShifts={generatedShifts}
            staff={effectiveStaff}
          />
        )}

        {/* 改善提案 */}
        {activeTab === 'suggestions' && (
          <SuggestionsView
            suggestions={suggestions}
            globalIssues={globalIssues}
            generatedShifts={generatedShifts}
            staff={effectiveStaff}
            applyAction={applyAction}
            undoAction={undoAction}
            appliedActions={appliedActions}
            setActiveTab={setActiveTab}
          />
        )}

        {/* スタッフ管理 */}
        {activeTab === 'staff' && (
          <StaffManagement
            staff={staff}
            addStaff={addStaff}
            updateStaff={updateStaff}
            removeStaff={removeStaff}
            onResetAll={() => setShowResetConfirm(true)}
            monthlyOverrides={monthlyOverrides[periodKey] || {}}
            setMonthlyStaffOverride={setMonthlyStaffOverride}
            resetMonthlyStaffOverride={resetMonthlyStaffOverride}
            periodMonth={periodMonth}
            defaultRequiredConfig={defaultRequiredConfig}
            setDefaultRequiredConfig={setDefaultRequiredConfig}
          />
        )}

        {/* 集計 */}
        {activeTab === 'summary' && (
          <SummaryView summary={summary} generatedShifts={generatedShifts} helpAssignments={helpAssignments} />
        )}
      </main>

      {/* 画像プレビューモーダル（スマホでも保存できるように複数の経路を提供） */}
      {exportedImageUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onClick={() => {
            URL.revokeObjectURL(exportedImageUrl.url);
            setExportedImageUrl(null);
          }}
        >
          <div
            className="bg-white border-2 border-stone-900 max-w-3xl w-full max-h-[90vh] overflow-auto"
            onClick={e => e.stopPropagation()}
          >
            <div className="bg-stone-900 text-stone-50 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
              <div className="font-sans-jp">
                <span className="font-display text-lg">勤務表 画像出力</span>
                <span className="text-xs text-stone-300 ml-2 break-all">{exportedImageUrl.fileName}</span>
              </div>
              <button
                onClick={() => {
                  URL.revokeObjectURL(exportedImageUrl.url);
                  setExportedImageUrl(null);
                }}
                className="text-stone-400 hover:text-white text-2xl leading-none ml-2 flex-shrink-0"
              >
                ×
              </button>
            </div>
            <div className="p-4">
              {/* 保存方法のボタン群 */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
                {/* ① 共有（スマホで最も確実） */}
                <button
                  onClick={async () => {
                    try {
                      const file = new File([exportedImageUrl.blob], exportedImageUrl.fileName, { type: 'image/png' });
                      if (navigator.canShare && navigator.canShare({ files: [file] })) {
                        await navigator.share({
                          files: [file],
                          title: exportedImageUrl.fileName,
                        });
                      } else {
                        alert('お使いの環境では共有機能が使えません。下の「画像を長押し」または「新しいタブで開く」をお試しください。');
                      }
                    } catch (e) {
                      if (e.name !== 'AbortError') {
                        console.warn('share failed:', e);
                        alert('共有に失敗しました: ' + e.message);
                      }
                    }
                  }}
                  className="flex items-center justify-center gap-2 bg-amber-700 text-amber-50 px-3 py-3 hover:bg-amber-800 transition text-sm font-sans-jp font-medium"
                >
                  📤 共有 / 写真に保存
                </button>
                {/* ② 新しいタブで開く */}
                <button
                  onClick={() => {
                    try {
                      window.open(exportedImageUrl.url, '_blank');
                    } catch (e) {
                      alert('新しいタブを開けませんでした: ' + e.message);
                    }
                  }}
                  className="flex items-center justify-center gap-2 bg-stone-700 text-stone-50 px-3 py-3 hover:bg-stone-900 transition text-sm font-sans-jp font-medium"
                >
                  🔗 新しいタブで開く
                </button>
                {/* ③ クリップボードにコピー */}
                <button
                  onClick={async () => {
                    try {
                      if (navigator.clipboard && window.ClipboardItem) {
                        await navigator.clipboard.write([
                          new ClipboardItem({ 'image/png': exportedImageUrl.blob })
                        ]);
                        alert('画像をクリップボードにコピーしました');
                      } else {
                        alert('お使いの環境ではコピー機能が使えません。');
                      }
                    } catch (e) {
                      console.warn('copy failed:', e);
                      alert('コピーに失敗しました: ' + e.message);
                    }
                  }}
                  className="flex items-center justify-center gap-2 bg-stone-100 text-stone-900 border border-stone-400 px-3 py-3 hover:bg-stone-200 transition text-sm font-sans-jp font-medium"
                >
                  📋 画像をコピー
                </button>
              </div>

              {/* 保存方法の説明 */}
              <div className="text-xs text-stone-700 font-sans-jp mb-3 bg-amber-50 border border-amber-300 p-3 leading-relaxed">
                <div className="font-medium mb-1.5 text-amber-900">📥 保存方法（おすすめ順）</div>
                <ol className="list-decimal pl-5 space-y-1 text-stone-700">
                  <li><strong>スマホ</strong>: 上の「📤 共有」ボタン → 共有シートから「写真に保存」「ファイルに保存」を選択（ファイル名もそのまま反映）</li>
                  <li><strong>PC</strong>: 自動でダウンロードフォルダに保存されます。されなければ画像を右クリック → 「名前を付けて画像を保存」</li>
                  <li><strong>うまく動かない場合</strong>: 下の画像を<strong>長押し</strong>(スマホ) または <strong>右クリック</strong>(PC) → 「画像を保存」</li>
                  <li><strong>最終手段</strong>: 「🔗 新しいタブで開く」→ 表示されたページから保存</li>
                </ol>
              </div>

              {/* 画像本体 */}
              <img
                src={exportedImageUrl.url}
                alt={exportedImageUrl.fileName}
                className="w-full border border-stone-300"
                style={{ imageRendering: 'crisp-edges' }}
              />

              {/* 閉じるボタン */}
              <div className="mt-3 flex justify-end">
                <button
                  onClick={() => {
                    URL.revokeObjectURL(exportedImageUrl.url);
                    setExportedImageUrl(null);
                  }}
                  className="px-4 py-2 text-sm font-sans-jp text-stone-600 border border-stone-300 hover:border-stone-900"
                >
                  閉じる
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* スタッフ削除確認モーダル */}
      {pendingDeleteStaffId && (() => {
        const target = staff.find(s => s.id === pendingDeleteStaffId);
        if (!target) return null;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={cancelRemoveStaff}
          >
            <div
              className="bg-white border-2 border-stone-900 max-w-sm w-full"
              onClick={e => e.stopPropagation()}
            >
              <div className="bg-stone-900 text-stone-50 px-4 py-3 font-display text-lg">
                スタッフ削除の確認
              </div>
              <div className="p-5 font-sans-jp text-sm text-stone-700 space-y-3">
                <div>
                  <span className="font-medium text-stone-900">{target.name}</span> さんを削除しますか?
                </div>
                <div className="text-xs text-stone-500 leading-relaxed">
                  この期間のシフト・希望休・MTもまとめて削除されます。次月以降のスタッフ一覧からも除外されます。
                </div>
              </div>
              <div className="px-5 pb-5 flex gap-2 justify-end">
                <button
                  onClick={cancelRemoveStaff}
                  className="px-4 py-2 text-sm font-sans-jp text-stone-600 border border-stone-300 hover:border-stone-900"
                >
                  キャンセル
                </button>
                <button
                  onClick={confirmRemoveStaff}
                  className="px-4 py-2 text-sm font-sans-jp bg-rose-700 text-white hover:bg-rose-800"
                >
                  削除する
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* 全データリセット確認モーダル */}
      {showResetConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={() => setShowResetConfirm(false)}
        >
          <div
            className="bg-white border-2 border-stone-900 max-w-sm w-full"
            onClick={e => e.stopPropagation()}
          >
            <div className="bg-rose-900 text-rose-50 px-4 py-3 font-display text-lg">
              ⚠ 全データの初期化
            </div>
            <div className="p-5 font-sans-jp text-sm text-stone-700 space-y-3">
              <div className="font-medium text-stone-900">本当にすべてのデータを初期化しますか?</div>
              <div className="text-xs text-stone-500 leading-relaxed">
                以下のデータがすべて消去されます:
              </div>
              <ul className="text-xs text-stone-600 list-disc list-inside space-y-0.5 pl-2">
                <li>登録されている全スタッフ情報</li>
                <li>過去・現在の月のシフト編成結果</li>
                <li>希望休・MT・出張・手動編集</li>
                <li>必要人数の個別設定・連勤例外・適用履歴</li>
              </ul>
              <div className="text-xs text-rose-700 font-medium pt-2">この操作は取り消せません。</div>
            </div>
            <div className="px-5 pb-5 flex gap-2 justify-end">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="px-4 py-2 text-sm font-sans-jp text-stone-600 border border-stone-300 hover:border-stone-900"
              >
                キャンセル
              </button>
              <button
                onClick={performResetAllData}
                className="px-4 py-2 text-sm font-sans-jp bg-rose-700 text-white hover:bg-rose-800"
              >
                初期化する
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-stone-200 mt-16 py-6 text-center text-xs text-stone-400 font-sans-jp tracking-[0.2em]">
        — SHIFT ATELIER · 制作年 二〇二六 —
      </footer>
    </div>
  );
}

// ============== シフト表コンポーネント ==============
function ShiftTable({ staff, days, dateStrs, generatedShifts, fixedShifts, manualLocks, requiredByDate, effectiveRequiredByDate = {}, helpNeeded, helpAssignments, setDayRequired, editingCell, setEditingCell, updateShiftCell, unlockShiftCell, toggleHelpCell, highlightedCells, lastApplyResult, exportShiftAsImage, exporting, summary, customFileName, setCustomFileName, events = [], setEvents, helpTimeNotes = {}, setHelpTimeNotes, cellNotes = {}, updateCellNote }) {
  // ガイドバナーの表示/非表示 (localStorageに保存して次回以降も継続)
  const [guideHidden, setGuideHidden] = useState(() => loadFromStorage('guideHidden', false));
  useEffect(() => { saveToStorage('guideHidden', guideHidden); }, [guideHidden]);

  // イベント編集モーダル
  const [editingEventDate, setEditingEventDate] = useState(null); // クリックされた日付(モーダル開閉)
  // ヘルプ時間入力モーダル
  const [editingHelpTime, setEditingHelpTime] = useState(null); // 編集中の日付

  // 起動時 (またはイベント数変化時) に既存データの不正期間を1度だけ補正
  // 終了日 < 開始日 のイベントは終了日を開始日に揃える
  useEffect(() => {
    const hasInvalid = events.some(ev => {
      const dEnd = ev.dateEnd || ev.dateStart;
      return ev.dateStart && dEnd && dEnd < ev.dateStart;
    });
    if (hasInvalid && setEvents) {
      setEvents(prev => prev.map(ev => {
        const dEnd = ev.dateEnd || ev.dateStart;
        if (ev.dateStart && dEnd && dEnd < ev.dateStart) {
          return { ...ev, dateEnd: ev.dateStart };
        }
        return ev;
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  // イベント色のパレット
  const EVENT_COLORS = [
    { id: 'rose', label: '赤', bg: 'bg-rose-200', text: 'text-rose-900', border: 'border-rose-400' },
    { id: 'orange', label: '橙', bg: 'bg-orange-200', text: 'text-orange-900', border: 'border-orange-400' },
    { id: 'amber', label: '黄', bg: 'bg-amber-200', text: 'text-amber-900', border: 'border-amber-500' },
    { id: 'emerald', label: '緑', bg: 'bg-emerald-200', text: 'text-emerald-900', border: 'border-emerald-400' },
    { id: 'sky', label: '青', bg: 'bg-sky-200', text: 'text-sky-900', border: 'border-sky-400' },
    { id: 'violet', label: '紫', bg: 'bg-violet-200', text: 'text-violet-900', border: 'border-violet-400' },
  ];
  const getEventColor = (id) => EVENT_COLORS.find(c => c.id === id) || EVENT_COLORS[0];

  // 指定日に該当するイベントの配列を取得
  const eventsOnDate = (ds) => events.filter(ev => ds >= ev.dateStart && ds <= (ev.dateEnd || ev.dateStart));
  // 指定日のイベント描画用情報: 期間の始まり/終わり/中間を判定
  const eventBarsForDate = (ds) => {
    return eventsOnDate(ds).map(ev => {
      const isStart = ds === ev.dateStart;
      const isEnd = ds === (ev.dateEnd || ev.dateStart);
      return { ev, isStart, isEnd, isSingle: isStart && isEnd };
    });
  };

  // イベント追加
  const addEvent = (dateStr) => {
    const newEv = {
      id: `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: '',
      dateStart: dateStr,
      dateEnd: dateStr,
      color: 'amber',
    };
    setEvents(prev => [...prev, newEv]);
    return newEv.id;
  };
  // イベント編集の警告メッセージ {eventId: 警告文字列}
  const [eventWarnings, setEventWarnings] = useState({});

  const updateEvent = (id, patch) => {
    setEvents(prev => prev.map(ev => {
      if (ev.id !== id) return ev;
      const merged = { ...ev, ...patch };
      // 日付の整合性チェック: 終了日 < 開始日 なら終了日を開始日に揃える
      const dStart = merged.dateStart;
      const dEnd = merged.dateEnd || merged.dateStart;
      if (dStart && dEnd && dEnd < dStart) {
        // どちらが直近で変更されたかで補正方針を変える
        if ('dateStart' in patch) {
          // 開始日が動いた場合、終了日を開始日に追従させる
          merged.dateEnd = dStart;
          setEventWarnings(prev => ({ ...prev, [id]: '終了日が開始日より前のため、終了日を開始日と同じに合わせました' }));
        } else if ('dateEnd' in patch) {
          // 終了日が動いた場合、開始日と同じ日に補正(=1日のみ扱い)
          merged.dateEnd = merged.dateStart;
          setEventWarnings(prev => ({ ...prev, [id]: '終了日が開始日より前のため、開始日と同じ日に補正しました(1日のみのイベント)' }));
        }
        // 警告は4秒後に自動で消す
        setTimeout(() => {
          setEventWarnings(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
        }, 4000);
      } else {
        // 整合性が回復したら警告も消す
        setEventWarnings(prev => {
          if (!prev[id]) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
      return merged;
    }));
  };
  const removeEvent = (id) => {
    setEvents(prev => prev.filter(ev => ev.id !== id));
  };

  const cellColor = (type) => {
    // 旧形式のMT_EARLY/MT_MIDDLE/MT_LATEも 'MT' として扱う
    const t = isMTShift(type) ? 'MT' : type;
    const map = {
      EARLY: 'bg-amber-100 text-amber-900 border-amber-300',
      MAMA: 'bg-rose-100 text-rose-900 border-rose-300',
      MIDDLE: 'bg-emerald-100 text-emerald-900 border-emerald-300',
      LATE: 'bg-sky-100 text-sky-900 border-sky-300',
      MT: 'bg-violet-100 text-violet-900 border-violet-300',
      HALF_OFF: 'bg-teal-100 text-teal-900 border-teal-300',
      TRIP: 'bg-indigo-100 text-indigo-900 border-indigo-400',
      REQUEST_OFF: 'bg-stone-200 text-stone-600 border-stone-300',
      OFF: 'bg-white text-stone-300 border-stone-200',
      HELP_EARLY: 'bg-yellow-300 text-yellow-900 border-yellow-600 border-2',
      HELP_MAMA: 'bg-yellow-300 text-yellow-900 border-yellow-600 border-2',
      HELP_MIDDLE: 'bg-yellow-300 text-yellow-900 border-yellow-600 border-2',
      HELP_LATE: 'bg-yellow-300 text-yellow-900 border-yellow-600 border-2',
    };
    return map[t] || map.OFF;
  };

  return (
    <div>
      {/* 適用結果トースト */}
      {lastApplyResult && (
        <div className="mb-4 toast-in bg-amber-50 border-l-4 border-amber-600 p-4 flex items-start gap-3">
          <Sparkles size={20} className="text-amber-700 mt-0.5 flex-shrink-0" />
          <div className="font-sans-jp flex-1">
            <div className="font-medium text-amber-900 text-sm">改善提案を適用しました</div>
            <div className="text-xs text-amber-700 mt-1">
              {lastApplyResult.label} ・ シフトが <strong>{lastApplyResult.changeCount}マス</strong> 変化しました
              {lastApplyResult.remainingShortage === 0
                ? ' ・ 全ての日が必要人数を満たしました 🎉'
                : ` ・ 残り不足日: ${lastApplyResult.remainingShortage}日`}
            </div>
            <div className="text-[10px] text-amber-600 mt-1">変更されたマスは橙色のリングでハイライトされています</div>
          </div>
        </div>
      )}

      <div className="mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[280px]">
          <h2 className="font-display text-2xl">勤務表</h2>
          <p className="text-xs text-stone-500 font-sans-jp mt-1">「自動編成」を押すと希望休・MT を踏まえて生成 · ＋／− で必要人数調整 · マスをタップで個別変更&メモ入力（手動変更したセルは🔒ロックされ再編成で上書きされません） · ヘルプ枠もタップで配置/解除 · 3人シフト日のママさんは1名まで</p>
        </div>

        {/* 画像出力ボタン */}
        {generatedShifts && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 flex-shrink-0 w-full sm:w-auto">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-stone-500 font-sans-jp tracking-wider whitespace-nowrap">ファイル名</span>
              <input
                type="text"
                value={customFileName}
                onChange={e => setCustomFileName(e.target.value)}
                placeholder="shift_2026-04（自動）"
                className="flex-1 sm:w-[180px] px-2 py-1.5 text-xs font-sans-jp border border-stone-300 focus:border-stone-900 focus:outline-none"
              />
              <span className="text-[10px] text-stone-400 font-sans-jp">.png</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => exportShiftAsImage('mobile')}
                disabled={exporting}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 bg-amber-700 text-amber-50 px-3 py-2 hover:bg-amber-800 transition text-xs font-sans-jp disabled:opacity-50 shadow-sm"
                title="スマホで見やすいコンパクトサイズの横長画像"
              >
                <Smartphone size={14} />
                {exporting ? '生成中…' : 'スマホ用'}
              </button>
              <button
                onClick={() => exportShiftAsImage('desktop')}
                disabled={exporting}
                className="flex-1 sm:flex-initial flex items-center justify-center gap-1.5 bg-stone-700 text-stone-50 px-3 py-2 hover:bg-stone-900 transition text-xs font-sans-jp disabled:opacity-50 shadow-sm"
                title="PC・印刷向けの大きめサイズの横長画像"
              >
                <Download size={14} />
                {exporting ? '生成中…' : 'PC用'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 初回利用ガイド（未編成時かつ閉じてない場合のみ表示） */}
      {!generatedShifts && !guideHidden && (
        <div className="mb-4 p-4 bg-stone-900 text-stone-100 border-l-4 border-amber-500 font-sans-jp text-xs leading-relaxed relative">
          <button
            onClick={() => setGuideHidden(true)}
            className="absolute top-2 right-2 text-stone-400 hover:text-white text-lg leading-none w-6 h-6 flex items-center justify-center"
            aria-label="ガイドを閉じる"
            title="ガイドを閉じる"
          >×</button>
          <div className="font-medium text-amber-300 mb-1.5 tracking-wider pr-8">ご利用の流れ</div>
          <ol className="space-y-0.5 list-decimal list-inside text-stone-200">
            <li>「スタッフ」タブでメンバーと最低/最大休日数を確認・編集</li>
            <li>「希望休・MT」タブで各スタッフの休み希望と会議日を入力</li>
            <li>右上の「自動編成」を押すとシフトが生成されます</li>
            <li>不足が出れば「改善提案」タブから自動調整できます</li>
          </ol>
          <div className="mt-2 pt-2 border-t border-stone-700 text-[11px] text-stone-400">
            ⚠ 月送り（◀▶）でスタッフ・連勤ルールは引き継がれますが、希望休・シフト編成結果は月ごとにリセットされます。<br />
            ✓ 入力データは自動でこの端末のブラウザに保存されます（同じ端末・同じブラウザで開けば、ブラウザを閉じても・リロードしても引き継がれます）。<br />
            ⚠ 別の端末・別のブラウザでは見えないので、共有したい場合は「スマホ用 / PC用」ボタンで画像保存してください。<br />
            ⚠ ブラウザのキャッシュ・サイトデータを削除すると保存データも消えるのでご注意ください。
          </div>
        </div>
      )}

      {/* ガイドが閉じている場合の再表示ボタン */}
      {!generatedShifts && guideHidden && (
        <div className="mb-3">
          <button
            onClick={() => setGuideHidden(false)}
            className="inline-flex items-center gap-1.5 text-xs text-stone-600 hover:text-stone-900 font-sans-jp px-3 py-1.5 border border-stone-300 hover:border-stone-700 hover:bg-stone-50 transition"
          >
            <span className="text-amber-600">ⓘ</span> ご利用の流れを表示
          </button>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2 text-xs font-sans-jp">
        {[
          ['EARLY', '早 9:30-18:30'],
          ['MAMA', 'ママ早 9:30-16:30'],
          ['MIDDLE', '中 10:30-19:30'],
          ['LATE', '遅 11:30-20:30'],
          ['MT', 'MT(時間はマス内メモ)'],
          ['HALF_OFF', '半休(0.5日休扱い)'],
          ['TRIP', '出張(店舗外)'],
          ['REQUEST_OFF', '希望休'],
          ['HELP_MIDDLE', 'ヘルプ(他店舗応援・中番)'],
        ].map(([k,l]) => (
          <span key={k} className={`px-2 py-1 border ${cellColor(k)}`}>{l}</span>
        ))}
      </div>

      {/* 勤務表テーブル（行=スタッフ・列=日付） */}
      <div className="overflow-x-auto scroll-shadow border-2 border-stone-900 bg-white" style={{ maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
        <table className="w-full text-xs font-sans-jp" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr className="bg-stone-900 text-stone-50">
              <th className="sticky top-0 left-0 z-30 bg-stone-900 px-2 py-1.5 text-left min-w-[64px] border-r border-stone-700">
                <div className="text-xs">スタッフ</div>
                <div className="text-[9px] text-stone-400 font-normal mt-0.5">必要数 ＋／−</div>
              </th>
              {days.map((d, i) => {
                const dow = d.getDay();
                const ds = dateStrs[i];
                const help = helpNeeded[ds];
                const required = effectiveRequiredByDate[ds] ?? 3;
                const isCustom = requiredByDate[ds] !== undefined;
                const isHol = isHoliday(d);
                const dayEvents = eventBarsForDate(ds);
                return (
                  <th key={ds} className={`sticky top-0 z-20 bg-stone-900 px-0.5 py-1.5 text-center min-w-[52px] border-r border-stone-700 ${
                    dow === 0 || isHol ? 'text-rose-300' : dow === 6 ? 'text-sky-300' : ''
                  }`}>
                    <div className="leading-tight">
                      {/* 日付・曜日(タップでイベント編集) */}
                      <button
                        type="button"
                        onClick={() => setEditingEventDate(ds)}
                        className="block w-full hover:bg-stone-800 active:bg-stone-700 rounded transition cursor-pointer"
                        title="タップしてイベントを追加・編集"
                      >
                        <div className="text-sm font-medium">{d.getDate()}</div>
                        <div className="text-[10px] opacity-70">{dayOfWeekJa[dow]}</div>
                      </button>
                      {/* 必要人数調整バー */}
                      <div className="mt-1 flex items-center justify-center gap-0.5 bg-stone-800/60 rounded-sm py-0.5 px-0.5">
                        <button
                          onClick={() => setDayRequired(ds, Math.max(0, required - 1))}
                          className="w-3.5 h-3.5 flex items-center justify-center text-stone-300 hover:text-white hover:bg-stone-700 rounded-sm transition text-[10px] leading-none"
                          aria-label="必要人数を減らす"
                        >−</button>
                        <span className={`text-[10px] font-bold min-w-[10px] ${isCustom ? 'text-amber-300' : 'text-stone-100'}`}>
                          {required}
                        </span>
                        <button
                          onClick={() => setDayRequired(ds, Math.min(10, required + 1))}
                          className="w-3.5 h-3.5 flex items-center justify-center text-stone-300 hover:text-white hover:bg-stone-700 rounded-sm transition text-[10px] leading-none"
                          aria-label="必要人数を増やす"
                        >＋</button>
                      </div>
                      {isCustom && (
                        <button
                          onClick={() => setDayRequired(ds, null)}
                          className="text-[8px] text-stone-400 hover:text-amber-300 mt-0.5"
                          aria-label="既定値に戻す"
                        >既定に戻す</button>
                      )}
                      {help && <div className="text-[9px] text-amber-300 font-bold mt-0.5">⚠{help}</div>}
                      {/* イベントバー (期間イベントは初日のみ名前表示、それ以外は色帯のみ) */}
                      {dayEvents.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {dayEvents.map(({ ev, isStart, isEnd, isSingle }) => {
                            const c = getEventColor(ev.color);
                            // 初日(isStart): 名前+期間表示、それ以外: 色帯のみで継続を示す
                            return (
                              <div
                                key={ev.id}
                                className={`text-[8px] leading-tight ${c.bg} ${c.text} px-0.5 ${isStart ? 'rounded-l' : ''} ${isEnd ? 'rounded-r' : ''}`}
                                title={ev.name}
                              >
                                {isStart ? (
                                  <span className="truncate block">
                                    {ev.name || '(無題)'}
                                    {!isSingle && (() => {
                                      const startDay = ev.dateStart.split('-')[2].replace(/^0/, '');
                                      const endDay = (ev.dateEnd || ev.dateStart).split('-')[2].replace(/^0/, '');
                                      return ` ${startDay}-${endDay}`;
                                    })()}
                                  </span>
                                ) : (
                                  // 中間日・終日は色帯のみ
                                  <span className="opacity-0">·</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </th>
                );
              })}
              {/* 休計列ヘッダー（右端固定） */}
              {generatedShifts && (
                <th className="sticky top-0 right-0 z-30 bg-stone-900 px-1 py-1.5 text-center min-w-[42px] border-l-2 border-stone-700">
                  <div className="text-[10px] font-medium leading-tight">休計</div>
                  <div className="text-[8px] text-stone-400 font-normal mt-0.5">最低〜最大</div>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {staff.map(s => (
              <tr key={s.id} className="border-b border-stone-200">
                <td className="sticky left-0 bg-white px-2 py-1 font-medium border-r-2 border-stone-900 z-10 leading-tight">
                  <div className="text-xs">{s.name}</div>
                  <div className="text-[9px] text-stone-400 whitespace-nowrap">
                    {s.type === STAFF_TYPE.MAMA ? 'ママ' : '社員'}·休{s.minOffDays}{s.maxOffDays !== undefined ? `〜${s.maxOffDays}` : ''}
                  </div>
                </td>
                {dateStrs.map((ds, i) => {
                  const dow = days[i].getDay();
                  const value = generatedShifts?.[s.id]?.[ds] || fixedShifts[s.id]?.[ds] || '';
                  const cellClass = value ? cellColor(value) : 'bg-white border-stone-100';
                  const dowBg = dow === 0 || isHoliday(days[i]) ? 'bg-rose-50/30' : dow === 6 ? 'bg-sky-50/30' : '';
                  const isEditing = editingCell?.staffId === s.id && editingCell?.dateStr === ds;
                  const canEdit = !!generatedShifts;
                  const isHighlighted = highlightedCells?.has(`${s.id}_${ds}`);
                  const isLocked = !!manualLocks?.[s.id]?.[ds];
                  const isFixed = !!fixedShifts?.[s.id]?.[ds]; // 希望休・MT

                  // ママさんは早Mのみのオプション
                  const options = s.type === STAFF_TYPE.MAMA
                    ? [
                        { v: 'MAMA', label: '早M', color: 'bg-rose-100 text-rose-900 border-rose-400' },
                        { v: 'MT', label: 'MT', color: 'bg-violet-100 text-violet-900 border-violet-400' },
                        { v: 'REQUEST_OFF', label: '希', color: 'bg-stone-200 text-stone-700 border-stone-400' },
                        { v: 'OFF', label: '休', color: 'bg-white text-stone-400 border-stone-300' },
                      ]
                    : [
                        { v: 'EARLY', label: '早', color: 'bg-amber-100 text-amber-900 border-amber-400' },
                        { v: 'MIDDLE', label: '中', color: 'bg-emerald-100 text-emerald-900 border-emerald-400' },
                        { v: 'LATE', label: '遅', color: 'bg-sky-100 text-sky-900 border-sky-400' },
                        { v: 'MT', label: 'MT', color: 'bg-violet-100 text-violet-900 border-violet-400' },
                        { v: 'REQUEST_OFF', label: '希', color: 'bg-stone-200 text-stone-700 border-stone-400' },
                        { v: 'OFF', label: '休', color: 'bg-white text-stone-400 border-stone-300' },
                      ];

                  const note = cellNotes[s.id]?.[ds];
                  return (
                    <td key={ds} className={`p-0 border-r border-stone-100 ${!value ? dowBg : ''}`}>
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => canEdit && setEditingCell(isEditing ? null : { staffId: s.id, dateStr: ds })}
                        className={`relative px-1 py-2.5 text-center text-sm font-medium border w-full min-h-[44px] ${cellClass} ${canEdit ? 'cursor-pointer hover:ring-2 hover:ring-red-700 hover:ring-offset-1 active:scale-95 transition' : ''} ${isEditing ? 'ring-2 ring-red-800 ring-offset-1' : ''} ${isHighlighted ? 'highlight-pulse' : ''} ${isLocked ? 'ring-1 ring-stone-900' : ''}`}
                      >
                        <div className="leading-tight">
                          <div>{value ? SHIFT_TYPES[value]?.short : '—'}</div>
                          {note && (
                            <div className="text-[8px] font-normal opacity-80 mt-0.5 truncate" title={note}>{note}</div>
                          )}
                        </div>
                        {isLocked && (
                          <span className="absolute top-0 right-0 text-[8px] leading-none" title="手動ロック">🔒</span>
                        )}
                      </button>
                    </td>
                  );
                })}
                {/* 休計セル（右端固定） */}
                {generatedShifts && (() => {
                  const row = summary?.find(r => r.staff.id === s.id);
                  const off = row?.offDays ?? 0;
                  // 整数なら整数、小数なら小数で表示 (例: 10 / 9.5)
                  const offDisplay = Number.isInteger(off) ? off : off.toFixed(1);
                  const min = s.minOffDays;
                  const max = s.maxOffDays;
                  const tooFew = off < min;
                  const tooMany = max !== undefined && off > max;
                  const bg = tooMany ? 'bg-rose-100' : tooFew ? 'bg-amber-100' : 'bg-emerald-50';
                  const fg = tooMany ? 'text-rose-900' : tooFew ? 'text-amber-900' : 'text-emerald-900';
                  const icon = tooMany ? '↑超' : tooFew ? '↓少' : '✓';
                  return (
                    <td className={`sticky right-0 z-10 ${bg} px-1 py-1 border-l-2 border-stone-900 text-center align-middle leading-tight`}>
                      <div className={`text-sm font-bold ${fg}`}>{offDisplay}</div>
                      <div className="text-[8px] text-stone-500 whitespace-nowrap">/{min}{max !== undefined ? `〜${max}` : ''}</div>
                      <div className={`text-[8px] font-medium ${fg}`}>{icon}</div>
                    </td>
                  );
                })()}
              </tr>
            ))}
            {/* ヘルプ枠（他店舗からの応援） */}
            {generatedShifts && (
              <tr className="bg-yellow-50/40 border-t-2 border-stone-900">
                <td className="sticky left-0 bg-yellow-50 px-2 py-1 font-medium border-r-2 border-stone-900 z-10 leading-tight">
                  <div className="text-xs text-yellow-900">ヘルプ枠</div>
                  <div className="text-[9px] text-yellow-700 whitespace-nowrap">他店応援·中</div>
                </td>
                {dateStrs.map((ds, i) => {
                  const dow = days[i].getDay();
                  const helpType = helpAssignments?.[ds];
                  const stillNeeded = helpNeeded?.[ds];
                  const dowBg = dow === 0 || isHoliday(days[i]) ? 'bg-rose-50/30' : dow === 6 ? 'bg-sky-50/30' : '';
                  return (
                    <td key={ds} className={`p-0 border-r border-stone-100 ${!helpType && !stillNeeded ? dowBg : ''}`}>
                      {helpType ? (
                        <button
                          type="button"
                          onClick={() => setEditingHelpTime(ds)}
                          title="クリックで時間入力 / 解除"
                          className="px-1 py-2.5 text-center font-bold border-2 bg-yellow-300 text-yellow-900 border-yellow-600 w-full cursor-pointer hover:ring-2 hover:ring-red-700 hover:ring-offset-1 active:scale-95 transition leading-tight min-h-[44px]"
                        >
                          <div className="text-sm">{SHIFT_TYPES[helpType]?.short || ''}</div>
                          {helpTimeNotes[ds] ? (
                            <div className="text-[9px] leading-none mt-0.5 font-medium">{helpTimeNotes[ds]}</div>
                          ) : (
                            <div className="text-[8px] leading-none mt-0.5 tracking-wider">HELP</div>
                          )}
                        </button>
                      ) : stillNeeded ? (
                        <button
                          type="button"
                          onClick={() => toggleHelpCell(ds)}
                          title="クリックでヘルプを配置"
                          className="px-1 py-2.5 text-center text-xs font-bold border-2 border-dashed bg-rose-50 text-rose-700 border-rose-400 w-full cursor-pointer hover:ring-2 hover:ring-yellow-600 hover:ring-offset-1 hover:bg-yellow-50 active:scale-95 transition leading-tight min-h-[44px]"
                        >
                          要請+{stillNeeded}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleHelpCell(ds)}
                          title="クリックでヘルプを配置"
                          className="px-1 py-2.5 text-center text-sm text-stone-300 border border-stone-100 bg-white w-full cursor-pointer hover:ring-2 hover:ring-yellow-600 hover:ring-offset-1 hover:bg-yellow-50 hover:text-yellow-700 active:scale-95 transition min-h-[44px]"
                        >
                          —
                        </button>
                      )}
                    </td>
                  );
                })}
                {/* ヘルプ枠の合計（配置日数 + 不足日数） */}
                <td className="sticky right-0 z-10 bg-yellow-50 px-1 py-1 border-l-2 border-stone-900 text-center align-middle leading-tight">
                  <div className="text-sm font-bold text-yellow-900">{Object.keys(helpAssignments || {}).length}</div>
                  <div className="text-[8px] text-yellow-700">配置</div>
                  {Object.keys(helpNeeded || {}).length > 0 && (
                    <div className="text-[8px] text-rose-700 font-medium">⚠+{Object.keys(helpNeeded).length}</div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>


      {Object.keys(helpNeeded).length > 0 && (
        <div className="mt-4 p-4 bg-amber-50 border-l-4 border-amber-600 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-700 mt-0.5" />
          <div className="text-sm font-sans-jp">
            <div className="font-medium text-amber-900">追加の応援要請が必要な日: {Object.keys(helpNeeded).length}日</div>
            <div className="text-xs text-amber-700 mt-1">他店舗からの応援(1日1名)を配置しても不足している日です · 「カレンダー」タブで詳細を確認できます</div>
          </div>
        </div>
      )}

      {/* セル編集モーダル */}
      {editingCell && (() => {
        const s = staff.find(x => x.id === editingCell.staffId);
        if (!s) return null;
        const ds = editingCell.dateStr;
        const value = generatedShifts?.[s.id]?.[ds] || '';
        const dateLabel = ds.split('-').slice(1).join('/');
        const dayLabel = dayOfWeekJa[new Date(ds).getDay()];

        const options = s.type === STAFF_TYPE.MAMA
          ? [
              { v: 'MAMA', label: '早M', desc: 'ママ早 9:30-16:30', color: 'bg-rose-100 text-rose-900 border-rose-400' },
              { v: 'MT', label: 'MT', desc: 'ミーティング(時間はマスメモで)', color: 'bg-violet-100 text-violet-900 border-violet-400' },
              { v: 'TRIP', label: '出張', desc: '出勤扱い・店舗外', color: 'bg-indigo-100 text-indigo-900 border-indigo-400' },
              { v: 'HALF_OFF', label: '半', desc: '半休(0.5日休扱い・時間はマスメモで)', color: 'bg-teal-100 text-teal-900 border-teal-400' },
              { v: 'REQUEST_OFF', label: '希', desc: '希望休', color: 'bg-stone-200 text-stone-700 border-stone-400' },
              { v: 'OFF', label: '休', desc: '休み', color: 'bg-white text-stone-500 border-stone-300' },
            ]
          : [
              { v: 'EARLY', label: '早', desc: '早番 9:30-18:30', color: 'bg-amber-100 text-amber-900 border-amber-400' },
              { v: 'MIDDLE', label: '中', desc: '中番 10:30-19:30', color: 'bg-emerald-100 text-emerald-900 border-emerald-400' },
              { v: 'LATE', label: '遅', desc: '遅番 11:30-20:30', color: 'bg-sky-100 text-sky-900 border-sky-400' },
              { v: 'MT', label: 'MT', desc: 'ミーティング(時間はマスメモで)', color: 'bg-violet-100 text-violet-900 border-violet-400' },
              { v: 'TRIP', label: '出張', desc: '出勤扱い・店舗外', color: 'bg-indigo-100 text-indigo-900 border-indigo-400' },
              { v: 'HALF_OFF', label: '半', desc: '半休(0.5日休扱い・時間はマスメモで)', color: 'bg-teal-100 text-teal-900 border-teal-400' },
              { v: 'REQUEST_OFF', label: '希', desc: '希望休', color: 'bg-stone-200 text-stone-700 border-stone-400' },
              { v: 'OFF', label: '休', desc: '休み', color: 'bg-white text-stone-500 border-stone-300' },
            ];

        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
            onClick={() => setEditingCell(null)}
          >
            <div
              className="bg-white border-2 border-stone-900 shadow-2xl max-w-sm w-full"
              onClick={e => e.stopPropagation()}
            >
              <div className="bg-stone-900 text-stone-50 px-4 py-3 flex items-center justify-between">
                <div className="font-sans-jp">
                  <span className="font-display text-lg">{s.name}</span>
                  <span className="text-xs text-stone-300 ml-2">{dateLabel} ({dayLabel})</span>
                </div>
                <button
                  onClick={() => setEditingCell(null)}
                  className="text-stone-400 hover:text-white text-xl leading-none"
                  aria-label="閉じる"
                >
                  ×
                </button>
              </div>
              <div className="p-4">
                <div className="text-[11px] text-stone-500 font-sans-jp mb-3">
                  {manualLocks?.[s.id]?.[ds] ? (
                    <span className="flex items-center gap-1 text-stone-700">
                      <span>🔒</span>
                      <span>このセルは手動編集ロック中です（再編成で上書きされません）</span>
                    </span>
                  ) : (
                    'シフトを変更してください'
                  )}
                </div>
                <div className="space-y-1.5">
                  {options.map(opt => (
                    <button
                      key={opt.v}
                      onClick={() => updateShiftCell(s.id, ds, opt.v)}
                      className={`w-full flex items-center gap-3 px-3 py-2 border-2 ${opt.color} hover:ring-2 hover:ring-stone-900 transition ${value === opt.v ? 'ring-2 ring-stone-900' : ''}`}
                    >
                      <span className="font-display text-lg w-10 text-center">{opt.label}</span>
                      <span className="text-xs font-sans-jp text-left flex-1">{opt.desc}</span>
                      {value === opt.v && <span className="text-[10px] font-sans-jp">現在</span>}
                    </button>
                  ))}
                </div>

                {/* メモ入力欄 */}
                <div className="mt-4 pt-3 border-t border-stone-200">
                  <label className="block text-[11px] text-stone-600 font-sans-jp mb-1.5 tracking-wider">メモ(時間や注釈・任意)</label>
                  <input
                    type="text"
                    value={cellNotes[s.id]?.[ds] || ''}
                    onChange={e => updateCellNote && updateCellNote(s.id, ds, e.target.value)}
                    placeholder="例: 11-16 / 早退 / 健診 など"
                    maxLength={20}
                    className="w-full px-2 py-1.5 text-sm border border-stone-300 focus:outline-none focus:border-stone-900 bg-white"
                  />
                  <div className="text-[10px] text-stone-400 font-sans-jp mt-1">
                    マス内に小さく表示されます · 半角20文字まで
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-3">
                  {manualLocks?.[s.id]?.[ds] && (
                    <button
                      onClick={() => unlockShiftCell(s.id, ds)}
                      className="py-2 text-xs text-amber-700 hover:text-amber-900 font-sans-jp border border-amber-400 hover:bg-amber-50 transition"
                    >
                      🔓 ロック解除
                    </button>
                  )}
                  <button
                    onClick={() => setEditingCell(null)}
                    className={`py-2 text-xs text-stone-500 hover:text-stone-900 font-sans-jp border border-stone-300 hover:border-stone-900 transition ${manualLocks?.[s.id]?.[ds] ? '' : 'col-span-2'}`}
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* イベント編集モーダル */}
      {editingEventDate && (() => {
        const ds = editingEventDate;
        const dayEvents = events.filter(ev => ds >= ev.dateStart && ds <= (ev.dateEnd || ev.dateStart));
        const dateLabel = (() => {
          const [y, m, d] = ds.split('-');
          return `${parseInt(m)}月${parseInt(d)}日`;
        })();
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={() => setEditingEventDate(null)}
          >
            <div
              className="bg-white border-2 border-stone-900 max-w-md w-full max-h-[90vh] overflow-auto"
              onClick={e => e.stopPropagation()}
            >
              <div className="bg-stone-900 text-stone-50 px-4 py-3 flex items-center justify-between">
                <div className="font-display text-lg">{dateLabel} のイベント</div>
                <button
                  onClick={() => setEditingEventDate(null)}
                  className="text-stone-400 hover:text-white text-2xl leading-none"
                >×</button>
              </div>
              <div className="p-4 space-y-3 font-sans-jp">
                {dayEvents.length === 0 && (
                  <div className="text-xs text-stone-500 py-2">この日にイベントはありません。</div>
                )}
                {dayEvents.map(ev => {
                  const c = getEventColor(ev.color);
                  return (
                    <div key={ev.id} className={`p-3 border-2 ${c.border} ${c.bg.replace('-200', '-50')}`}>
                      <div className="space-y-2">
                        <label className="block">
                          <span className="text-[10px] text-stone-600 tracking-wider">イベント名</span>
                          <input
                            type="text"
                            value={ev.name}
                            onChange={e => updateEvent(ev.id, { name: e.target.value })}
                            placeholder="例: 春の感謝祭"
                            className="w-full px-2 py-1.5 text-sm border border-stone-300 focus:outline-none focus:border-stone-900 mt-0.5 bg-white"
                          />
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block">
                            <span className="text-[10px] text-stone-600 tracking-wider">開始日</span>
                            <input
                              type="date"
                              value={ev.dateStart}
                              onChange={e => updateEvent(ev.id, { dateStart: e.target.value })}
                              className="w-full px-2 py-1.5 text-xs border border-stone-300 focus:outline-none focus:border-stone-900 mt-0.5 bg-white"
                            />
                          </label>
                          <label className="block">
                            <span className="text-[10px] text-stone-600 tracking-wider">終了日 (空欄なら1日のみ)</span>
                            <input
                              type="date"
                              value={ev.dateEnd || ev.dateStart}
                              onChange={e => updateEvent(ev.id, { dateEnd: e.target.value })}
                              className="w-full px-2 py-1.5 text-xs border border-stone-300 focus:outline-none focus:border-stone-900 mt-0.5 bg-white"
                            />
                          </label>
                        </div>
                        {eventWarnings[ev.id] && (
                          <div className="text-[11px] text-amber-800 bg-amber-100 border border-amber-300 px-2 py-1.5 rounded">
                            ⚠ {eventWarnings[ev.id]}
                          </div>
                        )}
                        <div>
                          <span className="text-[10px] text-stone-600 tracking-wider block mb-1">色</span>
                          <div className="flex gap-1.5 flex-wrap">
                            {EVENT_COLORS.map(col => (
                              <button
                                key={col.id}
                                onClick={() => updateEvent(ev.id, { color: col.id })}
                                className={`w-8 h-8 ${col.bg} ${col.border} border-2 ${ev.color === col.id ? 'ring-2 ring-stone-900 ring-offset-1' : ''}`}
                                aria-label={col.label}
                                title={col.label}
                              />
                            ))}
                          </div>
                        </div>
                        <div className="flex justify-end pt-1">
                          <button
                            onClick={() => removeEvent(ev.id)}
                            className="text-xs text-rose-700 hover:text-rose-900 underline"
                          >このイベントを削除</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="pt-2 border-t border-stone-200 flex gap-2 justify-between">
                  <button
                    onClick={() => addEvent(ds)}
                    className="text-sm bg-stone-900 text-stone-50 px-4 py-2 hover:bg-stone-700 transition"
                  >+ 新規イベントを追加</button>
                  <button
                    onClick={() => setEditingEventDate(null)}
                    className="text-sm border border-stone-300 px-4 py-2 hover:border-stone-700 transition"
                  >閉じる</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ヘルプ時間入力モーダル */}
      {editingHelpTime && (() => {
        const ds = editingHelpTime;
        const dateLabel = (() => {
          const [y, m, d] = ds.split('-');
          return `${parseInt(m)}月${parseInt(d)}日`;
        })();
        const currentTime = helpTimeNotes[ds] || '';
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={() => setEditingHelpTime(null)}
          >
            <div
              className="bg-white border-2 border-stone-900 max-w-sm w-full"
              onClick={e => e.stopPropagation()}
            >
              <div className="bg-stone-900 text-stone-50 px-4 py-3 flex items-center justify-between">
                <div className="font-display text-lg">{dateLabel} ヘルプ枠</div>
                <button
                  onClick={() => setEditingHelpTime(null)}
                  className="text-stone-400 hover:text-white text-2xl leading-none"
                >×</button>
              </div>
              <div className="p-4 space-y-3 font-sans-jp">
                <label className="block">
                  <span className="text-[10px] text-stone-600 tracking-wider">勤務時間メモ</span>
                  <input
                    type="text"
                    defaultValue={currentTime}
                    onBlur={e => {
                      const v = e.target.value.trim();
                      setHelpTimeNotes(prev => {
                        const next = { ...prev };
                        if (v === '') delete next[ds];
                        else next[ds] = v;
                        return next;
                      });
                    }}
                    placeholder="例: 11-16, 10:30-19:30"
                    className="w-full px-3 py-2 text-sm border border-stone-300 focus:outline-none focus:border-stone-900 mt-0.5 bg-white"
                  />
                  <span className="text-[10px] text-stone-500 mt-1 block">空欄にすると時間メモが削除されます</span>
                </label>
                <div className="flex gap-2 justify-between pt-2 border-t border-stone-200">
                  <button
                    onClick={() => {
                      // ヘルプ自体を解除(時間メモも削除)
                      toggleHelpCell(ds);
                      setHelpTimeNotes(prev => {
                        const next = { ...prev };
                        delete next[ds];
                        return next;
                      });
                      setEditingHelpTime(null);
                    }}
                    className="text-xs text-rose-700 hover:text-rose-900 underline"
                  >ヘルプを解除</button>
                  <button
                    onClick={() => setEditingHelpTime(null)}
                    className="text-sm bg-stone-900 text-stone-50 px-4 py-2 hover:bg-stone-700 transition"
                  >閉じる</button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ============== 希望休・MT 入力 ==============
function RequestsView({ staff, days, dateStrs, fixedShifts, toggleFixedShift, selectedStaffId, setSelectedStaffId }) {
  const sid = selectedStaffId || staff[0]?.id;
  const selected = staff.find(s => s.id === sid);

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl">希望休 · MT · 出張 入力</h2>
        <p className="text-xs text-stone-500 font-sans-jp mt-1">日付をタップで切替: 空 → 希望休 → MT(中) → 出張 → 空</p>
        <p className="text-[11px] text-stone-400 font-sans-jp mt-0.5">※ <strong>出張</strong>は出勤扱い(連勤・休日数に反映)ですが、店舗の必要人数にはカウントされません · MTの<strong>時間帯(早/中/遅)</strong>は勤務表でマスをタップして変更できます</p>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        {staff.map(s => (
          <button
            key={s.id}
            onClick={() => setSelectedStaffId(s.id)}
            className={`px-4 py-2 text-sm font-sans-jp border-2 transition ${
              s.id === sid
                ? 'border-stone-900 bg-stone-900 text-stone-50'
                : 'border-stone-300 bg-white hover:border-stone-600'
            }`}
          >
            {s.name}
            <span className="text-[10px] ml-2 opacity-60">{s.type === STAFF_TYPE.MAMA ? 'ママ' : '社員'}</span>
          </button>
        ))}
      </div>

      {selected && (
        <div className="grid grid-paper bg-white border-2 border-stone-900 p-6">
          <div className="grid grid-cols-7 gap-1.5">
            {['日','月','火','水','木','金','土'].map(d => (
              <div key={d} className="text-center text-xs font-sans-jp text-stone-500 py-2 border-b border-stone-300">{d}</div>
            ))}
            {(() => {
              const startDow = days[0].getDay();
              const blanks = Array(startDow).fill(null);
              return [...blanks, ...days].map((d, i) => {
                if (!d) return <div key={`b${i}`} />;
                const ds = fmt(d);
                const fx = fixedShifts[selected.id]?.[ds];
                const dow = d.getDay();
                const isHol = isHoliday(d);
                let bgClass = 'bg-white border-stone-200 hover:border-stone-500';
                let label = '';
                if (fx === 'REQUEST_OFF') { bgClass = 'bg-stone-700 text-stone-50 border-stone-700'; label = '希望休'; }
                else if (isMTShift(fx)) {
                  bgClass = 'bg-violet-700 text-violet-50 border-violet-700';
                  label = 'MT';
                }
                else if (fx === 'TRIP') { bgClass = 'bg-indigo-700 text-indigo-50 border-indigo-700'; label = '出張'; }

                // タップで サイクル切替: 空 → 希望休 → MT → 出張 → 空
                const onClick = () => {
                  if (!fx) {
                    toggleFixedShift(selected.id, ds, 'REQUEST_OFF');
                  } else if (fx === 'REQUEST_OFF') {
                    toggleFixedShift(selected.id, ds, 'REQUEST_OFF'); // 解除
                    toggleFixedShift(selected.id, ds, 'MT');           // MTセット
                  } else if (isMTShift(fx)) {
                    toggleFixedShift(selected.id, ds, fx); // 解除(旧形式でも引数fxで解除可)
                    toggleFixedShift(selected.id, ds, 'TRIP'); // 出張セット
                  } else if (fx === 'TRIP') {
                    toggleFixedShift(selected.id, ds, 'TRIP'); // 解除して空に
                  }
                };

                return (
                  <button
                    key={ds}
                    onClick={onClick}
                    className={`aspect-square border-2 transition flex flex-col items-center justify-center p-1 ${bgClass}`}
                  >
                    <div className={`text-xs font-medium ${dow === 0 || isHol ? 'text-rose-600' : dow === 6 ? 'text-sky-600' : ''} ${fx ? 'text-current' : ''}`}>
                      {d.getDate()}
                    </div>
                    {label && <div className="text-[9px] mt-0.5">{label}</div>}
                    {!label && isHol && <div className="text-[8px] text-rose-500">祝</div>}
                  </button>
                );
              });
            })()}
          </div>
          <div className="mt-6 flex gap-6 text-xs font-sans-jp">
            <span className="flex items-center gap-2"><span className="w-3 h-3 bg-stone-700"/>希望休</span>
            <span className="flex items-center gap-2"><span className="w-3 h-3 bg-violet-700"/>MT必出</span>
            <span className="flex items-center gap-2"><span className="w-3 h-3 bg-indigo-700"/>出張</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ============== カレンダー（ヘルプ要請表示） ==============
function CalendarView({ days, dateStrs, helpNeeded, helpAssignments, requiredByDate, effectiveRequiredByDate = {}, generatedShifts, staff }) {
  const startDow = days[0].getDay();
  const blanks = Array(startDow).fill(null);

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl">日次カレンダー</h2>
        <p className="text-xs text-stone-500 font-sans-jp mt-1">
          黄色枠 = 他店舗ヘルプを配置 · 赤枠 = ヘルプ配置後も追加応援が必要
        </p>
      </div>

      <div className="bg-white border-2 border-stone-900 p-6">
        <div className="grid grid-cols-7 gap-2">
          {['日','月','火','水','木','金','土'].map((d, i) => (
            <div key={d} className={`text-center text-sm font-sans-jp py-2 border-b-2 border-stone-900 font-medium ${
              i === 0 ? 'text-rose-700' : i === 6 ? 'text-sky-700' : ''
            }`}>{d}</div>
          ))}
          {[...blanks, ...days].map((d, i) => {
            if (!d) return <div key={`b${i}`} />;
            const ds = fmt(d);
            const help = helpNeeded[ds];
            const helpType = helpAssignments?.[ds];
            const required = effectiveRequiredByDate[ds] ?? 3;
            const dow = d.getDay();
            const isHol = isHoliday(d);

            // 店舗出勤者(ヘルプ枠は別表示・出張は店舗外なので分離)
            const workers = generatedShifts ? staff.filter(s => {
              const v = generatedShifts[s.id]?.[ds];
              return v && v !== 'OFF' && v !== 'REQUEST_OFF' && v !== 'TRIP';
            }) : [];
            const tripWorkers = generatedShifts ? staff.filter(s => {
              return generatedShifts[s.id]?.[ds] === 'TRIP';
            }) : [];
            const totalCount = workers.length + (helpType ? 1 : 0);

            // 枠線色: 不足→赤、ヘルプ配置済→黄、通常→グレー
            const borderClass = help
              ? 'border-rose-600 border-2 bg-rose-50'
              : helpType
              ? 'border-yellow-600 border-2 bg-yellow-50/50'
              : 'border-stone-200 bg-stone-50/30';

            return (
              <div key={ds} className={`min-h-[120px] p-2 border ${borderClass}`}>
                <div className="flex justify-between items-start">
                  <div className={`font-display text-lg ${dow === 0 || isHol ? 'text-rose-700' : dow === 6 ? 'text-sky-700' : ''}`}>
                    {d.getDate()}
                  </div>
                  <div className="text-[10px] text-stone-500 font-sans-jp">
                    {totalCount}/{required}
                  </div>
                </div>
                {isHol && <div className="text-[9px] text-rose-600 font-sans-jp">祝日</div>}
                {help && (
                  <div className="mt-1 flex items-center gap-1 text-rose-700 text-[10px] font-sans-jp font-medium">
                    <AlertTriangle size={11} /> 追加応援 {help}名
                  </div>
                )}
                <div className="mt-1 space-y-0.5">
                  {workers.slice(0, 3).map(w => {
                    const v = generatedShifts[w.id]?.[ds];
                    return (
                      <div key={w.id} className="text-[9px] font-sans-jp truncate text-stone-700">
                        {SHIFT_TYPES[v]?.short} {w.name}
                      </div>
                    );
                  })}
                  {workers.length > 3 && <div className="text-[9px] text-stone-400">他 {workers.length - 3}</div>}
                  {tripWorkers.map(w => (
                    <div key={w.id} className="text-[9px] font-sans-jp truncate text-indigo-700 italic">
                      出張 {w.name}
                    </div>
                  ))}
                  {helpType && (
                    <div className="text-[9px] font-sans-jp truncate text-yellow-800 font-bold border-t border-yellow-300 pt-0.5 mt-0.5">
                      {SHIFT_TYPES[helpType]?.short} ヘルプ
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {Object.keys(helpNeeded).length === 0 && generatedShifts && (
        <div className="mt-6 p-4 bg-emerald-50 border-l-4 border-emerald-600 flex items-center gap-3 text-sm font-sans-jp">
          <Check size={18} className="text-emerald-700" />
          <span className="text-emerald-900">全ての日が必要人数を満たしています</span>
        </div>
      )}
    </div>
  );
}

// ============== スタッフ管理 ==============
function StaffManagement({ staff, addStaff, updateStaff, removeStaff, onResetAll, monthlyOverrides = {}, setMonthlyStaffOverride, resetMonthlyStaffOverride, periodMonth, defaultRequiredConfig, setDefaultRequiredConfig }) {
  return (
    <div>
      <div className="flex justify-between items-end mb-6 gap-3 flex-wrap">
        <div>
          <h2 className="font-display text-2xl">スタッフ管理</h2>
          <p className="text-xs text-stone-500 font-sans-jp mt-1">スタッフ情報・連勤ルール・最低/最大休日数は翌月以降も引き継がれます</p>
          <p className="text-[11px] text-stone-400 font-sans-jp mt-0.5">※ 希望休・MT・シフト編成結果は月ごとにリセットされます · 入力データは自動保存されます</p>
        </div>
        <button onClick={addStaff} className="flex items-center gap-2 bg-stone-900 text-stone-50 px-4 py-2 hover:bg-red-900 transition text-sm font-sans-jp flex-shrink-0">
          <Plus size={15} /> 追加
        </button>
      </div>

      {/* カード表示（モバイル・タブレット） */}
      <div className="lg:hidden space-y-3">
        {staff.map(s => {
          const invalid = s.maxOffDays !== undefined && s.maxOffDays < s.minOffDays;
          return (
            <div key={s.id} className="bg-white border-2 border-stone-900 p-4">
              <div className="flex justify-between items-start mb-3 gap-2">
                <div className="flex-1">
                  <label className="block text-[10px] text-stone-500 font-sans-jp mb-1 tracking-wider">名前</label>
                  <input
                    type="text"
                    value={s.name}
                    onChange={e => updateStaff(s.id, { name: e.target.value })}
                    className="w-full px-3 py-2 border border-stone-300 focus:outline-none focus:border-red-800 bg-stone-50 text-base"
                  />
                </div>
                <button
                  onClick={() => removeStaff(s.id)}
                  className="p-2 text-stone-400 hover:text-rose-700 hover:bg-rose-50 mt-5 flex-shrink-0"
                  aria-label="削除"
                >
                  <Trash2 size={18} />
                </button>
              </div>

              <div className="mb-3">
                <label className="block text-[10px] text-stone-500 font-sans-jp mb-1 tracking-wider">種別</label>
                <select
                  value={s.type}
                  onChange={e => updateStaff(s.id, { type: e.target.value })}
                  className="w-full px-3 py-2 border border-stone-300 focus:outline-none focus:border-red-800 bg-stone-50 text-sm"
                >
                  <option value={STAFF_TYPE.EMPLOYEE}>社員</option>
                  <option value={STAFF_TYPE.MAMA}>ママさん</option>
                </select>
                <div className="text-[10px] text-stone-500 mt-1 font-sans-jp">
                  {s.type === STAFF_TYPE.MAMA ? 'ママさん早番のみ (9:30-16:30)' : '早 / 中 / 遅 すべて可'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-stone-500 font-sans-jp mb-1 tracking-wider">最低休日数</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={s.minOffDays}
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, '');
                        const n = raw === '' ? 0 : Math.max(0, Math.min(31, parseInt(raw, 10)));
                        updateStaff(s.id, { minOffDays: n });
                      }}
                      onFocus={(e) => e.target.select()}
                      className="w-full px-3 py-2 border border-stone-300 focus:outline-none focus:border-red-800 bg-stone-50 text-sm"
                    />
                    <span className="text-xs text-stone-500">日</span>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-stone-500 font-sans-jp mb-1 tracking-wider">最大休日数</label>
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={s.maxOffDays ?? ''}
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, '');
                        if (raw === '') {
                          updateStaff(s.id, { maxOffDays: undefined });
                        } else {
                          const n = Math.max(0, Math.min(31, parseInt(raw, 10)));
                          updateStaff(s.id, { maxOffDays: n });
                        }
                      }}
                      onFocus={(e) => e.target.select()}
                      className={`w-full px-3 py-2 border focus:outline-none bg-stone-50 text-sm ${
                        invalid ? 'border-rose-500 focus:border-rose-700' : 'border-stone-300 focus:border-red-800'
                      }`}
                    />
                    <span className="text-xs text-stone-500">日</span>
                  </div>
                </div>
              </div>
              {invalid && (
                <div className="text-[10px] text-rose-600 mt-2 font-sans-jp">⚠ 最大休日数は最低休日数より大きい値を設定してください</div>
              )}
            </div>
          );
        })}
      </div>

      {/* テーブル表示（PC） */}
      <div className="hidden lg:block bg-white border-2 border-stone-900 overflow-x-auto">
        <table className="w-full text-sm font-sans-jp">
          <thead className="bg-stone-900 text-stone-50">
            <tr>
              <th className="px-4 py-3 text-left">名前</th>
              <th className="px-4 py-3 text-left">種別</th>
              <th className="px-4 py-3 text-left">最低休日数<span className="text-[10px] text-stone-400 font-normal ml-1">期間内</span></th>
              <th className="px-4 py-3 text-left">最大休日数<span className="text-[10px] text-stone-400 font-normal ml-1">期間内</span></th>
              <th className="px-4 py-3 text-left">対応シフト</th>
              <th className="px-4 py-3 w-12"></th>
            </tr>
          </thead>
          <tbody>
            {staff.map(s => {
              const invalid = s.maxOffDays !== undefined && s.maxOffDays < s.minOffDays;
              return (
                <tr key={s.id} className="border-b border-stone-200">
                  <td className="px-4 py-3 min-w-[160px]">
                    <input
                      type="text"
                      value={s.name}
                      onChange={e => updateStaff(s.id, { name: e.target.value })}
                      className="w-full px-2 py-1 border border-stone-200 focus:outline-none focus:border-red-800 bg-stone-50"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={s.type}
                      onChange={e => updateStaff(s.id, { type: e.target.value })}
                      className="px-2 py-1 border border-stone-200 focus:outline-none focus:border-red-800 bg-stone-50"
                    >
                      <option value={STAFF_TYPE.EMPLOYEE}>社員</option>
                      <option value={STAFF_TYPE.MAMA}>ママさん</option>
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={s.minOffDays}
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, '');
                        const n = raw === '' ? 0 : Math.max(0, Math.min(31, parseInt(raw, 10)));
                        updateStaff(s.id, { minOffDays: n });
                      }}
                      onFocus={(e) => e.target.select()}
                      className="w-20 px-2 py-1 border border-stone-200 focus:outline-none focus:border-red-800 bg-stone-50"
                    />
                    <span className="text-xs text-stone-500 ml-1">日</span>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={s.maxOffDays ?? ''}
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, '');
                        if (raw === '') {
                          updateStaff(s.id, { maxOffDays: undefined });
                        } else {
                          const n = Math.max(0, Math.min(31, parseInt(raw, 10)));
                          updateStaff(s.id, { maxOffDays: n });
                        }
                      }}
                      onFocus={(e) => e.target.select()}
                      className={`w-20 px-2 py-1 border focus:outline-none bg-stone-50 ${
                        invalid ? 'border-rose-500 focus:border-rose-700' : 'border-stone-200 focus:border-red-800'
                      }`}
                    />
                    <span className="text-xs text-stone-500 ml-1">日</span>
                    {invalid && (
                      <div className="text-[10px] text-rose-600 mt-1">最低休日数より大きい値を設定してください</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-stone-600">
                    {s.type === STAFF_TYPE.MAMA ? 'ママさん早番のみ (9:30-16:30)' : '早 / 中 / 遅 すべて可'}
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => removeStaff(s.id)} className="p-1.5 text-stone-400 hover:text-rose-700 hover:bg-rose-50">
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 今月の個別調整セクション */}
      {setMonthlyStaffOverride && periodMonth && (
        <div className="mt-8 pt-6 border-t-2 border-stone-300">
          <div className="mb-4">
            <h3 className="font-display text-lg">今月の個別調整 ({periodMonth.year}年{periodMonth.month}月期)</h3>
            <p className="text-xs text-stone-500 font-sans-jp mt-1">
              基本値は据え置きで、<strong>今月だけ</strong>の最低/最大休日数を上書きできます。<br />
              入力欄を空にすると基本値に戻ります。月をまたぐと別の月の値として独立して管理されます。
            </p>
          </div>
          <div className="space-y-2">
            {staff.map(s => {
              const ov = monthlyOverrides[s.id] || {};
              const hasMin = ov.minOffDays !== undefined;
              const hasMax = ov.maxOffDays !== undefined;
              const hasAny = hasMin || hasMax;
              return (
                <div key={s.id} className={`flex items-center gap-3 p-3 border ${hasAny ? 'bg-amber-50 border-amber-300' : 'bg-stone-50 border-stone-200'} flex-wrap`}>
                  <div className="font-medium text-sm font-sans-jp min-w-[80px]">{s.name}</div>
                  <div className="text-xs text-stone-500 font-sans-jp">
                    基本: 最低{s.minOffDays}{s.maxOffDays !== undefined ? ` 〜 最大${s.maxOffDays}` : ''}日
                  </div>
                  <div className="flex items-center gap-3 ml-auto flex-wrap">
                    {/* 今月の最低 */}
                    <div className="flex items-center gap-1.5 text-xs font-sans-jp">
                      <span className="text-stone-600">今月の最低</span>
                      <div className="flex items-center border border-stone-300 bg-white">
                        <button
                          type="button"
                          onClick={() => {
                            const baseN = Number(s.minOffDays) || 0;
                            const cur = hasMin ? Number(ov.minOffDays) : baseN;
                            const next = Math.max(0, cur - 1);
                            setMonthlyStaffOverride(s.id, 'minOffDays', next);
                          }}
                          className="w-7 h-7 flex items-center justify-center text-stone-600 hover:bg-stone-100 active:bg-stone-200 text-base leading-none"
                          aria-label="最低休日数を減らす"
                        >−</button>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={hasMin ? ov.minOffDays : ''}
                          onChange={(e) => {
                            // 数字のみ許可、空欄なら上書き解除、それ以外は数値化して保存(先頭0は除去)
                            const raw = e.target.value.replace(/[^0-9]/g, '');
                            if (raw === '') {
                              setMonthlyStaffOverride(s.id, 'minOffDays', null);
                            } else {
                              const n = Math.max(0, Math.min(31, parseInt(raw, 10)));
                              setMonthlyStaffOverride(s.id, 'minOffDays', n);
                            }
                          }}
                          onFocus={(e) => e.target.select()}
                          placeholder={String(s.minOffDays)}
                          className={`w-10 h-7 px-1 text-center text-sm border-x border-stone-300 ${hasMin ? 'bg-white font-bold text-amber-900' : 'bg-white text-stone-400'}`}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const baseN = Number(s.minOffDays) || 0;
                            const cur = hasMin ? Number(ov.minOffDays) : baseN;
                            const next = Math.min(31, cur + 1);
                            setMonthlyStaffOverride(s.id, 'minOffDays', next);
                          }}
                          className="w-7 h-7 flex items-center justify-center text-stone-600 hover:bg-stone-100 active:bg-stone-200 text-base leading-none"
                          aria-label="最低休日数を増やす"
                        >＋</button>
                      </div>
                    </div>

                    {/* 今月の最大 */}
                    <div className="flex items-center gap-1.5 text-xs font-sans-jp">
                      <span className="text-stone-600">最大</span>
                      <div className="flex items-center border border-stone-300 bg-white">
                        <button
                          type="button"
                          onClick={() => {
                            const baseN = Number(s.maxOffDays);
                            const cur = hasMax ? Number(ov.maxOffDays) : (Number.isNaN(baseN) ? 0 : baseN);
                            const next = Math.max(0, cur - 1);
                            setMonthlyStaffOverride(s.id, 'maxOffDays', next);
                          }}
                          className="w-7 h-7 flex items-center justify-center text-stone-600 hover:bg-stone-100 active:bg-stone-200 text-base leading-none"
                          aria-label="最大休日数を減らす"
                        >−</button>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={hasMax ? ov.maxOffDays : ''}
                          onChange={(e) => {
                            const raw = e.target.value.replace(/[^0-9]/g, '');
                            if (raw === '') {
                              setMonthlyStaffOverride(s.id, 'maxOffDays', null);
                            } else {
                              const n = Math.max(0, Math.min(31, parseInt(raw, 10)));
                              setMonthlyStaffOverride(s.id, 'maxOffDays', n);
                            }
                          }}
                          onFocus={(e) => e.target.select()}
                          placeholder={s.maxOffDays !== undefined ? String(s.maxOffDays) : '-'}
                          className={`w-10 h-7 px-1 text-center text-sm border-x border-stone-300 ${hasMax ? 'bg-white font-bold text-amber-900' : 'bg-white text-stone-400'}`}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const baseN = Number(s.maxOffDays);
                            const cur = hasMax ? Number(ov.maxOffDays) : (Number.isNaN(baseN) ? 0 : baseN);
                            const next = Math.min(31, cur + 1);
                            setMonthlyStaffOverride(s.id, 'maxOffDays', next);
                          }}
                          className="w-7 h-7 flex items-center justify-center text-stone-600 hover:bg-stone-100 active:bg-stone-200 text-base leading-none"
                          aria-label="最大休日数を増やす"
                        >＋</button>
                      </div>
                    </div>
                    {hasAny && (
                      <button
                        onClick={() => resetMonthlyStaffOverride(s.id)}
                        className="text-[11px] text-stone-600 hover:text-stone-900 underline font-sans-jp"
                      >
                        基本に戻す
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 text-[11px] text-stone-500 font-sans-jp">
            ※ 設定変更後、勤務表で「自動編成」を押すと反映されます · 改善提案で「最低休日数を減らす」「最大休日数を増やす」を適用するとここの値が更新されます
          </div>
        </div>
      )}

      {/* 曜日ごとの必要人数デフォルト (頻度の低い設定なので末尾近くに配置) */}
      {setDefaultRequiredConfig && defaultRequiredConfig && (
        <div className="mt-8 pt-6 border-t-2 border-stone-300">
          <div className="mb-4">
            <h3 className="font-display text-lg">曜日ごとの必要人数(デフォルト)</h3>
            <p className="text-xs text-stone-500 font-sans-jp mt-1">
              各曜日と祝日の <strong>標準の必要人数</strong> を設定します。<br />
              個別の日付は、勤務表で日付ヘッダーの ＋／− ボタンから上書きできます。
            </p>
          </div>
          <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
            {[
              { key: 1, label: '月' },
              { key: 2, label: '火' },
              { key: 3, label: '水' },
              { key: 4, label: '木' },
              { key: 5, label: '金' },
              { key: 6, label: '土', accent: 'sky' },
              { key: 0, label: '日', accent: 'rose' },
              { key: 'holiday', label: '祝日', accent: 'rose' },
            ].map(({ key, label, accent }) => {
              const v = defaultRequiredConfig[key] ?? 3;
              const accentClasses = accent === 'rose'
                ? 'bg-rose-50 border-rose-200 text-rose-900'
                : accent === 'sky'
                ? 'bg-sky-50 border-sky-200 text-sky-900'
                : 'bg-stone-50 border-stone-200 text-stone-900';
              return (
                <div key={String(key)} className={`p-2 border ${accentClasses} flex flex-col items-center gap-1`}>
                  <div className="text-xs font-sans-jp font-medium">{label}</div>
                  <div className="flex items-center border border-stone-300 bg-white">
                    <button
                      type="button"
                      onClick={() => setDefaultRequiredConfig(prev => ({ ...prev, [key]: Math.max(0, (prev[key] ?? 3) - 1) }))}
                      className="w-7 h-7 flex items-center justify-center text-stone-600 hover:bg-stone-100 active:bg-stone-200 text-base leading-none"
                      aria-label={`${label}の必要人数を減らす`}
                    >−</button>
                    <input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={v}
                      onChange={e => {
                        const raw = e.target.value.replace(/[^0-9]/g, '');
                        const n = raw === '' ? 0 : Math.max(0, Math.min(20, parseInt(raw, 10)));
                        setDefaultRequiredConfig(prev => ({ ...prev, [key]: n }));
                      }}
                      onFocus={e => e.target.select()}
                      className="w-9 h-7 px-1 text-center text-sm border-x border-stone-300 bg-white font-bold"
                    />
                    <button
                      type="button"
                      onClick={() => setDefaultRequiredConfig(prev => ({ ...prev, [key]: Math.min(20, (prev[key] ?? 3) + 1) }))}
                      className="w-7 h-7 flex items-center justify-center text-stone-600 hover:bg-stone-100 active:bg-stone-200 text-base leading-none"
                      aria-label={`${label}の必要人数を増やす`}
                    >＋</button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 text-[11px] text-stone-500 font-sans-jp">
            ※ 設定変更後、勤務表で「自動編成」を押すと反映されます · 祝日は曜日設定より優先されます
          </div>
        </div>
      )}

      {/* 全データリセットボタン (危険操作なので末尾に控えめに配置) */}
      {onResetAll && (
        <div className="mt-12 pt-6 border-t border-stone-200">
          <div className="bg-stone-50 border border-stone-300 p-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex-1 min-w-[200px]">
                <div className="text-sm font-medium text-stone-900 font-sans-jp">⚠ 全データの初期化</div>
                <div className="text-xs text-stone-600 font-sans-jp mt-1 leading-relaxed">
                  すべてのスタッフ情報・シフト編成結果・希望休などの保存データを消去し、初期状態に戻します。<br />
                  別の店舗で使い始めるときや、テストデータをきれいにしたいときに使用してください。
                </div>
              </div>
              <button
                onClick={onResetAll}
                className="text-xs font-sans-jp text-rose-700 border border-rose-300 px-3 py-2 hover:bg-rose-50 flex-shrink-0"
              >
                データを初期化
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ============== 改善提案 ==============
function SuggestionsView({ suggestions, globalIssues = [], generatedShifts, staff, applyAction, undoAction, appliedActions, setActiveTab }) {
  if (!generatedShifts) {
    return (
      <div className="text-center py-20 text-stone-400 font-sans-jp">
        <Sparkles size={48} className="mx-auto mb-4 opacity-30" />
        <p>「自動編成」を実行すると改善提案が表示されます</p>
      </div>
    );
  }

  // アクションタイプ別の見た目
  const typeStyle = {
    reduce_off: { icon: '🛏', label: '休日数を減らす', color: 'border-amber-500 bg-amber-50', applicable: true },
    increase_max_off: { icon: '📈', label: '最大休日数を増やす', color: 'border-amber-500 bg-amber-50', applicable: true },
    allow_fifth_day: { icon: '🔥', label: '5連勤を許可', color: 'border-rose-500 bg-rose-50', applicable: true },
    allow_long_consec: { icon: '⚠', label: '長期連勤を許可', color: 'border-rose-600 bg-rose-50', applicable: true },
    move_request_off: { icon: '📅', label: '希望休の調整', color: 'border-stone-500 bg-stone-50', applicable: false, jumpTo: 'requests' },
    add_staff: { icon: '👥', label: '人員追加', color: 'border-violet-500 bg-violet-50', applicable: false, jumpTo: 'staff' },
  };

  const handleApply = (action) => {
    // confirm() はサンドボックス環境でブロックされる場合があるため、即適用とする
    // 適用後は「取り消す」ボタンから元に戻せるので safety net として機能する
    applyAction(action);
  };

  // 適用済みアクションかどうかを判定
  const isApplied = (action) => {
    if (!action.staffId) return false;
    return appliedActions.some(e => {
      if (e.action.staffId !== action.staffId) return false;
      if (e.action.type !== action.type) return false;
      if (e.type === 'reduce_off' || e.type === 'increase_max_off') return true; // 同スタッフの調整は適用済み
      return e.action.date === action.date;
    });
  };

  return (
    <div>
      <div className="mb-6 flex justify-between items-end">
        <div>
          <h2 className="font-display text-2xl">シフト改善提案</h2>
          <p className="text-xs text-stone-500 font-sans-jp mt-1">
            提案の「適用」ボタンで自動的にシフトに反映されます · ヘルプ枠(他店舗応援)は1日1名まで維持
          </p>
        </div>
      </div>

      {/* グローバル課題（最大休日超過 & 構造的問題） */}
      {globalIssues.length > 0 && (
        <div className="mb-6 bg-rose-50 border-2 border-rose-600 p-5">
          <div className="flex items-start gap-3 mb-3">
            <AlertTriangle size={22} className="text-rose-700 flex-shrink-0 mt-0.5" />
            <div className="font-sans-jp">
              <div className="font-display text-lg text-rose-900">構造的な課題が発見されました</div>
              <div className="text-xs text-rose-700 mt-0.5">
                現在の設定では最大休日数を超えるスタッフが発生しています。以下の対策で解消できます。
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {globalIssues.map((issue, i) => {
              if (issue.type === 'max_off_exceeded') {
                const applied = appliedActions.some(e =>
                  e.action.staffId === issue.staffId && e.action.type === 'increase_max_off'
                );
                const action = {
                  type: 'increase_max_off',
                  staffId: issue.staffId,
                  staffName: issue.staffName,
                  currentMaxOff: issue.maxOff,
                };
                return (
                  <div key={i} className="bg-white border border-rose-300 p-3 flex items-start gap-3">
                    <div className="text-xl leading-none">⚠</div>
                    <div className="font-sans-jp flex-1">
                      <div className="text-sm font-medium text-rose-900">{issue.text}</div>
                      <div className="text-[11px] text-stone-600 mt-1">
                        対策: 最大休日数を {issue.maxOff}日 → {issue.maxOff + issue.overBy}日 に増やすか、他のスタッフを追加して負荷を分散
                      </div>
                    </div>
                    {!applied ? (
                      <button
                        onClick={() => handleApply(action)}
                        className="bg-stone-900 text-stone-50 px-3 py-1.5 text-xs font-sans-jp hover:bg-red-900 transition flex-shrink-0 self-center whitespace-nowrap"
                      >
                        +1日適用
                      </button>
                    ) : (
                      <span className="text-xs text-emerald-700 font-sans-jp self-center px-2">適用済</span>
                    )}
                  </div>
                );
              } else if (issue.type === 'capacity_shortage') {
                return (
                  <div key={i} className="bg-white border border-rose-300 p-3 flex items-start gap-3">
                    <div className="text-xl leading-none">📊</div>
                    <div className="font-sans-jp flex-1">
                      <div className="text-sm font-medium text-rose-900">{issue.text}</div>
                      <div className="text-[11px] text-stone-600 mt-1">
                        対策: スタッフを追加するか、必要人数を見直してください
                      </div>
                    </div>
                    <button
                      onClick={() => setActiveTab('staff')}
                      className="bg-stone-700 text-stone-50 px-3 py-1.5 text-xs font-sans-jp hover:bg-stone-900 transition flex-shrink-0 self-center whitespace-nowrap"
                    >
                      スタッフ管理へ
                    </button>
                  </div>
                );
              } else if (issue.type === 'forced_over_max') {
                return (
                  <div key={i} className="bg-white border border-rose-300 p-3 flex items-start gap-3">
                    <div className="text-xl leading-none">🔢</div>
                    <div className="font-sans-jp flex-1">
                      <div className="text-sm font-medium text-rose-900">{issue.text}</div>
                      <div className="text-[11px] text-stone-600 mt-1">
                        対策: いずれかのスタッフの最大休日数を増やす、または必要人数を増やしてシフトに余裕を持たせてください
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })}
          </div>
        </div>
      )}

      {/* 適用履歴 */}
      {appliedActions.length > 0 && (
        <div className="mb-6 bg-emerald-50 border-l-4 border-emerald-600 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Check size={16} className="text-emerald-700" />
            <span className="font-sans-jp font-medium text-emerald-900 text-sm">適用済みの調整 ({appliedActions.length}件)</span>
          </div>
          <div className="space-y-1.5">
            {appliedActions.map(entry => (
              <div key={entry.id} className="flex items-center justify-between gap-2 text-xs font-sans-jp bg-white border border-emerald-200 px-3 py-2">
                <span className="text-stone-700">{entry.label}</span>
                <button
                  onClick={() => undoAction(entry.id)}
                  className="text-stone-500 hover:text-rose-700 hover:underline"
                >
                  取り消す
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {suggestions.length === 0 ? (
        globalIssues.length === 0 && (
          <div className="bg-emerald-50 border-l-4 border-emerald-600 p-6 flex items-center gap-4">
            <Check size={24} className="text-emerald-700" />
            <div className="font-sans-jp">
              <div className="text-emerald-900 font-medium">すべての日が必要人数を満たしています</div>
              <div className="text-xs text-emerald-700 mt-1">改善が必要な日はありません</div>
            </div>
          </div>
        )
      ) : (
        <>
          {/* 日別の詳細提案 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="seal" style={{ background: '#374151' }}>不足日</div>
              <h3 className="font-display text-lg">{suggestions.length}日 の不足を解消する提案</h3>
            </div>
            <div className="space-y-3">
              {suggestions.map((sg, i) => (
                <div key={i} className="bg-white border-2 border-stone-900">
                  <div className="flex items-center justify-between bg-stone-900 text-stone-50 px-4 py-2">
                    <div className="flex items-center gap-3 font-sans-jp">
                      <span className="font-display text-xl">{sg.dateLabel}</span>
                      <span className="text-xs px-2 py-0.5 bg-amber-500 text-white">不足 {sg.shortage}名</span>
                    </div>
                    <div className="text-[10px] text-stone-400 font-sans-jp">下の選択肢から1つ選んで「適用」してください</div>
                  </div>
                  <div className="p-4 space-y-2">
                    {sg.actions.map((a, j) => {
                      const ts = typeStyle[a.type] || typeStyle.add_staff;
                      const applied = isApplied(a);
                      return (
                        <div key={j} className={`border-l-4 p-3 ${ts.color} flex items-start gap-3 ${applied ? 'opacity-50' : ''}`}>
                          <div className="text-xl leading-none">{ts.icon}</div>
                          <div className="font-sans-jp flex-1">
                            <div className="text-[10px] text-stone-500 tracking-wider uppercase">{ts.label}</div>
                            <div className="text-sm text-stone-900 mt-0.5">{a.text}</div>
                          </div>
                          {ts.applicable && !applied && (
                            <button
                              onClick={() => handleApply(a)}
                              className="bg-stone-900 text-stone-50 px-3 py-1.5 text-xs font-sans-jp hover:bg-red-900 transition flex-shrink-0 self-center"
                            >
                              適用
                            </button>
                          )}
                          {ts.applicable && applied && (
                            <span className="text-xs text-emerald-700 font-sans-jp self-center px-2">適用済</span>
                          )}
                          {!ts.applicable && ts.jumpTo && (
                            <button
                              onClick={() => setActiveTab(ts.jumpTo)}
                              className="bg-stone-700 text-stone-50 px-3 py-1.5 text-xs font-sans-jp hover:bg-stone-900 transition flex-shrink-0 self-center"
                            >
                              {ts.jumpTo === 'requests' ? '希望休へ' : 'スタッフ管理へ'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="mt-8 p-4 bg-stone-100 border border-stone-300 text-xs text-stone-600 font-sans-jp">
        <div className="font-medium text-stone-800 mb-1">提案の見方</div>
        <ul className="space-y-0.5 list-disc pl-5">
          <li>🛏 休日数を減らす：「適用」でそのスタッフの最低休日数を1日減らし、再編成</li>
          <li>🔥 5連勤を許可 / ⚠ 長期連勤を許可：「適用」でその日のみ連勤ルールの例外を許可</li>
          <li>📅 希望休の調整：「希望休へ」ボタンから入力タブへ移動して手動で変更</li>
          <li>👥 人員追加：「スタッフ管理へ」ボタンから新規スタッフを追加</li>
        </ul>
        <div className="mt-2 text-[11px] text-stone-500">
          ※ 適用した変更は履歴から「取り消す」で元に戻せます · 「自動編成」ボタンを再実行すると全ての例外がリセットされます
        </div>
      </div>
    </div>
  );
}

// ============== 集計 ==============
function SummaryView({ summary, generatedShifts, helpAssignments }) {
  if (!generatedShifts || !summary) {
    return (
      <div className="text-center py-20 text-stone-400 font-sans-jp">
        <BarChart3 size={48} className="mx-auto mb-4 opacity-30" />
        <p>「自動編成」を実行すると集計が表示されます</p>
      </div>
    );
  }

  // ヘルプ枠（他店舗応援）の集計
  const helpDates = Object.keys(helpAssignments || {}).sort();

  return (
    <div>
      <h2 className="font-display text-2xl mb-1">集計</h2>
      <p className="text-xs text-stone-500 font-sans-jp mb-6">当月のシフト構成と勤務状況</p>

      {/* ヘルプ枠サマリ（他店舗応援） */}
      <div className="mb-6 bg-yellow-50 border-2 border-yellow-600 p-5">
        <div className="flex items-baseline justify-between mb-1">
          <div>
            <div className="font-display text-xl text-yellow-900">ヘルプ枠（他店舗応援）</div>
            <div className="text-xs text-yellow-700 font-sans-jp">中番固定 · 1日1名まで配置 · 連続日も可</div>
          </div>
          <div className="font-display text-3xl text-yellow-900">
            {helpDates.length}<span className="text-sm text-yellow-700 ml-1">日</span>
          </div>
        </div>
        {helpDates.length === 0 && (
          <div className="text-xs text-yellow-700 font-sans-jp italic mt-2">他店舗応援は不要です</div>
        )}
      </div>

      <h3 className="font-display text-lg mb-3">スタッフ別集計</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {summary.map(({ staff, counts, workDays, offDays, maxConsec, mtTotal, tripTotal }) => {
          const minOk = offDays >= staff.minOffDays;
          const maxOk = staff.maxOffDays === undefined || offDays <= staff.maxOffDays;
          const isOk = maxConsec <= 4 && minOk && maxOk;
          // 休日数の状態
          const offStatus = !minOk ? 'under' : !maxOk ? 'over' : 'ok';
          const items = [
            ['早番', counts.EARLY, 'bg-amber-200'],
            ['ママ早', counts.MAMA, 'bg-rose-200'],
            ['中番', counts.MIDDLE, 'bg-emerald-200'],
            ['遅番', counts.LATE, 'bg-sky-200'],
            ['MT', mtTotal || 0, 'bg-violet-200'],
            ['出張', tripTotal || 0, 'bg-indigo-200'],
            ['希望休', counts.REQUEST_OFF, 'bg-stone-300'],
            ['休', counts.OFF, 'bg-stone-100 border border-stone-300'],
          ].filter(item => item[1] > 0 || ['早番','ママ早','中番','遅番','MT','希望休','休'].includes(item[0])); // 出張は0なら非表示
          const max = Math.max(...items.map(i => i[1]), 1);

          return (
            <div key={staff.id} className="bg-white border-2 border-stone-900 p-5">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="font-display text-xl">{staff.name}</div>
                  <div className="text-xs text-stone-500 font-sans-jp">
                    {staff.type === STAFF_TYPE.MAMA ? 'ママさん' : '社員'}
                  </div>
                </div>
                <div className={`text-xs font-sans-jp px-2 py-1 ${isOk ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                  {isOk ? '○ 適正' : '⚠ 要確認'}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mb-4 text-xs font-sans-jp">
                <div className="border border-stone-200 p-2">
                  <div className="text-stone-500">勤務</div>
                  <div className="font-display text-2xl">{Number.isInteger(workDays) ? workDays : workDays.toFixed(1)}<span className="text-xs text-stone-400">日</span></div>
                </div>
                <div className={`border p-2 ${offStatus === 'under' ? 'border-rose-400 bg-rose-50' : offStatus === 'over' ? 'border-amber-400 bg-amber-50' : 'border-stone-200'}`}>
                  <div className="text-stone-500">休日</div>
                  <div className={`font-display text-2xl ${offStatus === 'under' ? 'text-rose-700' : offStatus === 'over' ? 'text-amber-700' : ''}`}>
                    {Number.isInteger(offDays) ? offDays : offDays.toFixed(1)}<span className="text-xs text-stone-400">日</span>
                  </div>
                  <div className="text-[9px] text-stone-400">
                    範囲 {staff.minOffDays}〜{staff.maxOffDays ?? '−'}日
                  </div>
                  {offStatus === 'under' && <div className="text-[9px] text-rose-600 font-medium">最低を下回る</div>}
                  {offStatus === 'over' && <div className="text-[9px] text-amber-700 font-medium">最大を超過</div>}
                </div>
                <div className="border border-stone-200 p-2">
                  <div className="text-stone-500">最大連勤</div>
                  <div className={`font-display text-2xl ${maxConsec >= 4 ? 'text-amber-700' : ''}`}>
                    {maxConsec}<span className="text-xs text-stone-400">日</span>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5">
                {items.map(([label, count, color]) => (
                  <div key={label} className="flex items-center gap-2 text-xs font-sans-jp">
                    <div className="w-12 text-stone-600">{label}</div>
                    <div className="flex-1 h-4 bg-stone-50 relative">
                      <div className={`h-full ${color}`} style={{ width: `${(count/max)*100}%` }} />
                    </div>
                    <div className="w-8 text-right font-medium">{count}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
