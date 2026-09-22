import { assertISO, scheduleReview, validateCard, validateLog, SCHEDULER } from './scheduler.js';
import { initializeFlow, refreshFlow, currentTask, moduleQuestions, confirmed, practiceItem } from './flow.js';

export const SCHEMA_VERSION = 1;
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const id = (value, label = '编号') => assert(safeId(value), `${label}无效`);
const version = value => assert(typeof value === 'string' && value.length > 0 && value.length <= 200, '内容版本无效');
const integer = (value, label, max = Number.MAX_SAFE_INTEGER) => assert(Number.isInteger(value) && value >= 0 && value <= max, `${label}无效`);
const nullableDate = (value, label) => { if (value !== null) assertISO(value, label); };

export function findModule(catalog, moduleId) { return (catalog.modules || []).find(item => item.id === moduleId); }
export function getQuestion(catalog, questionId) {
  return (catalog.reviews || []).find(item => item.id === questionId)
    || (catalog.exercises || []).find(item => item.id === questionId)
    || (catalog.practice || []).find(item => item.id === questionId);
}
const isReview = (catalog, questionId) => (catalog.reviews || []).some(item => item.id === questionId);
const firstModule = catalog => (catalog.modules || []).find(item => item.kind !== 'check' && item.status === 'usable');

function validAnchor(anchor, module) {
  assert(typeof anchor === 'string' && anchor.length <= 300 && !/[\u0000-\u001f]/.test(anchor), '学习环节无效');
  if (module && anchor && module.anchors?.length) assert(module.anchors.some(item => item.id === anchor), '学习环节不属于该模块');
}
function point(point, catalog, allowUnknown = false) {
  if (point === null) return;
  assert(object(point), '继续位置无效'); id(point.moduleId); validAnchor(point.anchor);
  const module = findModule(catalog, point.moduleId);
  assert(allowUnknown || module, '未知模块');
  assert(module || !getQuestion(catalog, point.moduleId), '继续位置必须指向模块');
  if (module && !allowUnknown) validAnchor(point.anchor, module);
}
function contentIndex(catalog, retained = {}) {
  return Object.fromEntries(['modules', 'exercises', 'practice', 'reviews'].map(type => [type,
    { ...(retained[type] || {}), ...Object.fromEntries((catalog[type] || []).map(item => [item.id, item.version])) }]));
}
function availableReview(state, item, catalog) {
  const dependencies = [...(item.moduleIds || []), ...(Array.isArray(item.enableAfter) ? item.enableAfter : item.enableAfter ? [item.enableAfter] : [])];
  return item.status === 'usable' && dependencies.length > 0 && dependencies.every(moduleId =>
    state.modules[moduleId]?.completedAt && findModule(catalog, moduleId)?.status === 'usable');
}
function enableEligible(state, catalog, nowISO) {
  for (const item of catalog.reviews || []) {
    if (availableReview(state, item, catalog) && !state.enabledReviews[item.id]) {
      state.enabledReviews[item.id] = { enabledAt: nowISO, version: item.version };
    }
  }
}
function reviewApplicable(state, catalog, reviewId) {
  const item = (catalog.reviews || []).find(candidate => candidate.id === reviewId);
  return item && availableReview(state, item, catalog) && state.enabledReviews[reviewId]?.version === item.version
    && (!state.cards[reviewId] || state.cards[reviewId].version === item.version);
}

export function createInitialState(catalog, nowISO = new Date().toISOString()) {
  assertISO(nowISO);
  const first = firstModule(catalog);
  const state = {
    schemaVersion: SCHEMA_VERSION, revision: 0, createdAt: nowISO, updatedAt: nowISO, contentVersions: contentIndex(catalog),
    newCourse: first ? { moduleId: first.id, anchor: '' } : null,
    modules: {}, attempts: [], enabledReviews: {}, cards: {}, reviewSession: null,
    settings: { reviewEvery: 3, reviewLimit: 3 }, counter: { completedSincePrompt: 0 }, flags: {},
  };
  initializeFlow(state, catalog);
  if(state.flow)state.flow.legacyPosition=null; // A fresh install has no legacy learning position.
  return state;
}

export function getReviewQueue(state, catalog, nowISO = new Date().toISOString()) {
  assertISO(nowISO);
  const due = [], fresh = [];
  for (const item of catalog.reviews || []) {
    if (!reviewApplicable(state, catalog, item.id)) continue;
    const saved = state.cards[item.id];
    if (!saved) fresh.push(item.id);
    else if (saved.card.due <= nowISO) due.push(item.id);
  }
  due.sort((a, b) => state.cards[a].card.due.localeCompare(state.cards[b].card.due));
  return { due, new: fresh, ids: [...due, ...fresh].slice(0, state.settings.reviewLimit) };
}

export function reduceState(previous, action, catalog, nowISO = new Date().toISOString()) {
  assertISO(nowISO); assert(object(action) && typeof action.type === 'string', '操作无效');
  assert(nowISO >= previous.updatedAt, '当前时间早于最近记录，请检查电脑时间');
  const state = clone(previous);
  initializeFlow(state, catalog);
  const moduleFor = moduleId => {
    id(moduleId); const module = findModule(catalog, moduleId);
    assert(module && module.status !== 'unwritten', '该模块尚不可读取'); return module;
  };
  const moduleRecord = moduleId => state.modules[moduleId] ||= { startedAt: nowISO, completedAt: null, lastViewedAt: nowISO, anchor: '' };
  const completeModule = module => {
    const record = moduleRecord(module.id); record.lastViewedAt = nowISO;
    if (!record.completedAt) {
      record.completedAt = nowISO;
      if (module.kind !== 'check') state.counter.completedSincePrompt += 1;
    }
    if (module.kind !== 'check') enableEligible(state, catalog, nowISO);
  };
  switch (action.type) {
    case 'syncContent': {
      const versions = contentIndex(catalog, state.contentVersions);
      enableEligible(state, catalog, nowISO);
      if (same(versions, previous.contentVersions) && same(state.enabledReviews, previous.enabledReviews) && same(state.flow, previous.flow)) return previous;
      state.contentVersions = versions;
      break;
    }
    case 'start': {
      moduleFor(action.moduleId); moduleRecord(action.moduleId).lastViewedAt = nowISO; break;
    }
    case 'position': {
      const module = moduleFor(action.moduleId); validAnchor(action.anchor, module);
      if (state.newCourse?.moduleId !== action.moduleId) return previous; // Stale scroll/debounce from an earlier page.
      state.newCourse.anchor = action.anchor;
      if (state.flow?.current?.moduleId === action.moduleId) state.flow.current.anchor = action.anchor;
      const record = moduleRecord(action.moduleId); record.anchor = action.anchor; record.lastViewedAt = nowISO; break;
    }
    case 'setNewCourse': {
      const module = moduleFor(action.moduleId); assert(module.status === 'usable', '待核验内容不能设为新课');
      if (state.flow) assert(currentTask(state,catalog)?.moduleId === action.moduleId, '请先完成当前主线任务；后续课件不能绕过本节安排');
      validAnchor(action.anchor ?? '', module); state.newCourse = { moduleId: action.moduleId, anchor: action.anchor ?? '' };
      if(state.flow)state.flow.current.anchor=action.anchor??'';
      break;
    }
    case 'complete': {
      const module = moduleFor(action.moduleId); assert(module.status === 'usable', '待核验模块不能标为完成');
      if (state.flow) {
        assert(state.modules[module.id]?.completedAt || currentTask(state,catalog)?.moduleId === module.id, '请先处理当前主线任务');
        assert(state.modules[module.id]?.completedAt || moduleQuestions(catalog,module.id).every(qid=>confirmed(state,qid)), '请先逐题确认本轮已练习；不要求答对或订正');
        completeModule(module);
        break;
      }
      const record = moduleRecord(action.moduleId); record.lastViewedAt = nowISO;
      if (!record.completedAt) {
        record.completedAt = nowISO;
        if (module.kind !== 'check') state.counter.completedSincePrompt += 1;
      }
      if (module.kind !== 'check') enableEligible(state, catalog, nowISO);
      // Completing something in history never moves the current new-course pointer.
      if (state.newCourse?.moduleId === action.moduleId) {
        const index = catalog.modules.findIndex(item => item.id === module.id);
        const next = own(action, 'nextModuleId') ? (action.nextModuleId === null ? null : moduleFor(action.nextModuleId))
          : catalog.modules.slice(index + 1).find(item => item.kind !== 'check' && item.status === 'usable');
        if (next) { assert(next.status === 'usable', '下一课不可用'); state.newCourse = { moduleId: next.id, anchor: '' }; }
        else state.newCourse = null;
      }
      break;
    }
    case 'confirmPractice': {
      assert(state.flow, '当前目录缺少主线安排');
      id(action.questionId); id(action.submissionId);
      const question=practiceItem(catalog,action.questionId);
      assert(question?.status === 'usable', '题目待核验或缺失，请使用暂缓处理');
      assert(!isReview(catalog,action.questionId), '复习评分与练习完成必须分开');
      if (confirmed(state,action.questionId)) return previous;
      assert(!Object.values(state.flow.confirmations).some(entry=>entry.submissionId===action.submissionId), '提交编号已用于另一道题');
      assert(['guided','direct','stage'].includes(action.mode), '练习入口无效');
      for (const field of ['answerViewed','helpViewed']) assert(action[field]===undefined||typeof action[field]==='boolean', '查看记录无效');
      const task=currentTask(state,catalog),m=findModule(catalog,question.moduleId);
      state.flow.confirmations[action.questionId]={at:nowISO,version:question.version,submissionId:action.submissionId,mode:action.mode,answerViewed:action.answerViewed??false,helpViewed:action.helpViewed??false};
      if(task?.kind==='exercise' && task.questionId===question.id)state.counter.completedSincePrompt+=1;
      if(task?.kind==='module' && task.moduleId===question.moduleId && m?.status==='usable') {
        if(moduleQuestions(catalog,m.id).every(qid=>confirmed(state,qid)))completeModule(m);
        else state.flow.current.anchor='q-'+moduleQuestions(catalog,m.id).find(qid=>!confirmed(state,qid));
      }
      break;
    }
    case 'deferTask': {
      const task=currentTask(state,catalog);
      assert(task?.kind==='blocked' && task.id===action.taskId, '只有当前待核或缺失内容可以暂缓');
      state.flow.deferred[task.id]={at:nowISO,version:task.version,reason:'content-unavailable',sectionId:task.sectionId};
      break;
    }
    case 'closeSection': {
      const task=currentTask(state,catalog);
      if(state.flow?.sections[action.sectionId]?.planVersion===catalog.learningPath?.version)return previous;
      assert(task?.kind==='closing' && task.sectionId===action.sectionId, '本节仍有未确认的必做任务');
      state.flow.sections[action.sectionId]={closedAt:nowISO,planVersion:catalog.learningPath.version};
      break;
    }
    case 'score': {
      id(action.submissionId, '提交编号'); id(action.questionId, '题目编号');
      assert(['guided', 'direct', 'review', 'stage'].includes(action.mode), '练习模式无效');
      assert(['again', 'good'].includes(action.rating), '评分无效');
      for (const field of ['helpViewed', 'answerViewed']) assert(action[field] === undefined || typeof action[field] === 'boolean', '查看帮助记录无效');
      const existing = state.attempts.find(item => item.id === action.submissionId);
      if (existing) {
        assert(existing.questionId === action.questionId && existing.mode === action.mode && existing.rating === action.rating, '提交编号已用于另一条作答');
        return previous;
      }
      const question = getQuestion(catalog, action.questionId); assert(question && question.status === 'usable', '该题不可评分');
      const matchingModule = findModule(catalog, action.questionId);
      if (matchingModule) assert(matchingModule.kind === 'check' && action.mode === 'stage' &&
        (catalog.practice || []).some(item => item.id === action.questionId), '只有阶段任务可以使用相同课件编号评分');
      const review = isReview(catalog, action.questionId); assert(review === (action.mode === 'review'), '题目与练习模式不匹配');
      const attempt = {
        id: action.submissionId, questionId: action.questionId, mode: action.mode, rating: action.rating,
        at: nowISO, version: question.version, helpViewed: action.helpViewed ?? false, answerViewed: action.answerViewed ?? false,
      };
      if (review) {
        assert(reviewApplicable(state, catalog, question.id), '该复习项未启用或内容版本已改变');
        assert(state.reviewSession && state.reviewSession.ids[state.reviewSession.index] === question.id, '请在当前复习包中评分');
        attempt.undo = { card: state.cards[question.id] ? clone(state.cards[question.id]) : null, sessionId: state.reviewSession.id, sessionIndex: state.reviewSession.index };
        const result = scheduleReview(state.cards[question.id]?.card, action.rating, nowISO);
        attempt.fsrsLog = result.log;
        state.cards[question.id] = { version: question.version, schedulerVersion: SCHEDULER.version, card: result.card, lastLog: result.log };
        state.reviewSession.index += 1;
      }
      state.attempts.push(attempt); break;
    }
    case 'undo': {
      const attempt = [...state.attempts].reverse().find(item => !item.undoneAt); assert(attempt, '没有可撤销的评分');
      if (attempt.mode === 'review') {
        assert(attempt.undo, '该日志缺少可撤销状态');
        if (attempt.undo.card === null) delete state.cards[attempt.questionId];
        else state.cards[attempt.questionId] = clone(attempt.undo.card);
        if (state.reviewSession?.id === attempt.undo.sessionId) {
          state.reviewSession.index = attempt.undo.sessionIndex;
          for(const [index,note] of Object.entries(state.reviewSession.skipped||{}))if(Number(index)>=attempt.undo.sessionIndex){
            const record=(state.reviewNotes||[]).find(n=>same(n,note));if(record)record.cancelledAt=nowISO;
            delete state.reviewSession.skipped[index];
          }
        }
      }
      attempt.undoneAt = nowISO; break;
    }
    case 'beginReview': {
      id(action.sessionId, '复习包编号');
      if (state.reviewSession) {
        assert(state.reviewSession.id === action.sessionId, '已有未结束的复习包'); return previous;
      }
      assert(!state.attempts.some(entry => entry.undo?.sessionId === action.sessionId), '复习包编号已使用，请重新开始本组');
      const queue = getReviewQueue(state, catalog, nowISO);
      const ids = action.ids ?? queue.ids;
      assert(Array.isArray(ids) && ids.length > 0 && ids.length <= state.settings.reviewLimit && new Set(ids).size === ids.length, '复习包题目无效');
      for (const reviewId of ids) { id(reviewId); assert([...queue.due, ...queue.new].includes(reviewId), '复习题尚未到期或不可用'); }
      state.reviewSession = { id: action.sessionId, ids: [...ids], index: 0, returnPoint: clone(state.newCourse), startedAt: nowISO,
        ...(state.flow?{returnTask:clone(currentTask(state,catalog))}:{}) };
      state.counter.completedSincePrompt = 0; break;
    }
    case 'skipReview': {
      const s=state.reviewSession;
      assert(s && s.index<s.ids.length, '没有当前复习项');
      assert(action.questionId===s.ids[s.index] && ['later','summary'].includes(action.reason), '复习暂缓信息无效');
      const note={sessionId:s.id,index:s.index,questionId:action.questionId,reason:action.reason,at:nowISO};
      (state.reviewNotes ||= []).push(note);
      (s.skipped ||= {})[s.index]=note;
      s.index+=1;
      break;
    }
    case 'finishReview': {
      assert(state.reviewSession && state.reviewSession.index === state.reviewSession.ids.length, '本组还有未作答的复习项');
      state.reviewSession = null; state.counter.completedSincePrompt = 0; break;
    }
    case 'deferReview': {
      state.reviewSession = null; state.counter.completedSincePrompt = 0; break;
    }
    case 'settings': {
      assert(action.reviewEvery !== undefined || action.reviewLimit !== undefined, '未提供设置');
      for (const field of ['reviewEvery', 'reviewLimit']) if (action[field] !== undefined) {
        integer(action[field], field, field === 'reviewLimit' ? 10 : 20); assert(action[field] >= 1, '设置必须大于零'); state.settings[field] = action[field];
      }
      break;
    }
    case 'flag': {
      id(action.questionId); assert(getQuestion(catalog, action.questionId) || findModule(catalog, action.questionId), '未知内容编号');
      assert(action.remove === undefined || typeof action.remove === 'boolean', '标记操作无效');
      if (action.remove) delete state.flags[action.questionId];
      else { assert(action.note === undefined || (typeof action.note === 'string' && action.note.length <= 2000), '疑问备注过长'); state.flags[action.questionId] = { at: nowISO, note: action.note ?? '' }; }
      break;
    }
    default: throw new Error('未知操作');
  }
  refreshFlow(state,catalog);
  state.updatedAt = nowISO;
  state.revision += 1;
  state.contentVersions = contentIndex(catalog, state.contentVersions);
  return validateState(state, catalog);
}

function validateSavedCard(saved) {
  assert(object(saved), '保存的复习卡片无效'); version(saved.version);
  assert(saved.schedulerVersion === SCHEDULER.version, '复习卡片调度库版本不兼容');
  validateCard(saved.card); validateLog(saved.lastLog);
  assert(saved.card.last_review === saved.lastLog.review, '卡片与最近复习日志不一致');
}
function validateSession(session, catalog) {
  if (session === null) return;
  assert(object(session), '复习包无效'); id(session.id); assertISO(session.startedAt);
  assert(Array.isArray(session.ids) && session.ids.length > 0 && session.ids.length <= 10 && new Set(session.ids).size === session.ids.length, '复习包编号重复或数量无效');
  session.ids.forEach(value => id(value)); integer(session.index, '复习包位置', session.ids.length);
  point(session.returnPoint, catalog, true);
  if (session.returnTask !== undefined) validateTask(session.returnTask);
}

function validateTask(task) {
  if (task===null)return;
  assert(object(task) && ['module','exercise','blocked','closing','boundary'].includes(task.kind),'主线任务无效');
  id(task.id);id(task.sectionId);validAnchor(task.anchor??'');
  for(const field of ['moduleId','questionId','gapId'])if(task[field]!==undefined)id(task[field]);
}

export function validateState(state, catalog) {
  assert(object(state) && state.schemaVersion === SCHEMA_VERSION, '不支持的学习记录格式');
  assertISO(state.createdAt); assertISO(state.updatedAt); assert(state.updatedAt >= state.createdAt, '更新时间早于创建时间'); point(state.newCourse, catalog, true);
  integer(state.revision, '记录修订号');
  validateVersionIndex(state.contentVersions);
  const inRange = value => { assertISO(value); assert(value >= state.createdAt && value <= state.updatedAt, '记录时间不在创建与更新时间范围内'); };
  for (const field of ['modules', 'enabledReviews', 'cards', 'settings', 'counter', 'flags']) assert(object(state[field]), `${field}记录无效`);
  if(state.flow!==undefined) {
    const flow=state.flow;
    assert(object(flow)&&flow.version===1,'主线记录版本不支持');
    point(flow.legacyPosition,catalog,true);validateTask(flow.current);
    for(const field of ['confirmations','deferred','sections'])assert(object(flow[field]),'主线记录不完整');
    const submissions=new Set();
    for(const [qid,entry] of Object.entries(flow.confirmations)) {
      id(qid);assert(object(entry),'练习确认无效');inRange(entry.at);version(entry.version);id(entry.submissionId);
      assert(!submissions.has(entry.submissionId),'练习确认提交编号重复');submissions.add(entry.submissionId);
      assert(['guided','direct','stage'].includes(entry.mode)&&typeof entry.answerViewed==='boolean'&&typeof entry.helpViewed==='boolean','练习确认入口无效');
      assert(entry.rating===undefined&&entry.fsrsLog===undefined&&!isReview(catalog,qid),'练习确认不能含复习评分');
      assert(own(state.contentVersions.exercises,qid)||own(state.contentVersions.practice,qid),'练习确认缺少题目版本');
    }
    for(const [tid,entry] of Object.entries(flow.deferred)) {
      id(tid);assert(object(entry),'暂缓记录无效');inRange(entry.at);version(entry.version);id(entry.sectionId);
      assert(entry.reason==='content-unavailable','暂缓原因无效');
    }
    for(const [sid,entry] of Object.entries(flow.sections)) {id(sid);assert(object(entry),'小节收尾记录无效');inRange(entry.closedAt);version(entry.planVersion);}
  }
  assert(state.reviewNotes===undefined||Array.isArray(state.reviewNotes),'复习回看记录无效');
  const noteKeys=new Set();
  for(const note of state.reviewNotes||[]) {
    assert(object(note),'复习回看记录无效');id(note.sessionId);id(note.questionId);integer(note.index,'复习回看位置',9);inRange(note.at);
    assert(['later','summary'].includes(note.reason)&&note.rating===undefined&&note.fsrsLog===undefined,'回看不能包含评分');
    if(note.cancelledAt!==undefined){inRange(note.cancelledAt);assert(note.cancelledAt>=note.at,'回看撤销时间无效');}
    else {const key=note.sessionId+':'+note.index;assert(!noteKeys.has(key),'复习回看重复');noteKeys.add(key);}
  }
  for (const [moduleId, entry] of Object.entries(state.modules)) {
    id(moduleId); assert(object(entry), '模块记录无效'); assertISO(entry.startedAt); nullableDate(entry.completedAt); assertISO(entry.lastViewedAt); validAnchor(entry.anchor);
    assert(findModule(catalog, moduleId) || !getQuestion(catalog, moduleId), '模块记录编号指向题目');
    assert(entry.lastViewedAt >= entry.startedAt && (!entry.completedAt || entry.completedAt >= entry.startedAt), '模块记录时间次序无效');
    inRange(entry.startedAt); inRange(entry.lastViewedAt); if (entry.completedAt) inRange(entry.completedAt);
    assert(own(state.contentVersions.modules, moduleId), '模块记录缺少版本索引');
  }
  for (const [reviewId, entry] of Object.entries(state.enabledReviews)) {
    id(reviewId); assert(object(entry), '复习启用记录无效'); assertISO(entry.enabledAt); version(entry.version);
    assert(isReview(catalog, reviewId) || (!getQuestion(catalog, reviewId) && !findModule(catalog, reviewId)), '复习记录编号指向其他内容');
    inRange(entry.enabledAt); assert(own(state.contentVersions.reviews, reviewId), '复习项缺少版本索引');
    const item = (catalog.reviews || []).find(candidate => candidate.id === reviewId);
    if (item && item.version === entry.version) {
      const dependencies = [...(item.moduleIds || []), ...(Array.isArray(item.enableAfter) ? item.enableAfter : item.enableAfter ? [item.enableAfter] : [])];
      assert(dependencies.length > 0 && dependencies.every(moduleId => state.modules[moduleId]?.completedAt && state.modules[moduleId].completedAt <= entry.enabledAt), '复习项缺少实际完成的前置记录');
    }
  }
  for (const [reviewId, entry] of Object.entries(state.cards)) {
    id(reviewId); validateSavedCard(entry); assert(own(state.enabledReviews, reviewId), '卡片缺少启用记录');
    assert(entry.version === state.enabledReviews[reviewId].version, '卡片与启用版本不一致');
  }
  assert(Array.isArray(state.attempts), '作答日志无效');
  const seen = new Set(), latestReviews = new Map(), computedReviews = new Map();
  let previousAt = state.createdAt;
  for (const entry of state.attempts) {
    assert(object(entry), '作答日志条目无效'); id(entry.id); id(entry.questionId);
    assert(!seen.has(entry.id), '作答提交编号重复'); seen.add(entry.id);
    assert(['guided', 'direct', 'review', 'stage'].includes(entry.mode), '作答模式无效');
    assert(['again', 'good'].includes(entry.rating), '作答评分无效'); assertISO(entry.at); version(entry.version);
    assert(entry.at >= previousAt && entry.at <= state.updatedAt, '作答日志时间次序无效'); previousAt = entry.at;
    assert(typeof entry.helpViewed === 'boolean' && typeof entry.answerViewed === 'boolean', '帮助记录无效');
    if (entry.undoneAt !== undefined) { inRange(entry.undoneAt); assert(entry.undoneAt >= entry.at, '撤销时间早于作答时间'); }
    const category = entry.mode === 'review' ? 'reviews' : own(state.contentVersions.exercises, entry.questionId) ? 'exercises' : 'practice';
    assert(own(state.contentVersions[category], entry.questionId), '作答题目缺少版本索引');
    const matchingModule = findModule(catalog, entry.questionId);
    if (matchingModule) assert(matchingModule.kind === 'check' && entry.mode === 'stage' &&
      (catalog.practice || []).some(item => item.id === entry.questionId), '作答编号不能指向普通模块');
    if (getQuestion(catalog, entry.questionId)) assert(isReview(catalog, entry.questionId) === (entry.mode === 'review'), '作答模式与题目分类不一致');
    if (entry.mode === 'review') {
      validateLog(entry.fsrsLog); assert(entry.fsrsLog.review === entry.at, 'FSRS日志与作答时间不一致');
      assert(entry.fsrsLog.rating === (entry.rating === 'again' ? 1 : 3), 'FSRS日志与自评分数不一致');
      assert(object(entry.undo), '复习日志缺少撤销记录'); id(entry.undo.sessionId); integer(entry.undo.sessionIndex, '撤销位置', 9);
      if (entry.undo.card !== null) {
        validateSavedCard(entry.undo.card);
        assert((computedReviews.get(entry.questionId) || []).some(item => same(item, entry.undo.card)), '撤销前态没有对应的历史评分');
      }
      const expected = scheduleReview(entry.undo.card?.card, entry.rating, entry.at);
      assert(same(expected.log, entry.fsrsLog), '复习日志与实际FSRS结果不一致');
      const saved = { version: entry.version, schedulerVersion: SCHEDULER.version, card: expected.card, lastLog: expected.log };
      if (!computedReviews.has(entry.questionId)) computedReviews.set(entry.questionId, []);
      computedReviews.get(entry.questionId).push(saved);
      if (!entry.undoneAt) latestReviews.set(entry.questionId, saved);
    } else assert(entry.fsrsLog === undefined && entry.undo === undefined, '普通练习不能含FSRS状态');
  }
  for (const [reviewId, entry] of Object.entries(state.cards)) {
    const latest = latestReviews.get(reviewId);
    assert(latest && same(latest, entry), '卡片与最近评分的实际FSRS结果不一致');
  }
  for (const reviewId of latestReviews.keys()) assert(own(state.cards, reviewId), '复习日志缺少对应卡片');
  validateSession(state.reviewSession, catalog);
  if (state.reviewSession) {
    inRange(state.reviewSession.startedAt);
    for (let index = 0; index < state.reviewSession.ids.length; index += 1) {
      const reviewId = state.reviewSession.ids[index];
      assert(isReview(catalog, reviewId) || (!getQuestion(catalog, reviewId) && !findModule(catalog, reviewId)), '复习包编号指向其他内容');
      assert(own(state.enabledReviews, reviewId), '复习包包含未启用题目');
      const scored = state.attempts.some(entry => !entry.undoneAt && entry.questionId === reviewId && entry.undo?.sessionId === state.reviewSession.id && entry.undo.sessionIndex === index);
      const skipped=state.reviewSession.skipped?.[index];
      if(skipped)assert(skipped.sessionId===state.reviewSession.id&&skipped.index===index&&skipped.questionId===reviewId&&(state.reviewNotes||[]).some(note=>same(note,skipped)), '复习暂缓缺少对应记录');
      assert(!(scored&&skipped) && !!(scored||skipped) === (index < state.reviewSession.index), '复习包位置与已保存评分不一致');
    }
  }
  integer(state.settings.reviewEvery, '复习间隔', 20); integer(state.settings.reviewLimit, '复习包数量', 10);
  assert(state.settings.reviewEvery > 0 && state.settings.reviewLimit > 0, '复习设置必须大于零'); integer(state.counter.completedSincePrompt, '新课计数');
  for (const [contentId, entry] of Object.entries(state.flags)) { id(contentId); assert(object(entry), '疑问记录无效'); inRange(entry.at); assert(typeof entry.note === 'string' && entry.note.length <= 2000, '疑问备注无效'); }
  return state;
}

export function makeBackup(state, catalog, nowISO = new Date().toISOString()) {
  assertISO(nowISO); validateState(state, catalog);
  assert(nowISO >= state.updatedAt, '导出时间早于最近记录，请检查电脑时间');
  return { format: 'topology-learning-backup', schemaVersion: SCHEMA_VERSION, exportedAt: nowISO, scheduler: { ...SCHEDULER }, contentVersions: contentIndex(catalog, state.contentVersions), state: clone(state) };
}

function validateVersionIndex(index) {
  assert(object(index), '备份缺少内容版本索引');
  for (const category of ['modules', 'exercises', 'practice', 'reviews']) {
    assert(object(index[category]), '内容版本索引不完整');
    for (const [contentId, value] of Object.entries(index[category])) { id(contentId); version(value); }
  }
}

export function validateBackup(backup, catalog) {
  assert(object(backup) && backup.format === 'topology-learning-backup' && backup.schemaVersion === SCHEMA_VERSION, '不是支持的拓扑学习备份');
  assertISO(backup.exportedAt);
  assert(object(backup.scheduler) && backup.scheduler.name === SCHEDULER.name && backup.scheduler.version === SCHEDULER.version && backup.scheduler.parameters === 'default', '备份的FSRS配置不兼容');
  validateVersionIndex(backup.contentVersions);
  const state = clone(validateState(backup.state, catalog));
  assert(backup.exportedAt >= state.updatedAt, '导出时间早于学习记录');
  for (const category of ['modules', 'exercises', 'practice', 'reviews']) {
    for (const contentId of Object.keys(state.contentVersions[category])) assert(own(backup.contentVersions[category], contentId), '备份版本索引缺少已保留内容');
  }
  const known = new Set(['modules', 'exercises', 'practice', 'reviews'].flatMap(key => (catalog[key] || []).map(item => item.id)));
  const referenced = new Set([
    ...Object.keys(state.modules), ...Object.keys(state.enabledReviews), ...Object.keys(state.cards), ...Object.keys(state.flags),
    ...state.attempts.map(item => item.questionId), ...(state.newCourse ? [state.newCourse.moduleId] : []),
    ...Object.keys(state.flow?.confirmations||{}),
    ...(state.flow?.legacyPosition?[state.flow.legacyPosition.moduleId]:[]),
    ...(state.reviewSession?.ids || []), ...(state.reviewSession?.returnPoint ? [state.reviewSession.returnPoint.moduleId] : []),
  ]);
  const unknownIds = [...referenced].filter(contentId => !known.has(contentId));
  const warnings = [];
  if (unknownIds.length) warnings.push(`保留 ${unknownIds.length} 个当前目录中不存在的编号；它们不进入复习排期。`);
  const changed = (catalog.reviews || []).filter(item => (state.enabledReviews[item.id] && state.enabledReviews[item.id].version !== item.version) || (state.cards[item.id] && state.cards[item.id].version !== item.version));
  if (changed.length) warnings.push(`${changed.length} 个复习项版本已改变；旧记录保留，暂不自动排期。`);
  if (state.reviewSession?.ids.slice(state.reviewSession.index).some(reviewId => !reviewApplicable(state, catalog, reviewId))) warnings.push('未结束复习包含当前不可用内容，可返回新课；保留原进度且不计分。');
  return { state, warnings, unknownIds };
}
